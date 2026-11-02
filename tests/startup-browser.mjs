import { chromium, expect } from '@playwright/test';
import fs from 'node:fs';
const base=process.env.DEMO_URL??'http://127.0.0.1:5198';
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({viewport:{width:1680,height:1100}});
const first=await context.newPage(),second=await context.newPage();const errors=[],requests=[],responses=[];
const room=`startup-${Date.now()}`;
for(const page of [first,second]){
 page.on('pageerror',e=>errors.push(String(e)));
 page.on('response',response=>{if(response.url().includes(`/api/rooms/${room}/open`))requests.push(response.json().then(body=>responses.push({status:response.status(),...body})));});
}
try{
 await Promise.all([first.goto(`${base}/?room=${room}`),second.goto(`${base}/?room=${room}&user=observer`)]);
 await Promise.all([first,second].map(p=>expect(p.getByRole('button',{name:'Add comment',exact:true})).toBeEnabled({timeout:120000})));
 await first.reload();
 await expect(first.getByRole('button',{name:'Add comment',exact:true})).toBeEnabled({timeout:120000});
 await expect(first.getByRole('status')).toContainText('Connected');
 await expect(first.locator('.exception pre')).not.toContainText('could not find a committed');
 await Promise.all(requests);
 expect(responses.filter(r=>r.roomMode==='create')).toHaveLength(1);
 expect(responses.filter(r=>r.roomMode==='join').length).toBeGreaterThanOrEqual(2);
 expect(errors).toEqual([]);
 const state=await(await fetch(`${base}/api/rooms/${room}`)).json();expect(state.opened).toBe(true);
 await first.screenshot({path:'evidence/startup-reload.png',fullPage:false});
 fs.writeFileSync('evidence/startup-results.json',JSON.stringify({room,responses,errors,committed:state.opened},null,2));
 console.log('VERIFIED concurrent open: one creator; second waits for commit; browser reload joins existing room.');
 console.log(JSON.stringify(responses));
}finally{await context.close();await browser.close();}
