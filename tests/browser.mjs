import { chromium, expect } from '@playwright/test';
import fs from 'node:fs';
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({viewport:{width:1680,height:1100}});
const page=await context.newPage();const errors=[];
page.on('pageerror',error=>errors.push(String(error)));
const base=process.env.DEMO_URL??'http://127.0.0.1:5198';
const room=`proof-${Date.now()}`;const api=`${base}/api/rooms/${room}`;
const state=()=>fetch(api).then(r=>r.json());
async function until(f,ms=20000){const end=Date.now()+ms;while(!await f()){if(Date.now()>end)throw Error('Timed out');await new Promise(r=>setTimeout(r,100));}}
async function ready(p=page){await expect(p.getByRole('button',{name:'Add comment',exact:true})).toBeEnabled({timeout:120000});}
async function policy(comment,suggestion,edit){for(const [name,value]of Object.entries({comments:comment,suggestions:suggestion,edits:edit}))await page.getByLabel(`Allow ${name}`,{exact:true}).setChecked(value);await page.getByRole('button',{name:'Apply permissions',exact:true}).click();await until(async()=>JSON.stringify((await state()).users.writer)===JSON.stringify({comment,suggestion,edit}));}
const proofs=[];
async function action(name,type,allowed){await ready();const before=(await state()).events.at(-1)?.id??0;const generation=Number(await page.locator('main').getAttribute('data-generation'));await page.getByRole('button',{name,exact:true}).click();await until(async()=>(await state()).events.some(e=>e.id>before&&e.type===type&&e.allowed===allowed));if(!allowed)await until(async()=>Number(await page.locator('main').getAttribute('data-generation'))>generation);await ready();const event=(await state()).events.find(e=>e.id>before&&e.type===type&&e.allowed===allowed);proofs.push(event);console.log('VERIFIED',name,type,allowed,event.milliseconds.toFixed(2)+'ms');}
try{
 await page.goto(`${base}/?room=${room}`);await ready();
 await action('Add comment','comment',true);
 await action('Suggest text','suggestion',true);
 await action('Insert direct text','edit',true);
 await page.reload(); await ready(); console.log('VERIFIED committed room survives browser reload');
 const observer=await context.newPage();await observer.goto(`${base}/?room=${room}&user=observer`);await ready(observer);
 await page.locator('.superdoc-text-run').first().click();await page.keyboard.type('ALLOWEDKEYS');
 await expect(observer.locator('.superdoc')).toContainText('ALLOWEDKEYS',{timeout:20000});
 console.log('VERIFIED native keystrokes reach observer');
 await policy(true,true,false);
 await action('Insert direct text','edit',false);
 await expect(page.locator('.notice')).toContainText('Rejected local changes were discarded',{timeout:20000});
 await expect(observer.locator('.superdoc')).not.toContainText('Direct 4.');
 await action('Add comment','comment',true);
 await action('Suggest text','suggestion',true);
 await policy(false,true,false);
 await action('Add comment','comment',false);
 await policy(true,false,false);
 await action('Suggest text','suggestion',false);
 await page.getByText('Latest editor exception',{exact:true}).click();
 await expect(page.locator('.transport-error')).toContainText('WebSocket close 4403'); await page.locator('header').scrollIntoViewIfNeeded(); await page.screenshot({path:'evidence/rejected-and-recovered.png',fullPage:false});
 await policy(true,true,false);
 await ready();let previous=(await state()).events.at(-1).id;
 await page.locator('.superdoc-text-run').first().click();await page.keyboard.type('BLOCKEDKEYS');
 await until(async()=>(await state()).events.some(e=>e.id>previous&&!e.allowed));await ready();
 await expect(page.locator('.superdoc')).not.toContainText('BLOCKEDKEYS');await expect(observer.locator('.superdoc')).not.toContainText('BLOCKEDKEYS');
 console.log('VERIFIED denied native typing removed locally and absent on observer');
 await policy(true,true,true);await action('Insert direct text','edit',true);
 await page.getByRole('button',{name:'Type suggestions',exact:true}).click();await ready();
 previous=(await state()).events.at(-1).id;
 await page.locator('.superdoc-text-run').first().click();await page.keyboard.type('SUGGESTKEYS');
 await until(async()=>(await state()).events.some(e=>e.id>previous&&e.type==='suggestion'&&e.allowed));
 await expect(observer.locator('.superdoc')).toContainText('SUGGESTKEYS',{timeout:20000});
 console.log('VERIFIED native suggestion typing');
 await page.locator('header').scrollIntoViewIfNeeded(); await page.screenshot({path:'evidence/allowed-and-connected.png',fullPage:false});
 fs.writeFileSync('evidence/browser-results.json',JSON.stringify({room,proofs,errors,events:(await state()).events},null,2));
 expect(errors).toEqual([]);
}catch(error){await page.screenshot({path:'evidence/browser-failure.png',fullPage:false}).catch(()=>{});throw error;}finally{await context.close();await browser.close();}
