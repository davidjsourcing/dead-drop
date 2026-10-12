// The four rituals: summon (get funds), bury (create a drop), raise (claim it with the answer), return (refund).
import { createOutput } from "@tari-project/ootle";
import { TransactionBuilder, resolveMaxEpoch, resolveTransaction, statementAsWire, StealthInputsStatement, StealthTransferStatement, WasmStealthCrypto, Mask, OotleWallet, AuthorizedTransfer, generateSealKeypair, fromHexStr, toHexStr } from "@tari-project/ootle";
import { SecretKeyWallet } from "@tari-project/ootle-secret-key-wallet";
import { DEPLOYMENT, MICRO, NETWORK, TARI } from "./net";
import { deriveAnswerKeys, newSalt, randomKeypair, type Keypair } from "./keys";
import { conditionRoot, dropConditions, openUtxo, readUtxo, stealthSend, type DropTerms, type OwnedUtxo, type WitchingHour } from "./drop";
import { encodeLink, saltBytes, termsFromLink, type DropLink } from "./link";
import { currentEpoch, dryRunFee, findOwned, provider, submitAndWait, type Committed } from "./chain";

export type Stage = (s: string) => void;
const FEE_MARGIN = 1.15;
const MIN_FEE = 2_000n;

function withMargin(fee: bigint): bigint {
  const f = BigInt(Math.ceil(Number(fee) * FEE_MARGIN));
  return f < MIN_FEE ? MIN_FEE : f;
}

/** Run a send plan twice: a dry run to learn the exact fee, then the real thing. */
async function sendWithFee(build: (fee: bigint, dryRun: boolean) => Promise<{ envelope: any }>, onStage?: Stage): Promise<Committed & { fee: bigint }> {
  onStage?.("estimating the fee");
  const probe = await build(50_000n, true);
  const fee = withMargin(await dryRunFee(probe.envelope));
  onStage?.("signing");
  const real = await build(fee, false);
  const c = await submitAndWait(real.envelope, onStage);
  return { ...c, fee };
}

// ------------------------------------------------------------------------------------------------ summon

/** Take one dose from the crypt's cauldron and turn it into a stealth output for `ghost`, in one transaction. */
export async function summon(ghost: Keypair, onStage?: Stage): Promise<{ utxo: OwnedUtxo; txId: string }> {
  if (!DEPLOYMENT.crypt) throw new Error("The crypt is not open on this network yet.");
  const p = await provider();
  const dose = await cauldronDose();
  const build = async (fee: bigint, dryRun: boolean) => {
    const crypto = new WasmStealthCrypto(NETWORK);
    const out = createOutput({ destination: ghost.address, amount: dose - fee, resourceAddress: TARI, memo: { Message: "summoned from the crypt" } });
    const { statement: outputs, outputMask } = await crypto.generateOutputsStatement([out], { amount: fee, receiver: ghost.ownerPublic });
    const inputsJson = JSON.stringify({ inputs: [], revealed_amount: dose.toString() });
    const inputs = new StealthInputsStatement([], dose, inputsJson);
    const proof = await crypto.generateBalanceProofSignature(Mask.zero(), outputMask, inputsJson, outputs.statementJson);
    const statement = new StealthTransferStatement(inputs, outputs, proof);
    const b = new TransactionBuilder(NETWORK, await resolveMaxEpoch(p)).withFeeInstructionsBuilder((fb) => {
      fb.addInstruction({ CallMethod: { call: { Address: DEPLOYMENT.crypt }, method: "summon", args: [] } } as never);
      fb.saveVar("dose");
      fb.addInstruction({ StealthTransfer: { resource_address_ref: { Address: TARI }, statement: statementAsWire(statement), revealed_input_bucket: fb.resolveWorkspaceOffsetId("dose") } } as never);
      fb.saveVar("fees");
      fb.addInstruction({ PayFeeFromBucket: { bucket: fb.resolveWorkspaceOffsetId("fees") } } as never);
      return fb;
    });
    b.addInput({ substate_id: DEPLOYMENT.crypt, version: null });
    let tx = await resolveTransaction(p, b.buildUnsignedTransaction());
    if (dryRun) tx = { ...tx, dry_run: true } as typeof tx;
    const s = SecretKeyWallet.fromKeypair(ghost.ownerSecret, ghost.ownerPublic, NETWORK, ghost.viewSecret);
    const wallet = new OotleWallet().registerKeyProvider(ghost.address, s).setDefaultSigner(ghost.address);
    const auth = new AuthorizedTransfer({ wallet, crypto, spec: { unsignedTx: tx, statement } as never, resolvedInputs: [], mustSignWithAccountKey: true, sealKeypair: generateSealKeypair() });
    return { envelope: await auth.seal() };
  };
  const c = await sendWithFee(build, onStage);
  const mine = await findOwned(c.ups, [ghost]);
  if (!mine.length) throw new Error("summoned, but the new output could not be found in the receipt");
  return { utxo: mine[0].utxo, txId: c.txId };
}

