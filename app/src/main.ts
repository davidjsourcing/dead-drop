import "./styles.css";
import qrcode from "qrcode-generator";
import { DEPLOYMENT, MICRO } from "./core/net";
import { ghost, coins, addCoin, removeCoins, balance, pickCoins, drops, saveDrop, exportGhost, type MyDrop } from "./core/ghost";
import { decodeLink, encodeLink, type DropLink } from "./core/link";
import { bury, peek, raise, returnDrop, summon, postGrave, type Peek } from "./core/flows";
import { currentEpoch, getUtxoRaw, listGraves } from "./core/chain";
import { EPOCH_MINUTES } from "./core/time";
import { icon } from "./icons";

const app = document.getElementById("app")!;
const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const fmt = (micro: bigint) => (Number(micro) / Number(MICRO)).toLocaleString(undefined, { maximumFractionDigits: 3 });
const human = (epochs: number) => { const m = epochs * EPOCH_MINUTES; return m < 90 ? `~${Math.round(m)} min` : m < 60 * 36 ? `~${Math.round(m / 60)} h` : `~${Math.round(m / 1440)} days`; };
function toast(msg: string, ms = 3200) { const t = $("#toast"); t.textContent = msg; t.classList.add("on"); setTimeout(() => t.classList.remove("on"), ms); }
const baseUrl = () => location.href.split("#")[0];
const dropUrl = (linkStr: string) => `${baseUrl()}#/d/${linkStr}`;

// --------------------------------------------------------------------------------------------- ghost chip
function refreshChip() {
  const b = balance();
  $("#ghostchip span").textContent = coins().length ? `${fmt(b)} tTARI` : "summon funds";
}
$("#ghostchip").addEventListener("click", () => (location.hash = "#/ghost"));

// --------------------------------------------------------------------------------------------- views
function tombstone(epitaph: string, sub = "weight: sealed · amount hidden") {
  return `<div class="tomb"><div class="cross"></div><div class="rip">R · I · P</div><div class="epitaph">${esc(epitaph)}</div><div class="weight">${esc(sub)}</div></div><div class="ground"></div>`;
}

function home() {
  app.innerHTML = `
  <div class="hero">
    <div>
      <div class="eyebrow">Spooky secrets · Tari Ootle</div>
      <h1>Bury a secret.<br/>Only the <em>right words</em> raise it.</h1>
      <p class="lede">Dead Drop hides a message and some tTARI in a single stealth output. Nobody can see how much, who it's for, or what it says — until someone answers your riddle.</p>
      <div class="cta"><a class="btn primary" href="#/bury">${icon("coffin")} Bury a secret</a><a class="btn ghost" href="#/graveyard">Walk the graveyard</a></div>
      <p class="hint" style="margin-top:18px">No wallet to install. Your ghost lives in this browser, and the crypt gives it its first tTARI.</p>
    </div>
    <div class="scene" aria-hidden="true"><div class="moon"></div><div class="bats"><i></i><i></i></div>
      ${tombstone("What has roots nobody sees, and is taller than trees?", "weight: hidden · owner: unlinkable")}
      <div class="candles"><span></span><span></span><span></span></div></div>
  </div>
  <section>
    <div class="eyebrow">Six spells, one output</div>
    <h2>How the dead keep secrets</h2>
    <div class="grid3" style="margin-top:22px">
      <div class="panel lock"><h3>${icon("scale",22)} Hidden weight <span class="tag">Pedersen + Bulletproofs+</span></h3><p>The amount is a commitment. The chain checks the maths balances without ever learning the number.</p></div>
      <div class="panel lock"><h3>${icon("mask",22)} No name on the stone <span class="tag">stealth address</span></h3><p>The drop is addressed to a one-time key derived from the answer. It links to no wallet, no account, no person.</p></div>
      <div class="panel lock"><h3>${icon("letter",22)} A sealed letter <span class="tag">XChaCha20 memo</span></h3><p>Your secret rides inside the output, encrypted so only the answer key can read it.</p></div>
      <div class="panel lock"><h3>${icon("key",22)} The words, never spoken <span class="tag">MAST · AccessRule</span></h3><p>Raising it needs a signature from the answer key. The answer is never published, so nobody can copy it from the mempool.</p></div>
      <div class="panel lock"><h3>${icon("candle",22)} Witching hour <span class="tag">WASM spend script</span></h3><p>Optional: the drop opens only inside a nightly window, enforced by our template's spend script.</p></div>
      <div class="panel lock"><h3>${icon("back",22)} Return to sender <span class="tag">timelock leaf</span></h3><p>Unraised by the deadline? A second leaf lets only you take it back, with a one-time key.</p></div>
    </div>
  </section>
  <section class="split">
    <div><div class="eyebrow">Don't trust us — look</div><h2>X-ray any drop</h2><p class="lede">See exactly what the chain stores next to what the answer reveals. It's the same output, read twice.</p><a class="btn ghost" href="#/xray">Open the X-ray</a></div>
    <ol class="steps panel">
      <li><span><b>Bury.</b> Write a secret, pick an offering, set a riddle. Your browser builds the stealth output and the condition tree.</span></li>
      <li><span><b>Share the link.</b> It holds only public parameters. The answer never leaves your head.</span></li>
      <li><span><b>They answer.</b> A right answer decrypts the drop locally — a wrong one simply can't.</span></li>
      <li><span><b>They raise it.</b> One transaction moves it to their own ghost. The chain learns a one-time key signed. That's all.</span></li>
    </ol>
  </section>`;
}

