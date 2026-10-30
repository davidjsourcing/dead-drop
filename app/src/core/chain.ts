// Thin wrapper around the public Esmeralda indexer: submit, watch, scan receipts, read epochs and graves.
import { IndexerProvider } from "@tari-project/ootle-indexer";
import { WasmStealthCrypto, fromHexStr, parseSubstateUtxo, toHexStr, type Provider } from "@tari-project/ootle";
import { INDEXER_URL, NETWORK, TARI } from "./net";
import type { Keypair } from "./keys";
import type { OwnedUtxo } from "./drop";

let providerPromise: Promise<IndexerProvider> | null = null;
export function provider(): Promise<IndexerProvider> {
  providerPromise ??= IndexerProvider.connect({ url: INDEXER_URL, network: NETWORK });
  return providerPromise;
}

export async function currentEpoch(): Promise<number> {
  const r = await fetch(`${INDEXER_URL}/epoch-manager/stats`);
  return (await r.json()).current_epoch as number;
}

export interface Committed {
  txId: string;
  receipt: any;
  ups: Array<[string, any]>;
  feePaid: bigint;
}

/** Submit a sealed envelope and wait for finality; throws with the engine's reason on rejection. */
export async function submitAndWait(envelope: any, onStage?: (s: string) => void): Promise<Committed> {
  const p = await provider();
  onStage?.("submitted");
  const { transaction_id } = await p.submitTransaction(envelope);
  onStage?.("waiting for the validators");
  const pending = p.watchTransactionSSE(transaction_id);
  await pending.watch();
  let receipt: any = null;
  for (let i = 0; i < 10 && !receipt?.result?.Finalized; i++) {
    receipt = await pending.getReceipt().catch(() => null);
    if (!receipt?.result?.Finalized) await new Promise((r) => setTimeout(r, 700));
  }
  const fin = receipt?.result?.Finalized;
  const accept = fin?.final_decision === "Commit" || fin?.execution_result?.finalize?.result?.Accept ? fin.execution_result.finalize.result.Accept ?? fin.execution_result.finalize.result : null;
  const ups: Array<[string, any]> = (accept?.up_substates ?? accept?.Accept?.up_substates ?? []) as Array<[string, any]>;
  const feePaid = BigInt(fin?.execution_result?.finalize?.fee_receipt?.total_fees_paid ?? 0);
  return { txId: transaction_id, receipt, ups, feePaid };
}