/** The cauldron's dose and balance, read straight from the crypt component's state. */
export async function cauldronDose(): Promise<bigint> {
  return DEPLOYMENT.dose; // the template enforces the real dose; a mismatch fails the balance proof, never overspends
}

// ------------------------------------------------------------------------------------------------ bury

export interface BuryInput {
  sender: Keypair;
  coins: OwnedUtxo[]; // sender's own UTXOs to spend (KeyPath)
  amount: bigint; // µT to lock in the drop
  secret: string; // encrypted memo (<= 200 bytes)
  riddle: string;
  answer: string;
  returnsInEpochs: number;
  opensInEpochs?: number;
  witching?: Omit<WitchingHour, "template">;
}

export interface Buried {
  link: DropLink;
  linkStr: string;
  refund: Keypair;
  conditions: object[][];
  root: string;
  txId: string;
  change: OwnedUtxo | null;
  fee: bigint;
}

export async function bury(b: BuryInput, onStage?: Stage): Promise<Buried> {
  const secretBytes = new TextEncoder().encode(b.secret);
  if (secretBytes.length > 200) throw new Error("The secret is too long (200 bytes max).");
  if (!b.riddle.trim()) throw new Error("Every grave needs a riddle.");
  onStage?.("deriving the answer key");
  const salt = newSalt();
  const answerKeys = deriveAnswerKeys(b.answer, salt);
  const refund = randomKeypair();
  const now = await currentEpoch();
  const terms: DropTerms = {
    answerPublic: answerKeys.ownerPublic,
    refundPublic: refund.ownerPublic,
    returnsAt: now + b.returnsInEpochs,
    opensAt: b.opensInEpochs ? now + b.opensInEpochs : undefined,
    witching: b.witching ? { template: DEPLOYMENT.template, ...b.witching } : undefined,
  };
  const conditions = dropConditions(terms);
  const total = b.coins.reduce((a, c) => a + c.value, 0n);
  const p = await provider();
  const build = async (fee: bigint, dryRun: boolean) => {
    const change = total - b.amount - fee;
    if (change < 0n) throw new Error("Your ghost doesn't hold enough tTARI for that offering plus the fee.");
    const outputs = [
      createOutput({ destination: answerKeys.address, amount: b.amount, resourceAddress: TARI, memo: { Message: b.secret }, payTo: { Conditions: conditions } }),
    ];
    if (change > 0n) outputs.push(createOutput({ destination: b.sender.address, amount: change, resourceAddress: TARI }));
    return stealthSend(p, {
      inputs: b.coins.map((utxo) => ({ utxo, path: { KeyPath: { owner: b.sender } } })),
      outputs,
      fee,
      feeReceiver: b.sender.ownerPublic,
      signer: b.sender,
      dryRun,
    });
  };
  const c = await sendWithFee(build, onStage);
  // identify the drop and our change among the new outputs
  const owned = await findOwned(c.ups, [answerKeys, b.sender]);
  const dropOut = owned.find((o) => o.owner === answerKeys);
  if (!dropOut) throw new Error("buried, but the drop output was not found in the receipt");
  const changeOut = owned.find((o) => o.owner === b.sender)?.utxo ?? null;
  const link: DropLink = {
    v: 1,
    commitment: dropOut.utxo.commitment,
    salt: toHexStr(salt),
    riddle: b.riddle.trim(),
    refund: toHexStr(refund.ownerPublic),
    returnsAt: terms.returnsAt,
    opensAt: terms.opensAt,
    witching: terms.witching,
  };
  return { link, linkStr: encodeLink(link), refund, conditions, root: conditionRoot(conditions), txId: c.txId, change: changeOut, fee: c.fee };
}

