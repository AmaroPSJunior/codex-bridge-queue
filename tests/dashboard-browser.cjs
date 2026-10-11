const {chromium}=require('playwright');
const {spawn}=require('node:child_process');
const assert=require('node:assert/strict');
const fs=require('node:fs');

(async()=>{
  const server=spawn('python3',['-m','http.server','4173','--bind','127.0.0.1','--directory','dashboard'],{stdio:'ignore'});
  let browser;
  try{
    for(let i=0;i<50;i++){
      try{if((await fetch('http://127.0.0.1:4173')).ok)break;}catch{}
      await new Promise(r=>setTimeout(r,100));
    }
    browser=await chromium.launch();
    const page=await browser.newPage();
    const errors=[];
    page.on('pageerror',x=>errors.push(x.message));
    await page.route('https://**',r=>r.abort());

    for(const v of [{width:1440,height:1000},{width:390,height:844}]){
      await page.setViewportSize(v);
      await page.goto('http://127.0.0.1:4173');

      // Contract: without a real backend connection, no demo/fake task may appear.
      assert.ok(await page.locator('.hero').count());
      assert.equal(await page.locator('.task-card').count(),0);
      assert.equal(await page.locator('[data-running-id]').count(),0);

      for(const route of ['overview','live','tasks','history','settings']){
        await page.locator('#nav a[href="#'+route+'"]').click();
        await page.waitForTimeout(80);
        assert.ok((await page.locator('main').innerText()).length>20);
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
      }

      await page.locator('#nav a[href="#tasks"]').click();
      assert.equal(await page.locator('.task-card').count(),0);

      await page.locator('#nav a[href="#settings"]').click();
      await page.locator('.advanced > summary').click();
      await page.locator('#pause-follow').click();
      assert.equal(await page.locator('#pause-follow').getAttribute('aria-pressed'),'true');

      await page.locator('#nav a[href="#overview"]').click();
      fs.mkdirSync('dashboard/screenshots',{recursive:true});
      await page.screenshot({path:'dashboard/screenshots/overview-'+v.width+'.png',fullPage:true});
    }

    // Real dashboard wiring + Chromium AudioContext; fake data, no Supabase calls.
    let fixtureRows=[{id:'already-done',project_id:'sound-project',status:'succeeded',progress_seq:'1'},
      {id:'sound-task',project_id:'sound-project',status:'running',progress_seq:'1',progress_percent:100}];
    await page.addInitScript(()=>{
      window.soundNotes=[];
      const Native=window.AudioContext;
      window.AudioContext=class extends Native {
        createOscillator(){const oscillator=super.createOscillator();const start=oscillator.start.bind(oscillator);oscillator.start=(...args)=>{window.soundNotes.push(oscillator.frequency.value);return start(...args);};return oscillator;}
      };
    });
    await page.route('**/public-config.json',r=>r.fulfill({json:{publishableKey:'sb_publishable_fixture'}}));
    await page.route('**/data.mjs',r=>r.fulfill({contentType:'text/javascript',body:`
      export function createPublicData(){throw Error('unexpected public data');}
      export async function createData(config,callbacks){
        window.soundRows=${JSON.stringify(fixtureRows)};
        window.soundCallbacks=callbacks;
        return {restore:async()=>true,projects:async()=>[{id:'sound-project',name:'Codex Bridge'}],
          list:async()=>structuredClone(window.soundRows),stats:async()=>({total:window.soundRows.length,counts:{}}),
          summary:async id=>structuredClone(window.soundRows.find(r=>r.id===id)),
          detail:async()=>null,subscribe:async()=>{callbacks.onState('live');await callbacks.onRefresh();}};
      }
    `}));
    await page.goto('http://127.0.0.1:4173');
    await page.waitForFunction(()=>window.soundCallbacks&&document.querySelector('[data-running-id]'));
    assert.equal(await page.evaluate(()=>window.soundNotes.length),0);
    await page.getByRole('button',{name:'Ativar som',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('#unlock-sound').hidden&&document.querySelector('#completion-sound').getAttribute('aria-pressed')==='true');
    // Estimated 100% never plays, including route render and manual refresh.
    await page.locator('#refresh').click();
    await page.locator('#nav a[href="#tasks"]').click();
    await page.locator('#nav a[href="#overview"]').click();
    assert.equal(await page.evaluate(()=>window.soundNotes.length),0);
    await page.evaluate(async()=>{window.soundRows[1]={...window.soundRows[1],status:'succeeded',progress_seq:'2'};await window.soundCallbacks.onEvent({id:'sound-task',project_id:'sound-project',operation:'UPDATE'});});
    assert.equal(await page.evaluate(()=>window.soundNotes.length),2);
    await page.evaluate(async()=>{for(let i=0;i<3;i++){await window.soundCallbacks.onRefresh();await window.soundCallbacks.onEvent({id:'sound-task',project_id:'sound-project',operation:'UPDATE'});}window.soundCallbacks.onState('reconnecting');window.soundCallbacks.onState('live');});
    assert.equal(await page.evaluate(()=>window.soundNotes.length),2);
    await page.getByRole('button',{name:'Desativar som',exact:true}).click();
    await page.evaluate(async()=>{window.soundRows.push({id:'muted',project_id:'sound-project',status:'queued',progress_seq:'1'});await window.soundCallbacks.onRefresh();window.soundRows[2].status='failed';await window.soundCallbacks.onRefresh();});
    assert.equal(await page.evaluate(()=>window.soundNotes.length),2);
    await page.getByRole('button',{name:'Ativar som',exact:true}).click();
    await page.evaluate(()=>window.soundCallbacks.onRefresh());
    assert.equal(await page.evaluate(()=>window.soundNotes.length),2);
    // Each outcome emits one short notification (two/two/one tones).
    for(const status of ['failed','cancelled']){
      await page.evaluate(async status=>{const row={id:status,project_id:'sound-project',status:'running',progress_seq:'1'};window.soundRows.push(row);await window.soundCallbacks.onRefresh();row.status=status;row.progress_seq='2';await window.soundCallbacks.onRefresh();},status);
    }
    assert.equal(await page.evaluate(()=>window.soundNotes.length),5);
    fixtureRows=await page.evaluate(()=>window.soundRows);
    await page.reload();
    await page.waitForFunction(()=>window.soundCallbacks&&document.querySelector('#completion-sound').getAttribute('aria-pressed')==='true');
    assert.equal(await page.evaluate(()=>window.soundNotes.length),0);
    assert.equal(await page.locator('#unlock-sound').isVisible(),true);
    await page.getByRole('button',{name:'Liberar som',exact:true}).click();
    await page.evaluate(()=>window.soundCallbacks.onRefresh());
    assert.equal(await page.evaluate(()=>window.soundNotes.length),0);
    await page.locator('#completion-sound').focus();await page.keyboard.press('Space');
    assert.equal(await page.locator('#completion-sound').getAttribute('aria-pressed'),'false');
    console.log('Dashboard sound Chromium passed: gesture unlock, all outcomes, dedup, mute, preference/reload and keyboard control.');

    assert.deepEqual(errors,[]);
    console.log('Dashboard Chromium smoke passed: disconnected state is empty, responsive and error-free.');
  }finally{
    await browser?.close();
    server.kill();
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