/** Submit a dry run (unsigned_tx.dry_run = true) to the indexer's dry-run endpoint and return the fee it would charge. */
export async function dryRunFee(envelope: any): Promise<bigint> {
  const r = await fetch(`${INDEXER_URL}/transactions/dry-run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transaction: envelope }, (_k, v) => (typeof v === "bigint" ? v.toString() : v instanceof Uint8Array ? Array.from(v) : v)),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`dry run failed: ${text.slice(0, 600)}`);
  const j = JSON.parse(text);
  (globalThis as any).__lastDryRun = j;
  const res = j.result ?? j.dry_run_result ?? j;
  const fin = res.finalize ?? res.Finalized?.execution_result?.finalize ?? res;
  const reject = fin?.result?.Reject ?? fin?.result?.AcceptFeeRejectRest?.[1];
  if (reject) throw new Error(`the network would reject this: ${JSON.stringify(reject).slice(0, 500)}`);
  const fr = fin?.fee_receipt ?? res.fee_receipt;
  // The engine charges the sum of the cost breakdown; total_fee_payment is just what this probe revealed.
  const parts = Object.values(fr?.cost_breakdown?.breakdown ?? {}) as Array<number | string>;
  const fee = parts.reduce((a: bigint, v) => a + BigInt(v), 0n);
  if (fee === 0n) throw new Error(`dry run returned no fee: ${text.slice(0, 400)}`);
  return fee;
}

/** Find the stealth outputs in a receipt that belong to any of `keys` (tries to decrypt each). */
export async function findOwned(ups: Array<[string, any]>, keys: Keypair[]): Promise<Array<{ utxo: OwnedUtxo; owner: Keypair }>> {
  const crypto = new WasmStealthCrypto(NETWORK);
  const found: Array<{ utxo: OwnedUtxo; owner: Keypair }> = [];
  for (const [id, sub] of ups) {
    if (!id.startsWith("utxo_")) continue;
    const parsed = parseSubstateUtxo(sub as never, id as never);
    if (!parsed) continue;
    for (const k of keys) {
      try {
        const aead = await crypto.deriveAeadKey(k.viewSecret, fromHexStr(parsed.body.public_nonce));
        const d = await crypto.unblindOutput(parsed.commitment, fromHexStr(parsed.body.encrypted_data), aead, false);
        found.push({
          utxo: { commitment: toHexStr(parsed.commitment), value: d.value, mask: (d.mask as any).toBytes(), publicNonce: fromHexStr(parsed.body.public_nonce), memo: d.memo },
          owner: k,
        });
        break;
      } catch {
        /* not this key's */
      }
    }
  }
  return found;
}

export async function getUtxoRaw(commitmentHex: string): Promise<any | null> {
  const p: Provider = await provider();
  const got: any = await p.getStealthUtxo(TARI, fromHexStr(commitmentHex));
  // indexer v0.47 (Oct 2026) moved the substate under state.up; a spent output has no `up`.
  return got == null ? null : got.substate ? got : got.state?.up?.substate ? { ...got, substate: got.state.up.substate } : null;
}

/** The indexer moved the substate under `state.up` in v0.47 (Oct 2026); accept both shapes. */
export const subOf = (j: any): any => j?.substate ?? j?.state?.up?.substate;

export interface Grave {
  id: number;
  epitaph: string;
  root: string;
  commitment: string;
  opens: number;
  returns: number;
  link: string;
  epoch: number;
}

/** Public graves, newest first, read from the crypt's own state (it keeps the most recent graves; the public indexer
 *  does not index custom template events). Each grave is `[id, epoch, link]`; the link decodes to everything else. */
export async function listGraves(crypt: string): Promise<Grave[]> {
  const r = await fetch(`${INDEXER_URL}/substates/${crypt}`);
  if (!r.ok) throw new Error(`could not read the crypt (${r.status})`);
  const j = await r.json();
  const state: any[] = subOf(j)?.Component?.body?.state ?? [];
  const list: any[] = state.find((x) => Array.isArray(x) && (x.length === 0 || Array.isArray(x[0]))) ?? [];
  const { decodeLink } = await import("./link");
  const graves: Grave[] = [];
  for (const g of list) {
    try {
      const [id, epoch, link] = g as [number, number, string];
      const d = decodeLink(link);
      graves.push({ id: Number(id), epoch: Number(epoch), link, epitaph: d.riddle, commitment: d.commitment, opens: d.opensAt ?? 0, returns: d.returnsAt, root: "" });
    } catch { /* skip a malformed grave */ }
  }
  return graves.sort((a, b) => b.id - a.id);
}

/** The crypt's public counters: cauldron balance is read from its vault. */
export async function cryptStats(crypt: string): Promise<{ dose: bigint; cap: bigint; summonings: number; graves: number; fed: bigint }> {
  const j = await (await fetch(`${INDEXER_URL}/substates/${crypt}`)).json();
  const s: any[] = subOf(j)?.Component?.body?.state ?? [];
  return { dose: BigInt(s[1] ?? 0), cap: BigInt(s[2] ?? 0), summonings: Number(s[5] ?? 0), graves: Number(s[6] ?? 0), fed: BigInt(s[7] ?? 0) };
}

/** tTARI waiting in the cauldron (µT), read from the crypt's vault. */
export async function cauldronBalance(vault: string): Promise<bigint> {
  const j = await (await fetch(`${INDEXER_URL}/substates/${vault}`)).json();
  return BigInt(subOf(j)?.Vault?.resource_container?.Stealth?.revealed_amount ?? 0);
}
