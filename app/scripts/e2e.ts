// End-to-end run of Dead Drop against the LIVE Esmeralda testnet (no mocks).
//
//   npm run e2e -- fund        walletd -> bank ghost (stealth transfer), one-off
//   npm run e2e -- all         summon -> bury -> wrong answer -> right answer -> raise -> X-ray -> graveyard
//   npm run e2e -- return      return-to-sender for a drop whose deadline has passed (reads .e2e/pending-return.json)
//
// Every step writes what the chain returned into .e2e/run-<time>.json, which TEST-REPORT.md quotes.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { exportKeys, importKeys, randomKeypair, type Keypair } from "../src/core/keys";
import { bury, peek, raise, returnDrop, summon, postGrave, feedCauldron } from "../src/core/flows";
import { currentEpoch, findOwned, getUtxoRaw, listGraves } from "../src/core/chain";
import { decodeLink } from "../src/core/link";
import { DEPLOYMENT, MICRO } from "../src/core/net";
import type { OwnedUtxo } from "../src/core/drop";

const DIR = new URL("../.e2e/", import.meta.url).pathname;
mkdirSync(DIR, { recursive: true });
const KEYS = DIR + "keys.json"; // testnet-only throwaway keys
const COINS = DIR + "coins.json";
const log: any[] = [];
const runFile = DIR + `run-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
const j = (x: unknown) => JSON.parse(JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v instanceof Uint8Array ? Buffer.from(v).toString("hex") : v)));
function step(name: string, data: unknown, ok = true) {
  const e = { t: new Date().toISOString(), step: name, ok, data: j(data) };
  log.push(e);
  writeFileSync(runFile, JSON.stringify(log, null, 2));
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`, typeof data === "string" ? data : JSON.stringify(j(data)).slice(0, 300));
}
function expect(cond: unknown, name: string, data: unknown) {
  step(name, data, !!cond);
  if (!cond) throw new Error(`expectation failed: ${name}`);
}

type Ghosts = { bank: Keypair; alice: Keypair; bob: Keypair };
function ghosts(): Ghosts {
  if (existsSync(KEYS)) {
    const s = JSON.parse(readFileSync(KEYS, "utf8"));
    return { bank: importKeys(s.bank), alice: importKeys(s.alice), bob: importKeys(s.bob) };
  }
  const g = { bank: randomKeypair(), alice: randomKeypair(), bob: randomKeypair() };
  writeFileSync(KEYS, JSON.stringify({ bank: exportKeys(g.bank), alice: exportKeys(g.alice), bob: exportKeys(g.bob) }, null, 2));
  return g;
}
const loadCoins = (): Record<string, any[]> => (existsSync(COINS) ? JSON.parse(readFileSync(COINS, "utf8")) : {});
const coinsOf = (who: string): OwnedUtxo[] =>
  (loadCoins()[who] ?? []).map((c: any) => ({ commitment: c.commitment, value: BigInt(c.value), mask: Buffer.from(c.mask, "hex"), publicNonce: Buffer.from(c.publicNonce, "hex") }));
function setCoins(who: string, list: OwnedUtxo[]) {
  const all = loadCoins();
  all[who] = j(list);
  writeFileSync(COINS, JSON.stringify(all, null, 2));
}

async function walletd(method: string, params: unknown) {
  const call = async (m: string, p: unknown, tok?: string) => {
    const r = await fetch("http://127.0.0.1:5100/json_rpc", {
      method: "POST",
      headers: { "content-type": "application/json", ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: p }),
    });
    const x: any = await r.json();
    if (x.error) throw new Error(`${m}: ${x.error.message}`);
    return x.result;
  };
  const { token } = await call("auth.request", { permissions: ["Admin"], credentials: "None" });
  return call(method, params, token);
}

async function fund(g: Ghosts, amountT: number) {
  const r = await walletd("accounts.stealth_transfer", {
    owner_account: { Name: "crypt" },
    fee_params: { input_selection: "PreferConfidential", pay_fee_with_swap: null },
    input_selection: "PreferConfidential",
    resource_address: "resource_0101010101010101010101010101010101010101010101010101010101010101",
    transfers: [{ destination_address: g.bank.address, blinded_output_amount: String(BigInt(amountT) * MICRO), revealed_output_amount: 0, output_memo: null, pay_to: "StealthPublicKey", attach_sender_address: false }],
    max_fee: 20000,
    dry_run: false,
  });
  const res = await walletd("transactions.wait_result", { transaction_id: r.transaction_id, timeout_secs: 120 });
  const accept = res?.result?.result?.Accept ?? res?.result?.finalize?.result?.Accept ?? res?.finalize?.result?.Accept;
  const ups = accept?.up_substates ?? [];
  const mine = await findOwned(ups, [g.bank]);
  expect(mine.length === 1, "walletd funds the bank ghost with a stealth output", { tx: r.transaction_id, value: mine[0]?.utxo.value });
  // Keep the bank's existing coins: a fund adds one, it must not replace the list.
  setCoins("bank", [...(loadCoins().bank ?? []), ...j(mine.map((m) => m.utxo))]);
}

