
const { chromium } = require('/home/user/node_modules/playwright-core');
const BASE = process.env.BASE || 'http://localhost:4317/'; const OUT = process.env.OUT || '/tmp/dd-new';
require('fs').mkdirSync(OUT,{recursive:true});
const MID = process.env.MID, H1 = process.env.H1, A1 = process.env.A1;
(async()=>{
 const b = await chromium.launch({args:['--no-sandbox','--disable-dev-shm-usage']});
 const res=[]; const check=(n,ok,x)=>{res.push(ok);console.log(ok?'PASS':'FAIL',n,x||'')};
 const ctx = await b.newContext({viewport:{width:1280,height:800}, deviceScaleFactor:2});
 const p = await ctx.newPage(); const errs=[]; p.on('pageerror',e=>errs.push(String(e)));
 await p.goto(BASE+'#/hunt',{waitUntil:'networkidle'});
 await p.waitForSelector('.midnight-card',{timeout:60000});
 const steps = await p.locator('.step').count(); check('hunt page lists 3 steps + finale', steps>=4, steps);
 const sealed = await p.locator('.midnight-card .pill.sealed').count(); check('midnight grave sealed on chain', sealed===1);
 await p.screenshot({path:OUT+'/hunt.png', fullPage:true});
 // midnight grave: right answer -> receipt -> early raise refused by validators
 await p.goto(BASE+'#/d/'+MID,{waitUntil:'networkidle'});
 await p.waitForSelector('#lockline .lock',{timeout:30000}); check('time-lock line shown', true, await p.locator('#lockline').innerText());
 await p.fill('#answer','midnight'); await p.click('#speak');
 await p.waitForSelector('#receipt',{timeout:60000});
 const leaks = await p.locator('#receipt td.leak').count(); const safe = await p.locator('#receipt td.safe').count();
 check('privacy receipt: nothing private in public data', leaks===0 && safe>=4, `safe=${safe} leaks=${leaks}`);
 await p.waitForTimeout(2200); await p.screenshot({path:OUT+'/midnight-receipt.png'});
 await p.click('#raise'); await p.waitForSelector('.refusal',{timeout:120000}).catch(()=>{});
 const ref = await p.locator('.refusal').innerText().catch(()=> ''); check('early raise refused by validators (AfterEpoch)', /AfterEpoch\(\d+\)/.test(ref), ref.slice(0,200));
 await p.locator('.refusal').scrollIntoViewIfNeeded().catch(()=>{}); await p.screenshot({path:OUT+'/midnight-refused.png'});
 // X-ray with an answer, for hunt step 1
 await p.goto(BASE+'#/xray/'+H1,{waitUntil:'networkidle'});
 await p.waitForSelector('#verify a',{timeout:30000});
 await p.waitForTimeout(1500);
 await p.fill('#xans',A1); await p.click('#xa button');
 await p.waitForSelector('#receipt',{timeout:60000}).catch(()=>{});
 const l2 = await p.locator('#receipt td.leak').count(), s2 = await p.locator('#receipt td.safe').count();
 check('X-ray with answer: receipt clean', s2>=3 && l2===0, `safe=${s2} leaks=${l2}`);
 await p.screenshot({path:OUT+'/xray-receipt.png', fullPage:true});
 await p.goto(BASE,{waitUntil:'networkidle'}); await p.waitForTimeout(1500); await p.screenshot({path:OUT+'/home.png'});
 // mobile
 const m = await b.newContext({viewport:{width:390,height:844}, deviceScaleFactor:2, isMobile:true});
 const mp = await m.newPage(); await mp.goto(BASE+'#/hunt',{waitUntil:'networkidle'}); await mp.waitForSelector('.midnight-card',{timeout:60000});
 const ow = await mp.evaluate(()=>document.documentElement.scrollWidth); check('mobile hunt: no horizontal overflow', ow<=392, ow);
 await mp.screenshot({path:OUT+'/hunt-mobile.png', fullPage:true});
 check('no page errors', errs.length===0, errs.slice(0,3).join(' | '));
 console.log(`${res.filter(Boolean).length}/${res.length}`); await b.close(); process.exit(res.every(Boolean)?0:1);
})().catch(e=>{console.error(e);process.exit(1)});
