// Dead Drop core: building, burying, raising and returning drops.
//
// A drop is ONE native stealth UTXO:
//   * amount  — a Pedersen commitment (Bulletproofs+ range proof): hidden
//   * owner   — addressed to a key derived from the riddle's answer (scrypt): unlinkable to anyone
//   * memo    — the secret, encrypted (XChaCha20-Poly1305) to that same key
//   * spend   — a condition tree (MAST, TIP-0006) with two leaves:
//       RAISE : AccessRule(answer key)  AND BeforeEpoch(returns)  [AND AfterEpoch(opens)] [AND witching_hour(...)]
//       RETURN: AfterEpoch(returns)     AND AccessRule(one-time refund key held only by the sender)
// Raising a drop proves knowledge of the answer by *signing* the claim transaction with the answer key. The answer
// itself never appears on-chain, so nobody watching the mempool can copy it (the classic hashlock front-run).
import {
  AuthorizedTransfer,
  BalanceProofSignature,
  OotleWallet,
  StealthInputsStatement,
  StealthTransferStatement,
  TransactionBuilder,
  WasmStealthCrypto,
  createOutput,
  decryptInputData,
  generateSealKeypair,
  parseSubstateUtxo,
  resolveMaxEpoch,
  resolveTransaction,
  stealthUtxoSubstateId,
  statementAsWire,
  fromHexStr,
  toHexStr,
  type Output,
  type Provider,
} from "@tari-project/ootle";
import { SecretKeyWallet } from "@tari-project/ootle-secret-key-wallet";
import { buildScriptPathWitness, buildStealthInputsStatementFromInputs } from "@tari-project/ootle-wasm";
import { NETWORK, TARI } from "./net";
import type { Keypair } from "./keys";

export const PUBLIC_IDENTITY_RESOURCE = "resource_0100000000000000000000000000000000000000000000000000000000000000";

// ------------------------------------------------------------------------------------------------ conditions

/** `rule!(public_key(pk))`: satisfied when `pk` signs the spending transaction. */
export function signedBy(pk: Uint8Array): object {
  return {
    Restricted: {
      Require: { Require: { NonFungibleAddress: { resource_address: PUBLIC_IDENTITY_RESOURCE, id: { U256: toHexStr(pk) } } } },
    },
  };
}

export interface WitchingHour {
  template: string; // 64-hex template address of the Crypt template
  period: number;
  offset: number;
  window: number;
}

export interface DropTerms {
  answerPublic: Uint8Array;
  refundPublic: Uint8Array;
  returnsAt: number; // epoch after which the drop can only go back to its sender
  opensAt?: number; // optional time capsule: cannot be raised before this epoch
  witching?: WitchingHour; // optional recurring window, enforced by the Crypt template's spend script
}

/** CBOR unsigned integer (major type 0), used for TemplateFunction bound args. */
export function cborUint(n: number | bigint): Uint8Array {
  let v = BigInt(n);
  if (v < 0n) throw new Error("cborUint: negative");
  if (v < 24n) return Uint8Array.of(Number(v));
  const widths: Array<[bigint, number, number]> = [
    [0x100n, 0x18, 1],
    [0x10000n, 0x19, 2],
    [0x100000000n, 0x1a, 4],
    [0x10000000000000000n, 0x1b, 8],
  ];
  for (const [limit, head, len] of widths) {
    if (v < limit) {
      const out = new Uint8Array(1 + len);
      out[0] = head;
      for (let i = len; i >= 1; i--) {
        out[i] = Number(v & 0xffn);
        v >>= 8n;
      }
      return out;
    }
  }
  throw new Error("cborUint: too large");
}

