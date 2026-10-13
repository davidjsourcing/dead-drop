// Unit tests for Dead Drop's pure core: keys, links, condition trees, CBOR, encryption round-trips.
import { describe, expect, it } from "vitest";
import { WasmStealthCrypto, decryptInputData, fromHexStr } from "@tari-project/ootle";
import { deriveAnswerKeys, normalizeAnswer, randomKeypair, wideReduce, newSalt, exportKeys, importKeys } from "../src/core/keys";
import { cborUint, conditionRoot, dropConditions, raiseLeaf, returnLeaf, signedBy, createOutput } from "../src/core/drop";
import { decodeLink, encodeLink, type DropLink } from "../src/core/link";
import { NETWORK, TARI } from "../src/core/net";

const FAST = { N: 2 ** 10, r: 8, p: 1 } as const; // tests use a cheap KDF; the app uses N=2^15
const salt = Uint8Array.from({ length: 16 }, (_, i) => i + 1);

describe("answers", () => {
  it("normalise case, accents, spacing and punctuation", () => {
    expect(normalizeAnswer("  A  Shadow! ")).toBe("shadow");
    expect(normalizeAnswer("Ćémetery")).toBe("cemetery");
    expect(normalizeAnswer("the-raven")).toBe("raven");
    expect(normalizeAnswer("An echo")).toBe("echo");
    expect(normalizeAnswer("theatre")).toBe("theatre"); // only a whole leading article is dropped
    expect(normalizeAnswer("a")).toBe("a");
  });
  it("derive the same key for equivalent answers and a different key for a different answer or salt", () => {
    const a = deriveAnswerKeys("A shadow", salt, FAST);
    const b = deriveAnswerKeys("SHADOW.", salt, FAST);
    const c = deriveAnswerKeys("a ghost", salt, FAST);
    const d = deriveAnswerKeys("A shadow", Uint8Array.from({ length: 16 }, () => 9), FAST);
    expect(a.address).toBe(b.address);
    expect(a.address).not.toBe(c.address);
    expect(a.address).not.toBe(d.address);
    expect(a.address.startsWith("otl_esm_")).toBe(true);
  });
  it("refuse empty answers and short salts", () => {
    expect(() => deriveAnswerKeys(" !! ", salt, FAST)).toThrow(/empty/);
    expect(() => deriveAnswerKeys("x", new Uint8Array(8), FAST)).toThrow(/salt/);
  });
  it("reduce wide scalars below the group order", () => {
    const s = wideReduce(new Uint8Array(64).fill(0xff));
    expect(s.length).toBe(32);
    expect(s[31] & 0xf0).toBe(0); // < 2^253
  });
  it("round-trip a ghost through export/import", () => {
    const g = randomKeypair();
    expect(importKeys(exportKeys(g)).address).toBe(g.address);
  });
});

describe("cbor", () => {
  it("encodes unsigned integers in the shortest form", () => {
    expect([...cborUint(0)]).toEqual([0x00]);
    expect([...cborUint(23)]).toEqual([0x17]);
    expect([...cborUint(24)]).toEqual([0x18, 24]);
    expect([...cborUint(256)]).toEqual([0x19, 1, 0]);
    expect([...cborUint(12157)]).toEqual([0x19, 0x2f, 0x7d]);
    expect([...cborUint(2 ** 32)]).toEqual([0x1b, 0, 0, 0, 1, 0, 0, 0, 0]);
    expect(() => cborUint(-1)).toThrow();
  });
});

describe("condition tree", () => {
  const ans = deriveAnswerKeys("bones", salt, FAST);
  const refund = randomKeypair();
  const base = { answerPublic: ans.ownerPublic, refundPublic: refund.ownerPublic, returnsAt: 12200 };
  it("RAISE needs the answer key's signature and closes when the drop returns", () => {
    const leaf = raiseLeaf(base);
    expect(leaf).toEqual([{ AccessRule: signedBy(ans.ownerPublic) }, { Builtin: { BeforeEpoch: 12200 } }]);
  });
  it("RETURN opens only after the deadline and only for the one-time refund key", () => {
    expect(returnLeaf(base)).toEqual([{ Builtin: { AfterEpoch: 12200 } }, { AccessRule: signedBy(refund.ownerPublic) }]);
  });
  it("adds a time-capsule floor and the witching-hour spend script when asked", () => {
    const leaf = raiseLeaf({ ...base, opensAt: 12170, witching: { template: "ab".repeat(32), period: 24, offset: 3, window: 2 } });
    expect(leaf[2]).toEqual({ Builtin: { AfterEpoch: 12170 } });
    expect(leaf[3]).toEqual({ TemplateFunction: { template: "ab".repeat(32), function: "witching_hour", args: ["1818", "03", "02"] } });
  });
  it("refuses a drop that opens after it returns", () => {
    expect(() => dropConditions({ ...base, opensAt: 12200 })).toThrow(/open before/);
  });
  it("commits to a stable root that changes with any term", () => {
    const r1 = conditionRoot(dropConditions(base));
    expect(r1).toMatch(/^[0-9a-f]{64}$/);
    expect(conditionRoot(dropConditions(base))).toBe(r1);
    expect(conditionRoot(dropConditions({ ...base, returnsAt: 12201 }))).not.toBe(r1);
  });
});