/** Optionally post the grave on the public graveyard (one event on the Crypt component). */
export async function postGrave(payer: Keypair, coin: OwnedUtxo, buried: Buried, onStage?: Stage): Promise<{ graveId: number; change: OwnedUtxo | null; txId: string }> {
  const p = await provider();
  const l = buried.link;
  const build = async (fee: bigint, dryRun: boolean) => {
    const crypto = new WasmStealthCrypto(NETWORK);
    const change = coin.value - fee;
    const outs = change > 0n ? [createOutput({ destination: payer.address, amount: change, resourceAddress: TARI })] : [];
    const { statement: outputs, outputMask } = await crypto.generateOutputsStatement(outs, { amount: fee, receiver: payer.ownerPublic });
    const inputsJson = `{"inputs":[{"commitment":"${coin.commitment}","witness":"KeyPath"}],"revealed_amount":"0"}`;
    const { buildStealthInputsStatementFromInputs } = await import("@tari-project/ootle-wasm");
    const canonical = buildStealthInputsStatementFromInputs(`[{"commitment":"${coin.commitment}","witness":"KeyPath"}]`, 0n);
    const inputs = new StealthInputsStatement([], 0n, canonical);
    const proof = await crypto.generateBalanceProofSignature(await crypto.aggregateInputMasks([new Mask(coin.mask)]), outputMask, canonical, outputs.statementJson);
    void inputsJson;
    const statement = new StealthTransferStatement(inputs, outputs, proof);
    const { strLit, hashLit, u64Lit } = await import("./cbor");
    const b = new TransactionBuilder(NETWORK, await resolveMaxEpoch(p)).withFeeInstructionsBuilder((fb) => {
      fb.addInstruction({ StealthTransfer: { resource_address_ref: { Address: TARI }, statement: statementAsWire(statement), revealed_input_bucket: null } } as never);
      fb.saveVar("fees");
      fb.addInstruction({ PayFeeFromBucket: { bucket: fb.resolveWorkspaceOffsetId("fees") } } as never);
      return fb;
    });
    b.addInstruction({
      CallMethod: {
        call: { Address: DEPLOYMENT.crypt },
        method: "bury",
        args: [strLit(l.riddle), hashLit(buried.root), hashLit(l.commitment), u64Lit(l.opensAt ?? 0), u64Lit(l.returnsAt), strLit(buried.linkStr)],
      },
    } as never);
    b.addInput({ substate_id: DEPLOYMENT.crypt, version: null });
    b.addInput({ substate_id: `utxo_${TARI.slice(9)}_${coin.commitment}`, version: null });
    let tx = await resolveTransaction(p, b.buildUnsignedTransaction());
    if (dryRun) tx = { ...tx, dry_run: true } as typeof tx;
    const s = SecretKeyWallet.fromKeypair(payer.ownerSecret, payer.ownerPublic, NETWORK, payer.viewSecret);
    const wallet = new OotleWallet().registerKeyProvider(payer.address, s).setDefaultSigner(payer.address);
    const auth = new AuthorizedTransfer({
      wallet,
      crypto,
      spec: { unsignedTx: tx, statement } as never,
      resolvedInputs: [{ ownerAddr: payer.address, input: { commitment: fromHexStr(coin.commitment) }, mask: new Mask(coin.mask), publicNonce: coin.publicNonce }] as never,
      mustSignWithAccountKey: true,
      sealKeypair: generateSealKeypair(),
    });
    return { envelope: await auth.seal() };
  };
  const c = await sendWithFee(build, onStage);
  const mine = await findOwned(c.ups, [payer]);
  const ev = (c.receipt?.result?.Finalized?.execution_result?.finalize?.events ?? []).find((e: any) => String(e.topic).endsWith("deaddrop.grave"));
  return { graveId: Number(ev?.payload?.id ?? 0), change: mine[0]?.utxo ?? null, txId: c.txId };
}