export function raiseLeaf(t: DropTerms): object[] {
  const leaf: object[] = [{ AccessRule: signedBy(t.answerPublic) }, { Builtin: { BeforeEpoch: t.returnsAt } }];
  if (t.opensAt !== undefined && t.opensAt > 0) leaf.push({ Builtin: { AfterEpoch: t.opensAt } });
  if (t.witching) {
    const w = t.witching;
    leaf.push({
      TemplateFunction: {
        template: w.template,
        function: "witching_hour",
        args: [w.period, w.offset, w.window].map((x) => toHexStr(cborUint(x))),
      },
    });
  }
  return leaf;
}

export function returnLeaf(t: DropTerms): object[] {
  return [{ Builtin: { AfterEpoch: t.returnsAt } }, { AccessRule: signedBy(t.refundPublic) }];
}

/** The two-leaf condition tree. Order matters: it fixes the Merkle root the drop commits to. */
export function dropConditions(t: DropTerms): object[][] {
  if (t.opensAt !== undefined && t.opensAt >= t.returnsAt) throw new Error("a drop must open before it returns");
  return [raiseLeaf(t), returnLeaf(t)];
}

// ------------------------------------------------------------------------------------------------ utxos

export interface OwnedUtxo {
  commitment: string; // hex
  value: bigint;
  mask: Uint8Array;
  publicNonce: Uint8Array;
  memo?: unknown;
}

export interface LiveUtxo {
  commitment: Uint8Array;
  publicNonce: Uint8Array;
  encrypted: Uint8Array;
  raw: unknown; // the indexer's substate JSON, verbatim (for the X-ray)
}

/** Fetch a stealth UTXO by commitment; null once it has been spent. */
export async function readUtxo(provider: Provider, commitmentHex: string): Promise<LiveUtxo | null> {
  const commitment = fromHexStr(commitmentHex);
  const substate = await provider.getStealthUtxo(TARI, commitment);
  if (substate === null) return null;
  const parsed = parseSubstateUtxo(substate, stealthUtxoSubstateId(TARI, commitment));
  if (parsed === null) return null;
  return {
    commitment: parsed.commitment,
    publicNonce: fromHexStr(parsed.body.public_nonce),
    encrypted: fromHexStr(parsed.body.encrypted_data),
    raw: substate,
  };
}

/** Decrypt a UTXO addressed to `keys` (throws if it isn't theirs). */
export async function openUtxo(crypto: WasmStealthCrypto, u: LiveUtxo, keys: Keypair, withMemo = false): Promise<OwnedUtxo> {
  const d = await decryptInputData(crypto, u.commitment, u.encrypted, {
    senderPublicNonce: u.publicNonce,
    viewSecret: keys.viewSecret,
    skipMemo: !withMemo,
  });
  return { commitment: toHexStr(u.commitment), value: d.value, mask: d.mask.toBytes ? d.mask.toBytes() : (d.mask as unknown as Uint8Array), publicNonce: u.publicNonce, memo: d.memo };
}

// ------------------------------------------------------------------------------------------------ sending

export interface InputToSpend {
  utxo: OwnedUtxo;
  /** KeyPath: spend with the owner's one-time key (normal wallet spend). ScriptPath: reveal a leaf of the tree. */
  path: { KeyPath: { owner: Keypair } } | { ScriptPath: { conditions: object[][]; leafIndex: number; data?: Uint8Array } };
}

export interface SendPlan {
  inputs: InputToSpend[];
  outputs: Output[];
  fee: bigint; // revealed out of the transfer and burned as the transaction fee
  feeReceiver: Uint8Array; // public key named as the revealed output's receiver
  signer: Keypair; // signs the transaction (and satisfies AccessRule leaves)
  dryRun?: boolean;
}

function walletFor(k: Keypair): OotleWallet {
  const s = SecretKeyWallet.fromKeypair(k.ownerSecret, k.ownerPublic, NETWORK, k.viewSecret);
  return new OotleWallet().registerKeyProvider(k.address, s).setDefaultSigner(k.address);
}

