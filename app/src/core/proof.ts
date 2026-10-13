// "Don't trust us — check": pure helpers that compare what the public indexer serves with what the answer reveals.
import { INDEXER_URL, TARI } from "./net";
import { EPOCH_MINUTES } from "./time";

/** The public indexer URL that serves a drop's stealth output, so anyone can read the raw substate themselves. */
export function substateUrl(commitment: string): string {
  return `${INDEXER_URL}/substates/utxo_${TARI.replace(/^resource_/, "")}_${commitment}`;
}
export const componentUrl = (component: string) => `${INDEXER_URL}/substates/${component}`;

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const utf8 = (s: string) => new TextEncoder().encode(s);
const b64 = (b: Uint8Array) => (typeof btoa === "function" ? btoa(String.fromCharCode(...b)) : Buffer.from(b).toString("base64"));
const u64le = (v: bigint) => { const o = new Uint8Array(8); for (let i = 0; i < 8; i++) { o[i] = Number(v & 0xffn); v >>= 8n; } return o; };
const byteList = (b: Uint8Array) => Array.from(b).join(",");

export interface AuditFacts {
  amount?: bigint; // µT
  secret?: string;
  answer?: string;
  /** Public keys (hex) that must not appear in the drop's public data, e.g. the sender's ghost. */
  keys?: Array<{ label: string; hex: string }>;
}
export interface AuditCheck { label: string; plain: string; found: boolean; searched: string }

/** Search the raw public JSON for every encoding of each private fact we can think of. `found` means it leaked. */
export function privacyAudit(raw: unknown, f: AuditFacts): AuditCheck[] {
  const text = (typeof raw === "string" ? raw : JSON.stringify(raw, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).toLowerCase();
  const compact = text.replace(/\s+/g, "");
  const has = (needles: string[]) => needles.some((n) => n.length >= 4 && (text.includes(n.toLowerCase()) || compact.includes(n.toLowerCase().replace(/\s+/g, ""))));
  const out: AuditCheck[] = [];
  if (f.amount !== undefined) {
    const le = u64le(f.amount);
    const needles = [`"${f.amount}"`, `:${f.amount},`, `:${f.amount}}`, hex(le), byteList(le)];
    out.push({ label: "Amount", plain: `${f.amount} µT`, found: has(needles), searched: "decimal, little-endian hex, byte array" });
  }
  if (f.secret) {
    const b = utf8(f.secret);
    out.push({ label: "Secret", plain: f.secret, found: has([f.secret, hex(b), b64(b), byteList(b)]), searched: "plain text, hex, base64, byte array" });
  }
  if (f.answer) {
    const b = utf8(f.answer);
    out.push({ label: "Answer", plain: f.answer, found: has([f.answer, hex(b), b64(b), byteList(b)].filter((n) => n.length >= 4)), searched: "plain text, hex, base64, byte array" });
  }
  for (const k of f.keys ?? []) out.push({ label: k.label, plain: k.hex.slice(0, 16) + "…", found: has([k.hex]), searched: "hex" });
  return out;
}

/** Estimated wall-clock time of a future epoch, from the measured epoch length. */
export function epochEta(target: number, epochNow: number, now = new Date(), minutes = EPOCH_MINUTES): Date {
  return new Date(now.getTime() + (target - epochNow) * minutes * 60_000);
}

/** Countdown text for a lock that opens once the epoch is strictly past `opensAt`. */
export function lockState(opensAt: number, epochNow: number, minutes = EPOCH_MINUTES): { open: boolean; epochsLeft: number; text: string } {
  const left = opensAt + 1 - epochNow;
  if (left <= 0) return { open: true, epochsLeft: 0, text: "open — the validators will accept a raise now" };
  const mins = left * minutes;
  const d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60);
  return { open: false, epochsLeft: left, text: `${left} epoch${left === 1 ? "" : "s"} to go (≈ ${d ? `${d} d ` : ""}${h} h)` };
}
