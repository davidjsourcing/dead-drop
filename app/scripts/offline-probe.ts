
import { randomKeypair, deriveAnswerKeys, newSalt } from "../src/core/keys";
import { dropConditions, createOutput } from "../src/core/drop";
import { WasmStealthCrypto } from "@tari-project/ootle";
import { buildScriptPathWitness } from "@tari-project/ootle-wasm";
import { NETWORK, TARI } from "../src/core/net";
const t0=Date.now();
const ans = deriveAnswerKeys("A Shadow", newSalt());
console.log("kdf ms", Date.now()-t0, ans.address.slice(0,30));
const refund = randomKeypair();
const conds = dropConditions({ answerPublic: ans.ownerPublic, refundPublic: refund.ownerPublic, returnsAt: 12500, opensAt: 12200,
  witching: { template: "aa".repeat(32), period: 24, offset: 3, window: 2 } });
console.log(JSON.stringify(conds).slice(0,400));
const crypto = new WasmStealthCrypto(NETWORK);
const out = createOutput({ destination: ans.address, amount: 5_000_000n, resourceAddress: TARI, payTo: { Conditions: conds }, memo: { Message: "the key is under the third gravestone" } });
const r = await crypto.generateOutputsStatement([out], { amount: 1000n, receiver: refund.ownerPublic });
console.log("outputs stmt ok", r.statement.statementJson.slice(0,300));
const w = buildScriptPathWitness(JSON.stringify(conds), JSON.stringify(conds[0]), new Uint8Array());
console.log("witness", w.slice(0,300));