function buryView() {
  app.innerHTML = `
  <div class="split">
    <form class="panel" id="buryform" autocomplete="off">
      <div class="eyebrow">New grave</div>
      <h2>Bury a secret</h2>
      <label for="secret">The secret <small>encrypted on-chain · 200 bytes max</small></label>
      <textarea id="secret" maxlength="200" required placeholder="The spare key is under the third gravestone."></textarea>
      <div class="row">
        <div><label for="amount">Offering <small>tTARI, hidden</small></label><input id="amount" type="number" min="0.1" step="0.1" value="1" required /></div>
        <div><label for="returns">Returns to you after</label><select id="returns"><option value="2">${human(2)}</option><option value="24" selected>${human(24)}</option><option value="72">${human(72)}</option></select></div>
      </div>
      <label for="riddle">The riddle <small>public, carved on the stone</small></label>
      <input id="riddle" maxlength="160" required placeholder="I have keys but open no locks. What am I?" />
      <label for="answer">The answer <small>never leaves this browser</small></label>
      <input id="answer" required placeholder="a piano" />
      <p class="hint">Spaces, case and accents don't matter. Pick something guessable to your friend, not to a dictionary.</p>
      <label class="switch"><input type="checkbox" id="capsule" /><div><b>Time capsule</b><span>Can't be raised before ${human(1)} from now (an <code>AfterEpoch</code> leaf).</span></div></label>
      <label class="switch"><input type="checkbox" id="witching" /><div><b>Witching hour</b><span>Opens only inside a short nightly window — enforced by the Crypt template's spend script.</span></div></label>
      <label class="switch"><input type="checkbox" id="public" /><div><b>Carve it in the public graveyard</b><span>Anyone can try your riddle. Only the riddle and dates are public — never the amount or the answer.</span></div></label>
      <div class="cta"><button class="btn primary" id="burybtn">${icon("coffin")} Bury it</button></div>
      <div class="status" id="status"></div>
    </form>
    <div id="preview">${tombstone("I have keys but open no locks. What am I?")}<p class="hint" style="text-align:center">Your ghost holds <b>${fmt(balance())} tTARI</b>. ${coins().length ? "" : '<a href="#/ghost">Summon some first →</a>'}</p></div>
  </div>`;
  const riddle = $<HTMLInputElement>("#riddle");
  riddle.addEventListener("input", () => ($(".epitaph").textContent = riddle.value || riddle.placeholder));
  $("#buryform").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $<HTMLButtonElement>("#burybtn"); btn.disabled = true;
    const status = $("#status");
    try {
      const amount = BigInt(Math.round(parseFloat($<HTMLInputElement>("#amount").value) * 1e6));
      const g = ghost();
      if (balance() < amount + 50_000n) {
        // A newcomer's first move is funded by the crypt itself: no wallet, no faucet.
        status.textContent = "your ghost is empty: summoning a dose from the crypt…";
        const s = await summon(g, (x) => (status.textContent = `summoning: ${x}…`));
        addCoin(s.utxo); refreshChip();
        if (balance() < amount + 50_000n) throw new Error(`The crypt's dose is ${fmt(s.utxo.value)} tTARI. Offer a little less than that.`);
      }
      const picked = pickCoins(amount + 50_000n);
      status.textContent = "digging…";
      $("#preview").innerHTML = `<div class="dig">${Array.from({ length: 14 }, (_, i) => `<i style="--x:${(i - 7) * 14}px;animation-delay:${i * 0.07}s"></i>`).join("")}</div>${tombstone(riddle.value)}`;
      const secret = $<HTMLTextAreaElement>("#secret").value;
      const answer = $<HTMLInputElement>("#answer").value;
      const res = await bury({
        sender: g, coins: picked, amount, secret, riddle: riddle.value, answer,
        returnsInEpochs: Number($<HTMLSelectElement>("#returns").value),
        opensInEpochs: $<HTMLInputElement>("#capsule").checked ? 1 : undefined,
        witching: $<HTMLInputElement>("#witching").checked ? { period: 24, offset: (await currentEpoch()) % 24, window: 2 } : undefined,
      }, (s) => (status.textContent = s + "…"));
      removeCoins(picked); addCoin(res.change);
      let linkStr = res.linkStr; let graveId: number | undefined;
      if ($<HTMLInputElement>("#public").checked && res.change) {
        status.textContent = "carving the stone…";
        const pg = await postGrave(g, res.change, res, (s) => (status.textContent = s + "…"));
        removeCoins([res.change]); addCoin(pg.change); graveId = pg.graveId;
        linkStr = encodeLink({ ...res.link, grave: graveId });
      }
      const d: MyDrop = { linkStr, refund: { owner: toHex(res.refund.ownerSecret), view: toHex(res.refund.viewSecret) }, answer, amount: amount.toString(), secret, riddle: riddle.value, returnsAt: res.link.returnsAt, opensAt: res.link.opensAt, createdAt: Date.now(), txId: res.txId, graveId, status: "buried" };
      saveDrop(d); refreshChip();
      location.hash = `#/buried/${encodeURIComponent(linkStr)}`;
    } catch (err) {
      status.textContent = ""; toast((err as Error).message, 6000); btn.disabled = false;
      $("#preview").innerHTML = tombstone(riddle.value || riddle.placeholder);
    }
  });
}

