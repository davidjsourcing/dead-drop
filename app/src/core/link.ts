// A drop link carries only PUBLIC parameters: enough to rebuild the condition tree and find the UTXO, never the
// answer and never a key that can spend. It travels in the URL fragment (#/d/...), which browsers never send to a
// server, so not even the static host learns which drop you opened.
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import type { DropTerms, WitchingHour } from "./drop";

export interface DropLink {
  v: 1;
  commitment: string; // hex — identifies the stealth UTXO
  salt: string; // hex — scrypt salt for the answer key
  riddle: string; // the epitaph shown on the tombstone
  refund: string; // hex — the sender's ONE-TIME refund public key (unlinkable to their wallet)
  returnsAt: number;
  opensAt?: number;
  witching?: WitchingHour;
  grave?: number; // public graveyard id, if posted
}

const b64u = {
  enc(bytes: Uint8Array): string {
    let s = "";
    bytes.forEach((b) => (s += String.fromCharCode(b)));
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  dec(str: string): Uint8Array {
    const pad = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4);
    const bin = atob(pad);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  },
};

export function encodeLink(l: DropLink): string {
  // compact positional form keeps links (and QR codes) small
  const w = l.witching ? [l.witching.template, l.witching.period, l.witching.offset, l.witching.window] : 0;
  const arr = [1, l.commitment, l.salt, l.riddle, l.refund, l.returnsAt, l.opensAt ?? 0, w, l.grave ?? 0];
  return b64u.enc(new TextEncoder().encode(JSON.stringify(arr)));
}

export function decodeLink(s: string): DropLink {
  let arr: unknown;
  try {
    arr = JSON.parse(new TextDecoder().decode(b64u.dec(s.trim())));
  } catch {
    throw new Error("This link is damaged — the grave can't be found.");
  }
  if (!Array.isArray(arr) || arr[0] !== 1 || arr.length < 9) throw new Error("Unknown drop link version.");
  const [, commitment, salt, riddle, refund, returnsAt, opensAt, w, grave] = arr as [number, string, string, string, string, number, number, unknown, number];
  const hex64 = /^[0-9a-f]{64}$/;
  if (!hex64.test(commitment) || !hex64.test(refund) || !/^[0-9a-f]{32}$/.test(salt)) throw new Error("This link is damaged.");
  const link: DropLink = { v: 1, commitment, salt, riddle: String(riddle).slice(0, 160), refund, returnsAt: Number(returnsAt) };
  if (opensAt) link.opensAt = Number(opensAt);
  if (Array.isArray(w)) link.witching = { template: String(w[0]), period: Number(w[1]), offset: Number(w[2]), window: Number(w[3]) };
  if (grave) link.grave = Number(grave);
  return link;
}

export function termsFromLink(l: DropLink, answerPublic: Uint8Array): DropTerms {
  return {
    answerPublic,
    refundPublic: hexToBytes(l.refund),
    returnsAt: l.returnsAt,
    opensAt: l.opensAt,
    witching: l.witching,
  };
}

export const saltBytes = (l: DropLink) => hexToBytes(l.salt);
export { bytesToHex };
