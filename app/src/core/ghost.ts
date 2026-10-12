// The visitor's ghost: a throwaway stealth wallet that lives only in this browser (localStorage).
import { exportKeys, importKeys, randomKeypair, bytesToHex, hexToBytes, type Keypair, type StoredKeys } from "./keys";
import type { OwnedUtxo } from "./drop";

const K = { ghost: "dd.ghost.v1", coins: "dd.coins.v1", drops: "dd.drops.v1" };

interface StoredCoin { c: string; v: string; m: string; n: string }
export interface MyDrop {
  linkStr: string;
  refund: StoredKeys;
  answer: string;
  amount: string; // µT
  secret: string;
  riddle: string;
  returnsAt: number;
  opensAt?: number;
  createdAt: number; // ms
  txId: string;
  graveId?: number;
  status: "buried" | "raised" | "returned";
}

const store = typeof localStorage !== "undefined" ? localStorage : (new Map<string, string>() as unknown as Storage & Map<string, string>);
const get = (k: string): string | null => (store instanceof Map ? (store.get(k) ?? null) : store.getItem(k));
const set = (k: string, v: string) => (store instanceof Map ? store.set(k, v) : store.setItem(k, v));

export function ghost(): Keypair {
  const raw = get(K.ghost);
  if (raw) return importKeys(JSON.parse(raw));
  const g = randomKeypair();
  set(K.ghost, JSON.stringify(exportKeys(g)));
  return g;
}
export const hasGhost = () => get(K.ghost) !== null;
export function exportGhost(): string { return get(K.ghost) ?? ""; }
export function importGhost(json: string) { importKeys(JSON.parse(json)); set(K.ghost, json); set(K.coins, "[]"); }

export function coins(): OwnedUtxo[] {
  const arr: StoredCoin[] = JSON.parse(get(K.coins) ?? "[]");
  return arr.map((s) => ({ commitment: s.c, value: BigInt(s.v), mask: hexToBytes(s.m), publicNonce: hexToBytes(s.n) }));
}
function saveCoins(list: OwnedUtxo[]) {
  set(K.coins, JSON.stringify(list.map((u) => ({ c: u.commitment, v: u.value.toString(), m: bytesToHex(u.mask), n: bytesToHex(u.publicNonce) }))));
}
export function addCoin(u: OwnedUtxo | null | undefined) { if (!u) return; const l = coins().filter((c) => c.commitment !== u.commitment); l.push(u); saveCoins(l); }
export function removeCoins(spent: OwnedUtxo[]) { const gone = new Set(spent.map((s) => s.commitment)); saveCoins(coins().filter((c) => !gone.has(c.commitment))); }
export function balance(): bigint { return coins().reduce((a, c) => a + c.value, 0n); }

/** Pick coins (largest first) covering `need`. */
export function pickCoins(need: bigint): OwnedUtxo[] {
  const sorted = coins().sort((a, b) => (b.value > a.value ? 1 : -1));
  const out: OwnedUtxo[] = []; let sum = 0n;
  for (const c of sorted) { if (sum >= need) break; out.push(c); sum += c.value; }
  if (sum < need) throw new Error("Your ghost doesn't hold enough tTARI. Summon some from the crypt first.");
  return out;
}

export function drops(): MyDrop[] { return JSON.parse(get(K.drops) ?? "[]"); }
export function saveDrop(d: MyDrop) { const l = drops().filter((x) => x.linkStr !== d.linkStr); l.unshift(d); set(K.drops, JSON.stringify(l)); }