/** Build, prove, sign and submit one stealth transfer whose fee is paid from its own revealed output. */
export async function stealthSend(provider: Provider, plan: SendPlan) {
  const crypto = new WasmStealthCrypto(NETWORK);
  // The revealed (fee) output can only be taken by the transaction signer, so it is always addressed to them.
  const { statement: outputsStatement, outputMask } = await crypto.generateOutputsStatement(plan.outputs, {
    amount: plan.fee,
    receiver: plan.signer.ownerPublic,
  });

  const inputsJson = plan.inputs.map((i) => {
    if ("KeyPath" in i.path) return `{"commitment":"${i.utxo.commitment}","witness":"KeyPath"}`;
    const { conditions, leafIndex, data } = i.path.ScriptPath;
    const built = JSON.parse(buildScriptPathWitness(JSON.stringify(conditions), JSON.stringify(conditions[leafIndex]), data ?? new Uint8Array()));
    return `{"commitment":"${i.utxo.commitment}","witness":${JSON.stringify(built.witness)}}`;
  });
  const inputsStatementJson = buildStealthInputsStatementFromInputs(`[${inputsJson.join(",")}]`, 0n);
  const inputsStatement = new StealthInputsStatement([], 0n, inputsStatementJson);

  const { Mask } = await import("@tari-project/ootle");
  const inputMask = await crypto.aggregateInputMasks(plan.inputs.map((i) => new Mask(i.utxo.mask)));
  const proof: BalanceProofSignature = await crypto.generateBalanceProofSignature(inputMask, outputMask, inputsStatementJson, outputsStatement.statementJson);
  const statement = new StealthTransferStatement(inputsStatement, outputsStatement, proof);

  const maxEpoch = await resolveMaxEpoch(provider);
  let builder = new TransactionBuilder(NETWORK, maxEpoch).withFeeInstructionsBuilder((b) => {
    b.addInstruction({
      StealthTransfer: { resource_address_ref: { Address: TARI }, statement: statementAsWire(statement), revealed_input_bucket: null },
    } as never);
    b.saveVar("fees");
    b.addInstruction({ PayFeeFromBucket: { bucket: b.resolveWorkspaceOffsetId("fees") } } as never);
    return b;
  });
  for (const i of plan.inputs) builder = builder.addInput({ substate_id: stealthUtxoSubstateId(TARI, fromHexStr(i.utxo.commitment)), version: null });
  let unsignedTx = await resolveTransaction(provider, builder.buildUnsignedTransaction());
  if (plan.dryRun) unsignedTx = { ...unsignedTx, dry_run: true } as typeof unsignedTx;

  const wallet = walletFor(plan.signer);
  const resolvedInputs = [] as Array<{ ownerAddr: string; input: unknown; mask: unknown; publicNonce: Uint8Array }>;
  for (const i of plan.inputs) {
    if ("KeyPath" in i.path) {
      const owner = i.path.KeyPath.owner;
      if (owner.address !== plan.signer.address) {
        wallet.registerKeyProvider(owner.address, SecretKeyWallet.fromKeypair(owner.ownerSecret, owner.ownerPublic, NETWORK, owner.viewSecret));
      }
      resolvedInputs.push({ ownerAddr: owner.address, input: { commitment: fromHexStr(i.utxo.commitment) }, mask: new Mask(i.utxo.mask), publicNonce: i.utxo.publicNonce });
    }
  }
  const auth = new AuthorizedTransfer({
    wallet,
    crypto,
    spec: { unsignedTx, statement } as never,
    resolvedInputs: resolvedInputs as never,
    mustSignWithAccountKey: true,
    sealKeypair: generateSealKeypair(),
  });
  const envelope = await auth.seal();
  return { envelope, unsignedTx, statement };
}

export { createOutput };

/** The Merkle root a condition tree commits to (what the chain stores instead of the conditions). */
export function conditionRoot(conditions: object[][]): string {
  return JSON.parse(buildScriptPathWitness(JSON.stringify(conditions), JSON.stringify(conditions[0]), new Uint8Array())).condition_root;
}
