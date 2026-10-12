// One-off deploy to Esmeralda from the e2e bank ghost: publish the Crypt template, open a crypt, feed it.
//   npx tsx scripts/deploy.ts publish | open <dose_T> <cap_T> | feed <T>
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { importKeys } from "../src/core/keys";
import { withStealthFee, feedCauldron } from "../src/core/flows";
import { MICRO } from "../src/core/net";
import { amountLiteral } from "@tari-project/ootle";

const DIR = new URL("../.e2e/", import.meta.url).pathname;
const keys = JSON.parse(readFileSync(DIR + "keys.json", "utf8"));
const bank = importKeys(keys.bank);
const coinsFile = DIR + "coins.json";
const all = JSON.parse(readFileSync(coinsFile, "utf8"));
const coins = (all.bank ?? []).map((c: any) => ({ commitment: c.commitment, value: BigInt(c.value), mask: Buffer.from(c.mask, "hex"), publicNonce: Buffer.from(c.publicNonce, "hex") }));
const depFile = DIR + "deployment.json";
const dep = existsSync(depFile) ? JSON.parse(readFileSync(depFile, "utf8")) : {};
const save = (change: any) => { all.bank = change ? [{ commitment: change.commitment, value: change.value.toString(), mask: Buffer.from(change.mask).toString("hex"), publicNonce: Buffer.from(change.publicNonce).toString("hex") }] : []; writeFileSync(coinsFile, JSON.stringify(all, null, 2)); writeFileSync(depFile, JSON.stringify(dep, null, 2)); };
const ups = (c: any) => c.ups.map(([id]: [string]) => id);

const [cmd, a1, a2] = process.argv.slice(2);
(async () => {
  if (cmd === "publish") {
    const wasm = readFileSync(process.env.WASM ?? `${process.env.HOME}/tari-work/target/wasm32-unknown-unknown/release/dead_drop.wasm`);
    const r = await withStealthFee(bank, coins, (b) => b.publishTemplate(wasm.toString("base64")), [], (s) => console.log("  ", s));
    const t = ups(r).find((id: string) => id.startsWith("template_"));
    dep.template = t; dep.publishTx = r.txId; dep.publishFee = r.fee.toString();
    save(r.change); console.log("published", t, "tx", r.txId, "fee", r.fee);
  } else if (cmd === "open") {
    const tmpl = String(dep.template).replace(/^template_/, "");
    const dose = BigInt(Math.round(Number(a1 ?? 2) * 1e6)), cap = BigInt(Math.round(Number(a2 ?? 10) * 1e6));
    const r = await withStealthFee(bank, coins, (b) => b.addInstruction({ CallFunction: { address: tmpl, function: "new", args: [amountLiteral(dose), amountLiteral(cap)] } } as never), [], (s) => console.log("  ", s));
    const comp = ups(r).find((id: string) => id.startsWith("component_"));
    dep.crypt = comp; dep.openTx = r.txId; dep.dose = dose.toString(); dep.cap = cap.toString();
    save(r.change); console.log("crypt", comp, "tx", r.txId, "ups", ups(r));
  } else if (cmd === "feed") {
    const r = await feedCauldron(bank, coins, BigInt(Math.round(Number(a1 ?? 30) * 1e6)), (s) => console.log("  ", s));
    dep.feeds = [...(dep.feeds ?? []), { tx: r.txId, amount: a1 }];
    save(r.change); console.log("fed", a1, "tx", r.txId, "fee", r.fee);
  }
  process.exit(0);
})().catch((e) => { console.error("ERROR", e?.message ?? e, String(e?.stack ?? "").slice(0, 1500)); process.exit(1); });
