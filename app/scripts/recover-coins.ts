
import { readFileSync, writeFileSync } from "node:fs";
import { importKeys } from "../src/core/keys";
import { findOwned, getUtxoRaw } from "../src/core/chain";
const DIR = new URL("../.e2e/", import.meta.url).pathname;
const IX = "https://ootle-indexer-a.tari.com";
const keys = JSON.parse(readFileSync(DIR + "keys.json", "utf8"));
const bank = importKeys(keys.bank);
const coins = JSON.parse(readFileSync(DIR + "coins.json", "utf8"));
const have = new Set((coins.bank ?? []).map((c: any) => c.commitment));
const txs = process.argv.slice(2);
const ups: Array<[string, any]> = [];
for (const tx of txs) {
  const body = await (await fetch(`${IX}/transactions/${tx}`)).text();
  const hexes = [...new Set(body.match(/[0-9a-f]{64}/g) ?? [])];
  for (const h of hexes) {
    const raw = await getUtxoRaw(h).catch(() => null);
    if (raw) { ups.push([`utxo_0101010101010101010101010101010101010101010101010101010101010101_${h}`, raw]); if (ups.length === 1) console.log("shape", JSON.stringify(raw).slice(0, 300)); }
  }
}
console.log("live utxos found", ups.length);
const mine = await findOwned(ups, [bank]);
const j = (x: unknown) => JSON.parse(JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v instanceof Uint8Array ? Buffer.from(v).toString("hex") : v)));
for (const m of mine) { console.log("bank owns", m.utxo.commitment, String(m.utxo.value)); }
console.log("example stored coin", JSON.stringify(coins.bank[0]).slice(0, 300));
if (process.env.WRITE) {
  for (const m of mine) if (!have.has(m.utxo.commitment)) coins.bank.push(j(m.utxo));
  writeFileSync(DIR + "coins.json", JSON.stringify(coins, null, 2)); console.log("written", coins.bank.length);
}