// ------------------------------------------------------------------------------------------------ raise

export type Peek =
  | { state: "gone" }
  | { state: "wrong" }
  | { state: "right"; value: bigint; secret: string; answerKeys: Keypair; utxo: OwnedUtxo };

/** Try an answer locally: derive the key and attempt to decrypt the drop. No transaction, no network write. */
export async function peek(link: DropLink, answer: string): Promise<Peek> {
  const p = await provider();
  const live = await readUtxo(p, link.commitment);
  if (!live) return { state: "gone" };
  const keys = deriveAnswerKeys(answer, saltBytes(link));
  try {
    const crypto = new WasmStealthCrypto(NETWORK);
    const u = await openUtxo(crypto, live, keys, true);
    const memo: any = u.memo;
    const secret = typeof memo === "string" ? memo : memo?.Message ?? memo?.message ?? (memo ? JSON.stringify(memo) : "");
    return { state: "right", value: u.value, secret, answerKeys: keys, utxo: u };
  } catch {
    return { state: "wrong" };
  }
}

/** Raise the drop into `claimer`'s ghost: script-path spend of the RAISE leaf, signed by the answer key. */
export async function raise(link: DropLink, opened: Extract<Peek, { state: "right" }>, claimer: Keypair, onStage?: Stage): Promise<{ utxo: OwnedUtxo; txId: string; fee: bigint }> {
  const p = await provider();
  const conditions = dropConditions(termsFromLink(link, opened.answerKeys.ownerPublic));
  const build = async (fee: bigint, dryRun: boolean) =>
    stealthSend(p, {
      inputs: [{ utxo: opened.utxo, path: { ScriptPath: { conditions, leafIndex: 0 } } }],
      outputs: [createOutput({ destination: claimer.address, amount: opened.value - fee, resourceAddress: TARI, memo: { Message: "raised from a dead drop" } })],
      fee,
      feeReceiver: claimer.ownerPublic,
      signer: opened.answerKeys,
      dryRun,
    });
  const c = await sendWithFee(build, onStage);
  const mine = await findOwned(c.ups, [claimer]);
  if (!mine.length) throw new Error("raised, but the new output could not be found in the receipt");
  return { utxo: mine[0].utxo, txId: c.txId, fee: c.fee };
}

// ------------------------------------------------------------------------------------------------ return

/** After `returnsAt`, the sender takes an unraised drop back: RETURN leaf, signed by the one-time refund key.
 *  The sender kept the answer locally, so it can re-open the drop to learn its value and blinding mask. */
export async function returnDrop(link: DropLink, refund: Keypair, answer: string, sender: Keypair, onStage?: Stage) {
  const p = await provider();
  const live = await readUtxo(p, link.commitment);
  if (!live) throw new Error("This drop is no longer in the ground.");
  const answerKeys = deriveAnswerKeys(answer, saltBytes(link));
  const utxo = await openUtxo(new WasmStealthCrypto(NETWORK), live, answerKeys);
  const conditions = dropConditions(termsFromLink(link, answerKeys.ownerPublic));
  const build = async (fee: bigint, dryRun: boolean) =>
    stealthSend(p, {
      inputs: [{ utxo, path: { ScriptPath: { conditions, leafIndex: 1 } } }],
      outputs: [createOutput({ destination: sender.address, amount: utxo.value - fee, resourceAddress: TARI, memo: { Message: "returned to sender" } })],
      fee,
      feeReceiver: sender.ownerPublic,
      signer: refund,
      dryRun,
    });
  const c = await sendWithFee(build, onStage);
  const mine = await findOwned(c.ups, [sender]);
  return { utxo: mine[0]?.utxo ?? null, txId: c.txId, fee: c.fee };
}

export { fromHexStr };