/** Ciphertext resolves into plaintext, character by character: the "wow" of the reveal. */
function decipher(el: HTMLElement, ms: number) {
  const final = el.dataset.final ?? ""; const hex = "0123456789abcdef"; const t0 = performance.now();
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce) { el.textContent = final; return; }
  const tick = (t: number) => {
    const k = Math.min(1, (t - t0) / ms); const n = Math.floor(final.length * k);
    el.textContent = final.slice(0, n) + Array.from(final.slice(n), (c) => (c === " " ? " " : hex[(Math.random() * 16) | 0])).join("");
    if (k < 1) requestAnimationFrame(tick); else el.textContent = final;
  };
  requestAnimationFrame(tick);
}
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

function buriedView(linkStr: string) {
  const link = decodeLink(linkStr);
  const url = dropUrl(linkStr);
  const qr = qrcode(0, "M"); qr.addData(url); qr.make();
  app.innerHTML = `
  <div class="split">
    <div class="rise">${tombstone(link.riddle, "buried · weight hidden · owner unlinkable")}</div>
    <div class="panel">
      <div class="eyebrow">It's in the ground</div>
      <h2>Share the grave</h2>
      <p class="lede" style="font-size:17px">Send this link to whoever should answer. It carries only public parameters — the answer stays with you. Unraised by epoch ${link.returnsAt} (${human(link.returnsAt - 0 > 0 ? 0 : 0) && ""}about the time you chose), it can come back to you from <a href="#/mine">My drops</a>.</p>
      <div class="linkbox"><input id="lnk" readonly value="${esc(url)}" /><button class="btn ghost" id="copy">Copy</button></div>
      <div style="display:flex;gap:20px;align-items:center;margin-top:18px"><div class="qr">${qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true })}</div>
      <p class="hint">${link.grave ? `Carved in the public graveyard as grave #${link.grave}.` : "Private grave: only people with the link can find it."}<br/><br/><a href="#/xray/${link.commitment}">X-ray this drop →</a></p></div>
    </div>
  </div>`;
  $("#copy").addEventListener("click", async () => { await navigator.clipboard.writeText(url); toast("Link copied. Choose your recipient wisely."); });
}

async function raiseView(linkStr: string) {
  let link: DropLink;
  try { link = decodeLink(linkStr); } catch (e) { app.innerHTML = `<div class="panel"><h2>Lost grave</h2><p>${esc((e as Error).message)}</p></div>`; return; }
  app.innerHTML = `
  <div class="split">
    <div id="stone">${tombstone(link.riddle)}</div>
    <div class="panel" id="side">
      <div class="eyebrow">Something is buried here</div>
      <h2>Speak the answer</h2>
      <p class="lede" style="font-size:17px">Its weight is hidden and its owner unnamed. Answer the riddle on the stone: if you're right, your browser can read what's inside. Nothing is sent until you choose to raise it.</p>
      <form id="ans" autocomplete="off"><label for="answer">Your answer</label><input id="answer" required autofocus placeholder="…" /><div class="cta"><button class="btn primary" id="speak">${icon("candle")} Speak</button></div></form>
      <div class="status" id="status"></div>
      <p class="hint">Terms carved on the stone: ${link.opensAt ? `opens after epoch ${link.opensAt} · ` : ""}${link.witching ? `witching hour every ${link.witching.period} epochs · ` : ""}returns to its sender at epoch ${link.returnsAt}. <a href="#/xray/${link.commitment}">X-ray →</a></p>
    </div>
  </div>`;
  const live = await getUtxoRaw(link.commitment).catch(() => null);
  if (!live) { $("#side").innerHTML = `<div class="eyebrow">Empty grave</div><h2>Someone got here first</h2><p class="lede" style="font-size:17px">This drop has already been raised or returned. The chain shows the output is spent — and nothing about who spent it.</p><a class="btn ghost" href="#/xray/${link.commitment}">See what the chain kept</a>`; return; }
  $("#ans").addEventListener("submit", async (e) => {
    e.preventDefault();
    const status = $("#status"); const btn = $<HTMLButtonElement>("#speak"); btn.disabled = true;
    status.textContent = "the stone listens…";
    const p: Peek = await peek(link, $<HTMLInputElement>("#answer").value);
    btn.disabled = false;
    if (p.state === "gone") { status.textContent = "the grave is already empty."; return; }
    if (p.state === "wrong") { status.textContent = "the dead do not answer to that name."; $("#stone").classList.remove("wrong"); void $("#stone").offsetWidth; $("#stone").classList.add("wrong"); return; }
    const o: any = (live as any)?.substate?.Utxo?.output ?? (live as any)?.substate?.Utxo ?? {};
    const body: any = o?.output ?? o;
    const cipher = String(body?.encrypted_data ?? "");
    $("#stone").classList.add("glow");
    $("#side").innerHTML = `<div class="eyebrow">The stone answers</div>
      <div class="reveal">
        <div class="col chain"><div class="cap">${icon("eye", 16)} What the chain sees</div>
          <div class="kv"><span>amount</span><code>commitment ${esc(link.commitment.slice(0, 20))}…</code></div>
          <div class="kv"><span>owner</span><code>one-time key ${esc(String(JSON.stringify(o?.auth ?? "")).replace(/[^0-9a-f]/g, "").slice(0, 16))}…</code></div>
          <div class="kv"><span>message</span><code class="cipher">${esc(cipher.slice(0, 120))}…</code></div></div>
        <div class="col you"><div class="cap">${icon("key", 16)} What your answer sees</div>
          <div class="amount" id="amt" data-final="${esc(fmt(p.value))} tTARI">${esc(cipher.slice(0, 8))}</div>
          <div class="secret" id="sec" data-final="${esc(p.secret)}"></div></div>
      </div>
      <p class="hint">Decrypted here, in your browser, with the key your answer derives. Nothing was sent. The chain still holds only the left column.</p>
      <div class="cta"><button class="btn primary" id="raise">${icon("urn")} Raise it into my ghost</button></div><div class="status" id="status"></div>`;
    decipher($("#amt"), 900); decipher($("#sec"), 1600);
    $("#raise").addEventListener("click", async () => {
      const b = $<HTMLButtonElement>("#raise"); b.disabled = true;
      try {
        const r = await raise(link, p, ghost(), (s) => ($("#status").textContent = s + "…"));
        addCoin(r.utxo); refreshChip();
        const mine = drops().find((d) => d.linkStr === linkStr); if (mine) saveDrop({ ...mine, status: "raised" });
        $("#side").innerHTML = `<div class="eyebrow">Raised</div><h2>It's yours now</h2><p class="lede" style="font-size:17px">${fmt(r.utxo.value)} tTARI moved into your ghost as a fresh stealth output (fee ${fmt(r.fee)}). What the chain learned: one leaf of the condition tree was used, signed by a one-time key nobody can tie to you.</p><div class="cta"><a class="btn ghost" href="#/xray/${link.commitment}">X-ray the empty grave</a><a class="btn primary" href="#/bury">Bury one back</a></div>`;
      } catch (err) { b.disabled = false; toast((err as Error).message, 7000); $("#status").textContent = ""; }
    });
  });
}

