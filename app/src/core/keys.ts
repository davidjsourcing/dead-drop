// Keys for Dead Drop.
//
// Two kinds of keys live here:
//   * a *ghost*: the visitor's own throwaway stealth wallet, generated in the browser and kept in localStorage;
//   * an *answer key*: derived from the riddle's answer with scrypt. The drop is addressed to it, so only someone who
//     knows the answer can decrypt the amount and memo — and the claim leaf requires a signature from it, so the
//     answer itself is never published on-chain (no preimage to front-run, unlike a bare hashlock).
import { scrypt } from "@noble/hashes/scrypt.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { utf8ToBytes, bytesToHex, hexToBytes, randomBytes } from "@noble/hashes/utils.js";
import { generateOotleAddress, generateOotleSecretKey, ootlePublicKeyFromSecretKey } from "@tari-project/ootle-wasm";
import { NETWORK_BYTE } from "./net";

/** Order of the Ristretto255 group. */
const L = 2n ** 252n + 27742317777372353535851937790883648493n;

/** scrypt cost. N=2^15 takes ~0.2–0.6 s in a browser: cheap for one honest guess, costly for a dictionary sweep. */
export const KDF = { N: 2 ** 15, r: 8, p: 1 } as const;

export interface Keypair {
  ownerSecret: Uint8Array; // 32-byte little-endian scalar
  viewSecret: Uint8Array;
  ownerPublic: Uint8Array; // 32-byte compressed Ristretto point
  viewPublic: Uint8Array;
  address: string; // otl_esm_… stealth address
}

/** Reduce 64 little-endian bytes modulo the group order into a canonical 32-byte scalar. */
export function wideReduce(bytes64: Uint8Array): Uint8Array {
  if (bytes64.length !== 64) throw new Error("wideReduce expects 64 bytes");
  let n = 0n;
  for (let i = 63; i >= 0; i--) n = (n << 8n) | BigInt(bytes64[i]);
  n %= L;
  if (n === 0n) throw new Error("degenerate scalar");
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

/** Spaces, case and accents should not decide whether a ghost recognises its answer. */
export function normalizeAnswer(answer: string): string {
  return answer
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function keypairFromSecrets(ownerSecret: Uint8Array, viewSecret: Uint8Array): Keypair {
  const pk = ootlePublicKeyFromSecretKey(ownerSecret, viewSecret);
  const ownerPublic = new Uint8Array(pk.owner_key);
  const viewPublic = new Uint8Array(pk.view_key);
  const address = generateOotleAddress(ownerPublic, viewPublic, NETWORK_BYTE);
  return { ownerSecret, viewSecret, ownerPublic, viewPublic, address };
}

/** Derive the answer key for a drop. `salt` is public (it rides in the link) and unique per drop. */
export function deriveAnswerKeys(answer: string, salt: Uint8Array, cost = KDF): Keypair {
  const norm = normalizeAnswer(answer);
  if (norm.length === 0) throw new Error("the answer is empty");
  if (salt.length < 16) throw new Error("salt must be at least 16 bytes");
  const seed = scrypt(utf8ToBytes(norm), salt, { N: cost.N, r: cost.r, p: cost.p, dkLen: 64 });
  const owner = wideReduce(blake2b(seed, { dkLen: 64, personalization: utf8ToBytes("deaddrop.owner.v") }));
  const view = wideReduce(blake2b(seed, { dkLen: 64, personalization: utf8ToBytes("deaddrop.view.v1") }));
  return keypairFromSecrets(owner, view);
}

/** A fresh random keypair (a ghost, or a one-time refund key). */
export function randomKeypair(): Keypair {
  const sk = generateOotleSecretKey();
  return keypairFromSecrets(new Uint8Array(sk.owner_key), new Uint8Array(sk.view_key));
}

export function newSalt(): Uint8Array {
  return randomBytes(16);
}

export interface StoredKeys {
  owner: string;
  view: string;
}
export const exportKeys = (k: Keypair): StoredKeys => ({ owner: bytesToHex(k.ownerSecret), view: bytesToHex(k.viewSecret) });
export const importKeys = (s: StoredKeys): Keypair => keypairFromSecrets(hexToBytes(s.owner), hexToBytes(s.view));
export { bytesToHex, hexToBytes };