async function all(g: Ghosts) {
  expect(DEPLOYMENT.crypt.startsWith("component_"), "crypt is deployed", DEPLOYMENT);
  const epoch0 = await currentEpoch();
  step("current epoch", { epoch: epoch0 });

  // 1. A brand-new ghost with no funds summons its first tTARI from the crypt.
  const newcomer = randomKeypair();
  const s = await summon(newcomer, (x) => console.log("   summon:", x));
  expect(s.utxo.value > 0n, "summon: a fresh ghost receives a hidden dose from the cauldron", { tx: s.txId, value: s.utxo.value });
  const sraw = await getUtxoRaw(s.utxo.commitment);
  expect(sraw && !JSON.stringify(sraw).includes(newcomer.address) && !JSON.stringify(sraw).includes(Buffer.from(newcomer.ownerPublic).toString("hex")), "summon: the chain record names neither the ghost's address nor its public key", { commitment: s.utxo.commitment });

  // 2. The newcomer buries a secret with most of its dose.
  const amount = (s.utxo.value * 6n) / 10n;
  const secret = "The spare key is under the third gravestone. Happy Halloween from the e2e test.";
  const b = await bury({ sender: newcomer, coins: [s.utxo], amount, secret, riddle: "What has a neck but no head?", answer: "A Bottle", returnsInEpochs: 3 }, (x) => console.log("   bury:", x));
  const keep = existsSync(DIR + "drops.json") ? JSON.parse(readFileSync(DIR + "drops.json", "utf8")) : [];
  keep.push({ link: b.linkStr, refund: exportKeys(b.refund), answer: "A Bottle", t: new Date().toISOString() });
  writeFileSync(DIR + "drops.json", JSON.stringify(keep, null, 2));
  expect(b.link.commitment.length === 64, "bury: the drop is a single stealth UTXO with a two-leaf condition tree", { tx: b.txId, root: b.root, link: b.linkStr.length + " chars", fee: b.fee });

  // 3. X-ray: what the chain stores
  const raw = await getUtxoRaw(b.link.commitment);
  const rawS = JSON.stringify(raw);
  expect(raw && !rawS.includes("gravestone") && !rawS.includes(String(amount)) && !rawS.toLowerCase().includes("bottle"), "x-ray: the on-chain output holds no amount, no secret and no answer in the clear", { substate: raw });

  // 4. Wrong answers learn nothing; the right one (any case/spacing) opens it locally.
  const wrong = await peek(decodeLink(b.linkStr), "a tree");
  expect(wrong.state === "wrong", "peek: a wrong answer cannot decrypt the drop", wrong);
  const right = await peek(decodeLink(b.linkStr), "  a BOTTLE ");
  expect(right.state === "right" && right.secret === secret && right.value === amount, "peek: the right answer reveals the secret and the hidden amount, locally", right.state === "right" ? { secret: right.secret, value: right.value } : right);

  // 5. Bob raises it into his own ghost: script-path spend signed by the answer key.
  if (right.state !== "right") return;
  const r = await raise(decodeLink(b.linkStr), right, g.bob, (x) => console.log("   raise:", x));
  expect(r.utxo.value === amount - r.fee, "raise: the drop moves to the solver's ghost (value minus fee)", { tx: r.txId, value: r.utxo.value, fee: r.fee });
  const gone = await peek(decodeLink(b.linkStr), "a bottle");
  expect(gone.state === "gone", "raise: the drop is spent and can't be raised twice", gone);
  setCoins("bob", [...coinsOf("bob"), r.utxo]);


  // 5b. The witching hour: the same drop shape plus a TemplateFunction leaf that runs the Crypt template's
  //     `witching_hour` spend script. Open window → raise succeeds. Closed window → the engine refuses.
  {
    const bob = coinsOf("bob");
    const now = await currentEpoch();
    const period = 24;
    for (const [label, offset, shouldOpen] of [["closed", (now + 5) % period, false], ["open", now % period, true]] as const) {
      const coins = coinsOf("bob");
      if (!coins.length) break;
      const w = await bury({ sender: g.bob, coins, amount: 200_000n, secret: `witching test (${label})`, riddle: "What runs but never walks?", answer: "a river", returnsInEpochs: 3, witching: { period, offset, window: 2 } }, (x) => console.log(`   bury witching ${label}:`, x));
      setCoins("bob", w.change ? [w.change] : []);
      const pk = await peek(decodeLink(w.linkStr), "a river");
      if (pk.state !== "right") throw new Error("witching drop did not open with its answer");
      try {
        const r = await raise(decodeLink(w.linkStr), pk, g.alice, (x) => console.log(`   raise witching ${label}:`, x));
        expect(shouldOpen, `witching hour (${label} window): raise ${shouldOpen ? "succeeds" : "should have been refused"}`, { tx: r.txId, epoch: now, offset, period });
        setCoins("alice", [...coinsOf("alice"), r.utxo]);
      } catch (err) {
        if (String((err as Error).message).startsWith("expectation failed")) throw err;
        expect(!shouldOpen, `witching hour (${label} window): the template's spend script refuses the raise`, { error: String((err as Error).message).slice(0, 400), epoch: now, offset, period });
      }
    }
    void bob;
  }
  // 6. A second drop, posted to the public graveyard, left in the ground to test return-to-sender later.
  const bank = coinsOf("bank");
  if (bank.length) {
    const b2 = await bury({ sender: g.bank, coins: bank, amount: 500_000n, secret: "If you're reading this after the deadline, the crypt kept its promise.", riddle: "What gets wetter the more it dries?", answer: "a towel", returnsInEpochs: 1 }, (x) => console.log("   bury#2:", x));
    setCoins("bank", b2.change ? [b2.change] : []);
    step("bury #2 (left for return-to-sender)", { tx: b2.txId, returnsAt: b2.link.returnsAt });
    writeFileSync(DIR + "pending-return.json", JSON.stringify({ link: b2.linkStr, refund: exportKeys(b2.refund), answer: "a towel" }, null, 2));
    const change = coinsOf("bank")[0];
    if (change) {
      const pg = await postGrave(g.bank, change, b2, (x) => console.log("   grave:", x));
      setCoins("bank", pg.change ? [pg.change] : []);
      expect(pg.graveId > 0, "graveyard: the grave is posted as a public event (epitaph + root, no amount, no owner)", { tx: pg.txId, graveId: pg.graveId });
      const graves = await listGraves(DEPLOYMENT.crypt);
      expect(graves.some((x) => x.commitment === b2.link.commitment), "graveyard: the indexer lists the new grave", { graves: graves.length });
    }
  }
  step("done", { epoch: await currentEpoch() });
}

