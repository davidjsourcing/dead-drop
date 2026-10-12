// Seeds the Halloween hunt: three real graves, chained (each secret names the next grave). Run once.
import { readFileSync, writeFileSync } from "node:fs";
import { importKeys, exportKeys } from "../src/core/keys";
import { bury, postGrave } from "../src/core/flows";
import { encodeLink } from "../src/core/link";

const DIR = new URL("../.e2e/", import.meta.url).pathname;
const bank = importKeys(JSON.parse(readFileSync(DIR + "keys.json", "utf8")).bank);
const all = JSON.parse(readFileSync(DIR + "coins.json", "utf8"));
const load = () => (all.bank ?? []).map((c: any) => ({ commitment: c.commitment, value: BigInt(c.value), mask: Buffer.from(c.mask, "hex"), publicNonce: Buffer.from(c.publicNonce, "hex") }));
const save = (u: any) => { all.bank = u ? [{ commitment: u.commitment, value: u.value.toString(), mask: Buffer.from(u.mask).toString("hex"), publicNonce: Buffer.from(u.publicNonce).toString("hex") }] : []; writeFileSync(DIR + "coins.json", JSON.stringify(all, null, 2)); };
const RETURNS = Number(process.env.RETURNS ?? 1500); // ~6 weeks of Esmeralda epochs: lasts through judging

// The hunt's riddles, answers and secrets live in .e2e/hunt-graves.json (gitignored), so publishing this repo
// doesn't publish the answers. Shape: [{ riddle, answer, secret }], where "{next}" in a secret is the next grave's id.
const graves = (JSON.parse(readFileSync(DIR + "hunt-graves.json", "utf8")) as Array<{ riddle: string; answer: string; secret: string }>).map((g) => ({
  ...g,
  secret: (next: number) => g.secret.replace("{next}", String(next)),
}));

(async () => {
  const out: any[] = [];
  let next = 0;
  for (let i = graves.length - 1; i >= 0; i--) {
    const g = graves[i];
    const b = await bury({ sender: bank, coins: load(), amount: 1_000_000n, secret: g.secret(next), riddle: g.riddle, answer: g.answer, returnsInEpochs: RETURNS }, (s) => console.log(`  #${i + 1} bury:`, s));
    save(b.change);
    const pg = await postGrave(bank, load()[0], b, (s) => console.log(`  #${i + 1} grave:`, s));
    save(pg.change);
    next = pg.graveId;
    const link = encodeLink({ ...b.link, grave: pg.graveId });
    out.unshift({ step: i + 1, grave: pg.graveId, riddle: g.riddle, answer: g.answer, link, refund: exportKeys(b.refund), buryTx: b.txId, graveTx: pg.txId });
    console.log(`grave #${pg.graveId} = hunt step ${i + 1}`);
  }
  writeFileSync(DIR + "hunt.json", JSON.stringify(out, null, 2));
  process.exit(0);
})().catch((e) => { console.error("ERROR", e?.message, String(e?.stack).slice(0, 800)); process.exit(1); });
