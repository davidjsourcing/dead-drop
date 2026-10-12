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

/** Submit a dry run (unsigned_tx.dry_run = true) and return the fee the engine would charge. */
export async function dryRunFee(envelope: any): Promise<bigint> {
  const p = await provider();
  const { transaction_id } = await p.submitTransaction(envelope);
  const pending = p.watchTransactionSSE(transaction_id);
  try {
    await pending.watch();
  } catch (e) {
    throw new Error(`dry run rejected: ${(e as Error).message}`);
  }
  const rc: any = await pending.getReceipt();
  const fin = rc?.result?.Finalized ?? rc?.result;
  const fr = fin?.execution_result?.finalize?.fee_receipt ?? fin?.finalize?.fee_receipt;
  return BigInt(fr?.total_fee_payment ?? fr?.total_fees_paid ?? 0);
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
  return p.getStealthUtxo(TARI, fromHexStr(commitmentHex));
}

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

/** Public graves, newest first, from the Crypt template's `deaddrop.grave` events. */
export async function listGraves(templateAddress: string): Promise<Grave[]> {
  const r = await fetch(`${INDEXER_URL}/transactions/events?template_address=${templateAddress}&limit=200`);
  const j = await r.json();
  const graves: Grave[] = [];
  for (const [, ev] of j.events ?? []) {
    if (!String(ev.topic).endsWith("deaddrop.grave")) continue;
    const p = ev.payload ?? {};
    graves.push({
      id: Number(p.id),
      epitaph: String(p.epitaph ?? ""),
      root: String(p.root ?? ""),
      commitment: String(p.commitment ?? ""),
      opens: Number(p.opens ?? 0),
      returns: Number(p.returns ?? 0),
      link: String(p.link ?? ""),
      epoch: Number(p.epoch ?? 0),
    });
  }
  return graves.sort((a, b) => b.id - a.id);
}
