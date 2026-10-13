// Seeds the Midnight Grave: a drop whose answer is printed on the stone, but which the validators refuse to raise
// before OPENS (an AfterEpoch leaf). A chain-enforced timed reveal: the first ghost to raise it after the bell keeps it.
// Then proves the lock: tries to raise it right away with the right answer and records the network's refusal.
import { readFileSync, writeFileSync } from "node:fs";
import { importKeys, exportKeys, randomKeypair } from "../src/core/keys";
import { bury, postGrave, peek, raise } from "../src/core/flows";
import { encodeLink } from "../src/core/link";
import { currentEpoch } from "../src/core/chain";

const DIR = new URL("../.e2e/", import.meta.url).pathname;
const bank = importKeys(JSON.parse(readFileSync(DIR + "keys.json", "utf8")).bank);
const all = JSON.parse(readFileSync(DIR + "coins.json", "utf8"));
const load = () => (all.bank ?? []).map((c: any) => ({ commitment: c.commitment, value: BigInt(c.value), mask: Buffer.from(c.mask, "hex"), publicNonce: Buffer.from(c.publicNonce, "hex") }));
const save = (u: any) => { all.bank = u ? [{ commitment: u.commitment, value: u.value.toString(), mask: Buffer.from(u.mask).toString("hex"), publicNonce: Buffer.from(u.publicNonce).toString("hex") }] : []; writeFileSync(DIR + "coins.json", JSON.stringify(all, null, 2)); };
const OPENS = Number(process.env.OPENS ?? 13031);
const RETURNS = Number(process.env.RETURNS ?? 13660);
const RIDDLE = "I have hands but hold nothing, and tonight I strike twelve. The answer is no secret: midnight. The lock is time.";
const ANSWER = "midnight";
const SECRET = `You read me early. The validators won't let this tTARI move until after epoch ${OPENS} (Halloween). First ghost to raise it after the bell keeps it.`;

(async () => {
  const now = await currentEpoch();
  console.log("epoch now", now, "opens after", OPENS, "returns after", RETURNS);
  const b = await bury({ sender: bank, coins: load(), amount: 1_000_000n, secret: SECRET, riddle: RIDDLE, answer: ANSWER, returnsInEpochs: RETURNS - now, opensInEpochs: OPENS - now }, (s) => console.log("  bury:", s));
  save(b.change);
  const pg = await postGrave(bank, load()[0], b, (s) => console.log("  grave:", s));
  save(pg.change);
  const link = { ...b.link, grave: pg.graveId };
  const out: any = { grave: pg.graveId, link: encodeLink(link), opensAt: link.opensAt, returnsAt: link.returnsAt, epochAtBury: now, buryTx: b.txId, graveTx: pg.txId, refund: exportKeys(b.refund), buryFee: b.fee.toString(), graveFee: String((pg as any).fee ?? "") };
  writeFileSync(DIR + "midnight.json", JSON.stringify(out, null, 2));
  console.log("grave #", pg.graveId, "opensAt", link.opensAt);
  // Prove the lock: the right answer opens the memo, but the network refuses the raise.
  const p = await peek(link, ANSWER);
  out.peek = p.state === "right" ? { state: "right", value: p.value.toString(), secret: p.secret } : p;
  try {
    const r = await raise(link, p as any, randomKeypair(), (s) => console.log("  early raise:", s));
    out.earlyRaise = { refused: false, txId: r.txId };
    console.log("UNEXPECTED: early raise went through", r.txId);
  } catch (e) {
    out.earlyRaise = { refused: true, at: new Date().toISOString(), epoch: await currentEpoch(), error: String((e as Error).message).slice(0, 600) };
    console.log("early raise refused:", out.earlyRaise.error);
  }
  writeFileSync(DIR + "midnight.json", JSON.stringify(out, null, 2));
  process.exit(0);
})().catch((e) => { console.error("ERROR", e?.message, String(e?.stack).slice(0, 800)); process.exit(1); });
