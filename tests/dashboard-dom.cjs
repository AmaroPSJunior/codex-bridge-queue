// Optional DOM runtime smoke, no browser layout engine or network.
// NODE_PATH=<temporary dependencies>/node_modules node --experimental-vm-modules tests/dashboard-dom.cjs
const {parseHTML}=require('linkedom');const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
(async()=>{const root=path.resolve(__dirname,'../dashboard');const {window}=parseHTML(fs.readFileSync(path.join(root,'index.html'),'utf8'));const {document}=window;const location={hash:''};let intervals=0;
for(const dialog of document.querySelectorAll('dialog')){dialog.showModal=()=>dialog.setAttribute('open','');dialog.close=()=>dialog.removeAttribute('open');}
const context=vm.createContext({document,window,location,console,URL,TextEncoder,AbortSignal,Intl,Date,setTimeout,clearTimeout,setInterval:()=>++intervals,fetch:()=>{throw Error('Unexpected network in demo');}});
const modules=new Map();
for(const name of fs.readdirSync(root).filter(n=>n.endsWith('.mjs'))){const file=path.join(root,name);modules.set(file,new vm.SourceTextModule(fs.readFileSync(file,'utf8'),{context,identifier:file}));}
const app=modules.get(path.join(root,'app.mjs'));await app.link((specifier,ref)=>modules.get(path.resolve(path.dirname(ref.identifier),specifier)));await app.evaluate();
async function navigate(route){location.hash='#'+route;window.dispatchEvent(new window.Event('hashchange'));await new Promise(r=>setTimeout(r,5));assert.ok(document.querySelector('main').textContent.length>40,route);assert.equal(document.querySelectorAll('#nav a').length,4);assert.equal(document.querySelectorAll('#nav [aria-current=page]').length,1);}
for(const route of ['overview','tasks','history','settings'])await navigate(route);
await navigate('overview');assert.ok(document.querySelector('progress[aria-label]'));assert.ok(document.querySelector('[data-activity]'));assert.match(document.querySelector('main').textContent,/Executando a tarefa/);
await navigate('tasks');const search=document.querySelector('#task-search');search.value='diagnostico';search.dispatchEvent(new window.Event('input',{bubbles:true}));assert.ok(document.querySelectorAll('tbody tr').length>0);assert.ok(document.querySelectorAll('tbody tr').length<48);
document.querySelector('[data-task]').click();await new Promise(r=>setTimeout(r,5));assert.ok(document.querySelector('#detail-title').textContent.startsWith('Tarefa'));document.querySelector('#detail-dialog [data-close]').click();assert.ok(!document.querySelector('#detail-dialog').hasAttribute('open'));
await navigate('settings');document.querySelector('.advanced').open=true;document.querySelector('#pause-follow').click();assert.equal(document.querySelector('#pause-follow').getAttribute('aria-pressed'),'true');assert.equal(intervals,1);
console.log('Dashboard DOM runtime passed: four screens, navigation, search, details, pause, advanced output controls. Layout requires Chromium smoke separately.');
})().catch(e=>{console.error(e);process.exitCode=1;});