async function graveyardView() {
  app.innerHTML = `<div class="eyebrow">Public graves</div><h2>The graveyard</h2><p class="lede">Riddles carved by strangers. Each guards a hidden offering and a secret. Answer one and it's yours.</p><div class="graves" id="graves"><p class="status">reading the stones…</p></div>`;
  if (!DEPLOYMENT.template) { $("#graves").innerHTML = `<p class="hint">The crypt isn't open on this network yet.</p>`; return; }
  const [graves, epoch] = await Promise.all([listGraves(DEPLOYMENT.template), currentEpoch()]);
  if (!graves.length) { $("#graves").innerHTML = `<p class="hint">No graves yet. <a href="#/bury">Dig the first one.</a></p>`; return; }
  const cards = await Promise.all(graves.map(async (g) => {
    const live = await getUtxoRaw(g.commitment).catch(() => null);
    const state = live ? (epoch >= g.returns ? "returnable" : "sealed") : "raised";
    return `<a class="grave" href="#/d/${encodeURIComponent(g.link)}" style="text-decoration:none;color:inherit"><div class="ep">“${esc(g.epitaph)}”</div><div><span class="pill ${state === "raised" ? "raised" : "sealed"}">${state === "raised" ? "EMPTY" : "SEALED"}</span></div><div class="meta" style="margin-top:10px">grave #${g.id} · dug at epoch ${g.epoch}</div></a>`;
  }));
  $("#graves").innerHTML = cards.join("");
}