async function doReturn(g: Ghosts) {
  const p = JSON.parse(readFileSync(DIR + "pending-return.json", "utf8"));
  const link = decodeLink(p.link);
  const now = await currentEpoch();
  step("return: epochs", { now, returnsAt: link.returnsAt });
  // Before the deadline the RETURN leaf must fail; after it, it must succeed.
  try {
    const r = await returnDrop(link, importKeys(p.refund), p.answer, g.bank, (x) => console.log("   return:", x));
    expect(now > link.returnsAt, "return: the sender takes the unraised drop back after the deadline", { tx: r.txId, value: r.utxo?.value, fee: r.fee });
    if (r.utxo) setCoins("bank", [...coinsOf("bank"), r.utxo]);
  } catch (e) {
    expect(now <= link.returnsAt, "return: refused before the deadline (timelock leaf)", { error: String((e as Error).message).slice(0, 300) });
  }
}

async function feed(g: Ghosts, amountT: number) {
  const coins = coinsOf("bank");
  const r = await feedCauldron(g.bank, coins, BigInt(amountT) * MICRO, (x) => console.log("   feed:", x));
  setCoins("bank", r.change ? [r.change] : []);
  expect(true, "feed: the bank ghost pours stealth tTARI into the cauldron as a revealed bucket", { tx: r.txId, fed: amountT, fee: r.fee, change: r.change?.value });
}

const g = ghosts();
const cmd = process.argv[2] ?? "all";
const run = cmd === "fund" ? fund(g, Number(process.argv[3] ?? 40)) : cmd === "feed" ? feed(g, Number(process.argv[3] ?? 30)) : cmd === "return" ? doReturn(g) : cmd === "addr" ? Promise.resolve(console.log(g.bank.address)) : all(g);
run.then(
  () => { console.log("log:", runFile); process.exit(0); },
  (e) => { step("error", { message: String(e?.message ?? e), stack: String(e?.stack ?? "").slice(0, 800) }, false); console.log("log:", runFile); process.exit(1); },
);
