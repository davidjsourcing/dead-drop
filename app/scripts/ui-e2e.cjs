// Browser end-to-end: the real UI against the live Esmeralda testnet (no mocks). Saves screenshots.
const { chromium } = require('/home/user/node_modules/playwright-core');
const fs = require('fs');
const BASE = process.env.BASE || 'http://localhost:4317/';
const OUT = process.env.OUT || '/tmp/ui-e2e'; fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
(async () => {
  const b = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const results = [];
  const check = (name, ok, extra) => { results.push({ name, ok, extra }); log(ok ? 'PASS' : 'FAIL', name, extra ?? ''); };
  // --- sender ---
  const A = await b.newContext({ viewport: { width: 1280, height: 800 } });
  await A.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(BASE).origin });
  const pa = await A.newPage(); const errs = []; pa.on('pageerror', (e) => errs.push(String(e)));
  await pa.goto(BASE + '#/bury', { waitUntil: 'networkidle' });
  await pa.fill('#secret', 'Meet me at the old oak at midnight. Bring a lantern.');
  await pa.fill('#amount', '0.5');
  await pa.fill('#riddle', 'I have a face that never smiles and hands that never wave. What am I?');
  await pa.fill('#answer', 'a clock');
  await pa.screenshot({ path: OUT + '/1-bury-form.png' });
  const t0 = Date.now();
  await pa.click('#burybtn');
  await pa.waitForURL(/#\/buried\//, { timeout: 240000 }).catch(() => {});
  const buried = /#\/buried\//.test(pa.url());
  check('UI bury (auto-summon for an empty ghost, then bury)', buried, `${Math.round((Date.now() - t0) / 1000)}s ${errs.slice(0, 2).join(' | ')}`);
  if (!buried) { await pa.screenshot({ path: OUT + '/fail-bury.png' }); console.log(await pa.locator('#status').textContent().catch(() => '')); console.log(await pa.locator('#toast').textContent().catch(() => '')); await b.close(); process.exit(1); }
  await pa.waitForTimeout(800); await pa.screenshot({ path: OUT + '/2-buried.png' });
  const link = await pa.inputValue('#lnk');
  // --- solver (fresh browser = fresh ghost) ---
  const B = await b.newContext({ viewport: { width: 1280, height: 800 } });
  const pb = await B.newPage(); pb.on('pageerror', (e) => errs.push(String(e)));
  await pb.goto(link.replace(/^https?:\/\/[^/]+\//, BASE), { waitUntil: 'networkidle' });
  await pb.waitForTimeout(1500);
  await pb.screenshot({ path: OUT + '/3-tomb.png' });
  await pb.fill('#answer', 'a candle'); await pb.click('#speak');
  await pb.waitForFunction(() => /do not answer/.test(document.querySelector('#status')?.textContent || ''), null, { timeout: 30000 }).catch(() => {});
  check('UI wrong answer is refused locally', /do not answer/.test(await pb.locator('#status').textContent()));
  await pb.fill('#answer', 'A CLOCK'); await pb.click('#speak');
  await pb.waitForSelector('#raise', { timeout: 30000 }).catch(() => {});
  await pb.waitForTimeout(2200);
  const sec = await pb.locator('#sec').textContent().catch(() => '');
  check('UI right answer decrypts the secret in the browser', sec.includes('old oak'), sec);
  await pb.screenshot({ path: OUT + '/4-reveal.png' });
  const t1 = Date.now();
  await pb.click('#raise');
  await pb.waitForFunction(() => /It's yours now/.test(document.querySelector('#side')?.textContent || ''), null, { timeout: 240000 }).catch(() => {});
  const raised = /It's yours now/.test(await pb.locator('#side').textContent());
  check('UI raise into the solver\'s ghost', raised, `${Math.round((Date.now() - t1) / 1000)}s`);
  await pb.screenshot({ path: OUT + '/5-raised.png' });
  const chip = await pb.locator('#ghostchip span').textContent();
  check('solver ghost now holds tTARI', /tTARI/.test(chip), chip);
  // sender's view of the X-ray after it is spent
  const commitment = JSON.parse(Buffer.from(decodeURIComponent(link.split('#/d/')[1]).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString())[1];
  await pa.goto(BASE + '#/xray/' + commitment, { waitUntil: 'networkidle' }); await pa.waitForTimeout(2500);
  await pa.screenshot({ path: OUT + '/6-xray-spent.png', fullPage: true });
  check('X-ray shows the drop as spent', /SPENT/.test(await pa.locator('#raw').textContent()));
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  fs.writeFileSync(OUT + '/results.json', JSON.stringify({ at: new Date().toISOString(), link, results }, null, 2));
  await b.close();
})();