async function xrayView(commitment?: string) {
  const known = drops();
  const pick = commitment ?? (known[0] ? decodeLink(known[0].linkStr).commitment : "");
  app.innerHTML = `<div class="eyebrow">Two readings of one output</div><h2>X-ray</h2><p class="lede">Left: the drop exactly as the public indexer returns it. Right: what someone holding the answer sees.</p>
    <form id="xf" class="linkbox" style="margin:18px 0"><input id="cx" placeholder="drop commitment (64 hex) or a drop link" value="${esc(pick)}" /><button class="btn ghost">Read</button></form>
    <div class="split"><div><h3>What the chain sees</h3><div class="xray" id="raw">—</div></div><div><h3>What the answer sees</h3><div class="seen" id="seen"><p class="hint">Open a drop you buried (or raise one) to see its plaintext here. Everything on this side is computed in your browser.</p></div></div></div>`;
  $("#xf").addEventListener("submit", (e) => { e.preventDefault(); let v = $<HTMLInputElement>("#cx").value.trim(); if (v.includes("#/d/")) v = decodeLink(v.split("#/d/")[1]).commitment; location.hash = `#/xray/${v}`; });
  if (!/^[0-9a-f]{64}$/.test(pick)) return;
  const raw = await getUtxoRaw(pick).catch(() => null);
  const rawEl = $("#raw");
  if (!raw) { rawEl.innerHTML = `<span class="k">substate</span> utxo_…_${pick.slice(0, 16)}…\n<span class="hid">SPENT</span> — the output is gone. The chain recorded that one leaf of its condition tree was satisfied. It did not record by whom, for how much, or what the secret said.`; }
  else {
    const out = (raw as any)?.substate?.Utxo?.output ?? (raw as any)?.substate?.Utxo ?? raw;
    const o = out?.output ?? out;
    rawEl.innerHTML = [
      `<span class="k">commitment</span>      ${pick}`,
      `<span class="k">value</span>           <span class="hid">hidden (Pedersen commitment)</span>`,
      `<span class="k">auth</span>            ${esc(JSON.stringify(out?.auth ?? o?.auth ?? "?"))}`,
      `<span class="k">sender_nonce</span>    ${esc(String(o?.sender_public_nonce ?? o?.public_nonce ?? "?"))}`,
      `<span class="k">encrypted_data</span>  ${esc(String(o?.encrypted_data ?? "?"))}`,
      `<span class="k">range proof</span>     verified by validators, reveals nothing`,
      "", `<span class="k">— raw indexer JSON —</span>`, esc(JSON.stringify(raw, null, 1)).slice(0, 4000),
    ].join("\n");
  }
  const mine = known.find((d) => decodeLink(d.linkStr).commitment === pick);
  if (mine) {
    const link = decodeLink(mine.linkStr);
    $("#seen").innerHTML = `<dl><dt>Amount</dt><dd>${fmt(BigInt(mine.amount))} tTARI</dd><dt>Secret</dt><dd>${esc(mine.secret)}</dd><dt>Riddle / answer</dt><dd>${esc(link.riddle)} → <b>${esc(mine.answer)}</b></dd><dt>Raise leaf</dt><dd>signed by the answer key · before epoch ${link.returnsAt}${link.opensAt ? ` · after epoch ${link.opensAt}` : ""}${link.witching ? " · witching hour (template spend script)" : ""}</dd><dt>Return leaf</dt><dd>after epoch ${link.returnsAt} · signed by your one-time refund key</dd><dt>Status</dt><dd>${raw ? "in the ground" : "spent"}</dd></dl>`;
  }
}