describe("links", () => {
  const link: DropLink = { v: 1, commitment: "c0".repeat(32), salt: "5a".repeat(16), riddle: "What walks at night?", refund: "be".repeat(32), returnsAt: 12300, opensAt: 12180, witching: { template: "11".repeat(32), period: 24, offset: 0, window: 2 }, grave: 7 };
  it("round-trip every public field", () => {
    expect(decodeLink(encodeLink(link))).toEqual(link);
  });
  it("never contain the answer or any secret key material", () => {
    const s = encodeLink(link);
    expect(s).not.toMatch(/[+/=]/); // URL-safe
    expect(Object.keys(decodeLink(s)).sort()).toEqual(["commitment", "grave", "opensAt", "refund", "returnsAt", "riddle", "salt", "v", "witching"]);
  });
  it("reject damaged links", () => {
    expect(() => decodeLink("not-a-link")).toThrow();
    const bad = encodeLink({ ...link, commitment: "zz" });
    expect(() => decodeLink(bad)).toThrow(/damaged/);
  });
});

describe("the sealed letter", () => {
  it("only the right answer decrypts the amount and the memo", async () => {
    const crypto = new WasmStealthCrypto(NETWORK);
    const ans = deriveAnswerKeys("the moon", salt, FAST);
    const wrong = deriveAnswerKeys("the sun", salt, FAST);
    const refund = randomKeypair();
    const conds = dropConditions({ answerPublic: ans.ownerPublic, refundPublic: refund.ownerPublic, returnsAt: 99999 });
    const out = createOutput({ destination: ans.address, amount: 3_000_000n, resourceAddress: TARI, payTo: { Conditions: conds }, memo: { Message: "under the third stone" } });
    const { statement } = await crypto.generateOutputsStatement([out], { amount: 2000n, receiver: refund.ownerPublic });
    const o = JSON.parse(statement.statementJson).outputs[0].output;
    const open = (k: typeof ans) =>
      decryptInputData(crypto, fromHexStr(o.commitment), fromHexStr(o.encrypted_data), { senderPublicNonce: fromHexStr(o.sender_public_nonce), viewSecret: k.viewSecret, skipMemo: false });
    const d = await open(ans);
    expect(d.value).toBe(3_000_000n);
    expect(JSON.stringify(d.memo)).toContain("under the third stone");
    await expect(open(wrong)).rejects.toBeTruthy();
    // what the chain stores: no plaintext amount or memo anywhere in the output
    const onChain = JSON.stringify(o);
    expect(onChain).not.toContain("third stone");
    expect(onChain).not.toContain("3000000");
  });
});

// ---- proof helpers (added Oct 13) ----
import { privacyAudit, substateUrl, lockState, epochEta } from "../src/core/proof";
describe("privacy audit", () => {
  const raw = { substate: { Utxo: { output: { output: { public_nonce: "e2bb", encrypted_data: "a21ed1548f7efa94" } } } } };
  it("finds nothing private in a stealth output", () => {
    const c = privacyAudit(raw, { amount: 1_000_000n, secret: "meet at the oak", answer: "a clock", keys: [{ label: "Sender", hex: "deadbeefcafebabe" }] });
    expect(c.map((x) => x.found)).toEqual([false, false, false, false]);
  });
  it("catches a leak in any encoding", () => {
    const secret = "meet at the oak";
    const hexed = Buffer.from(secret).toString("hex");
    expect(privacyAudit({ memo: hexed }, { secret })[0].found).toBe(true);
    expect(privacyAudit({ memo: secret.toUpperCase() }, { secret })[0].found).toBe(true);
    expect(privacyAudit({ value: 1000000 }, { amount: 1_000_000n })[0].found).toBe(true);
    expect(privacyAudit({ v: "40420f0000000000" }, { amount: 1_000_000n })[0].found).toBe(true);
  });
  it("builds the public indexer URL", () => {
    expect(substateUrl("ab".repeat(32))).toBe("https://ootle-indexer-a.tari.com/substates/utxo_" + "01".repeat(32) + "_" + "ab".repeat(32));
  });
  it("AfterEpoch is strict: a lock at N opens only at N+1", () => {
    expect(lockState(100, 100).open).toBe(false);
    expect(lockState(100, 100).epochsLeft).toBe(1);
    expect(lockState(100, 101).open).toBe(true);
    expect(lockState(100, 55, 32).text).toMatch(/46 epochs.*1 d 0 h/);
  });
  it("estimates a future epoch's time", () => {
    const t0 = new Date("2026-10-13T15:00:00Z");
    expect(epochEta(110, 100, t0, 30).toISOString()).toBe("2026-10-13T20:00:00.000Z");
  });
});