async function mineView() {
  const list = drops(); const epoch = await currentEpoch().catch(() => 0);
  app.innerHTML = `<div class="eyebrow">Kept in this browser only</div><h2>My drops</h2>${list.length ? "" : `<p class="lede">Nothing buried yet. <a href="#/bury">Dig your first grave.</a></p>`}
  <table class="my"><thead><tr><th>Riddle</th><th>Offering</th><th>Returns at</th><th>Status</th><th></th></tr></thead><tbody>
  ${list.map((d, i) => `<tr><td>“${esc(d.riddle)}”</td><td>${fmt(BigInt(d.amount))}</td><td>epoch ${d.returnsAt}</td><td><span class="pill ${d.status === "buried" ? "sealed" : d.status}" data-i="${i}">${d.status}</span></td><td><a href="#/buried/${encodeURIComponent(d.linkStr)}">link</a> · <a href="#/xray/${decodeLink(d.linkStr).commitment}">x-ray</a>${d.status === "buried" && epoch >= d.returnsAt ? ` · <button class="btn ghost" data-ret="${i}" style="padding:6px 10px">Take it back</button>` : ""}</td></tr>`).join("")}
  </tbody></table><p class="hint">Current epoch: ${epoch}. A drop can be taken back once the current epoch reaches its return epoch.</p>`;
  for (const d of list.filter((d) => d.status === "buried")) {
    getUtxoRaw(decodeLink(d.linkStr).commitment).then((raw) => { if (!raw) saveDrop({ ...d, status: "raised" }); }).catch(() => {});
  }
  app.querySelectorAll<HTMLButtonElement>("[data-ret]").forEach((b) => b.addEventListener("click", async () => {
    const d = list[Number(b.dataset.ret)]; b.disabled = true;
    try {
      const { importKeys } = await import("./core/keys");
      const r = await returnDrop(decodeLink(d.linkStr), importKeys(d.refund), d.answer, ghost(), (s) => toast(s + "…"));
      addCoin(r.utxo); saveDrop({ ...d, status: "returned" }); refreshChip(); toast("Returned to your ghost."); mineView();
    } catch (err) { b.disabled = false; toast((err as Error).message, 7000); }
  }));
}

function ghostView() {
  const g = ghost();
  app.innerHTML = `<div class="split"><div class="panel"><div class="eyebrow">Your ghost</div><h2>${fmt(balance())} tTARI</h2>
  <p class="lede" style="font-size:17px">A throwaway stealth wallet that lives only in this browser. Every coin it holds is a separate stealth output with a one-time owner key.</p>
  <label>Stealth address</label><input readonly value="${g.address}" />
  <div class="cta"><button class="btn primary" id="summon">${icon("flask")} Summon from the crypt</button><button class="btn ghost" id="backup">Back up ghost key</button></div><div class="status" id="status"></div>
  <p class="hint">The crypt hands each summoning a small dose of testnet tTARI, capped per epoch. The public Esmeralda faucet is empty, so this is the fastest way in.</p></div>
  <div class="panel"><h3>Coins</h3><table class="my"><thead><tr><th>Commitment</th><th>Value</th></tr></thead><tbody>${coins().map((c) => `<tr><td><a href="#/xray/${c.commitment}" style="font-family:var(--mono);font-size:12px">${c.commitment.slice(0, 18)}…</a></td><td>${fmt(c.value)}</td></tr>`).join("") || `<tr><td colspan="2" class="hint">empty</td></tr>`}</tbody></table></div></div>`;
  $("#summon").addEventListener("click", async () => {
    const b = $<HTMLButtonElement>("#summon"); b.disabled = true;
    try { const r = await summon(g, (s) => ($("#status").textContent = s + "…")); addCoin(r.utxo); refreshChip(); toast(`Summoned ${fmt(r.utxo.value)} tTARI.`); ghostView(); }
    catch (err) { b.disabled = false; $("#status").textContent = ""; toast((err as Error).message, 7000); }
  });
  $("#backup").addEventListener("click", async () => { await navigator.clipboard.writeText(exportGhost()); toast("Ghost key copied. Anyone with it controls these coins."); });
}

// --------------------------------------------------------------------------------------------- router
function route() {
  const h = location.hash.slice(1) || "/";
  document.querySelectorAll(".nav nav a").forEach((a) => a.classList.toggle("on", h.startsWith((a as HTMLAnchorElement).hash.slice(1))));
  const [, view, arg] = h.split("/");
  window.scrollTo(0, 0);
  if (!view) return home();
  if (view === "bury") return buryView();
  if (view === "buried" && arg) return buriedView(decodeURIComponent(arg));
  if (view === "d" && arg) return raiseView(decodeURIComponent(arg));
  if (view === "graveyard") return graveyardView();
  if (view === "xray") return xrayView(arg);
  if (view === "mine") return mineView();
  if (view === "ghost") return ghostView();
  home();
}
window.addEventListener("hashchange", route);
refreshChip();
route();
