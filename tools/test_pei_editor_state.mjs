// Actual image editor script, synthetic DOM/fetch/FileReader only; no network or data writes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html=fs.readFileSync(new URL('./pei.html',import.meta.url),'utf8');
const script=html.slice(html.indexOf('<script>')+8,html.lastIndexOf('</script>')).replace(/\binit\(\);\s*$/,'');
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
function harness(){
  const nodes=new Map(),requests=[],readers=[];
  function element(){return {value:'',checked:false,style:{},children:[],isConnected:true,classList:{add(){},remove(){}},appendChild(n){this.children.push(n);},append(...items){this.children.push(...items);},remove(){this.isConnected=false;}};}
  function node(selector){if(!nodes.has(selector))nodes.set(selector,element());return nodes.get(selector);}
  const context=vm.createContext({console,setTimeout:()=>0,clearTimeout(){},location:{hostname:'127.0.0.1',protocol:'http:'},
    document:{querySelector:node,createElement:element,createDocumentFragment:element},
    FileReader:class{constructor(){readers.push(this);}readAsDataURL(){this.result='data:image/png;base64,c3ludGhldGlj';}},
    fetch(url,options){const gate=deferred();requests.push({url,options,gate});return gate.promise;},
  });
  vm.runInContext(script,context);const run=code=>vm.runInContext(code,context);
  function respond(request,data,ok=true){request.gate.resolve({ok,json:async()=>data});}
  async function load(id,title=id){const promise=run(`load(${JSON.stringify(id)})`);respond(requests.at(-1),{entries:[{id:'shared-entry',title,tags:'test',path:[]}]});await promise;}
  function begin(){run('testRow=makeRow(state.codex.entries[0]);testZone=testRow.children[0];testInput=testZone.children[0];testInput.files=[{}];testInput.onchange();');}
  return {run,requests,readers,respond,load,begin,node};
}
async function tick(){for(let i=0;i<12;i++)await Promise.resolve();}
let failures=0,cases=0;
async function test(name,task){cases++;try{await task();console.log('PASS',name);}catch(error){failures++;console.error('FAIL',name,error);}}
await test('late A load cannot replace selected B rows or identity',async()=>{
  const h=harness();const a=h.run("load('a')");const reqA=h.requests.at(-1);
  await h.load('b');h.respond(reqA,{entries:[{id:'shared-entry',title:'A late',path:[]}]});await a;
  assert.equal(h.run('state.cid'),'b');assert.equal(h.run('state.codex.entries[0].title'),'b');
});
await test('FileReader completion sends the original row codex and entry after a switch',async()=>{
  const h=harness();await h.load('a');h.begin();const reader=h.readers[0];
  await h.load('b');reader.onload();await tick();
  const req=h.requests.find(r=>r.options?.method==='POST');const payload=JSON.parse(req.options.body);
  assert.equal(payload.codexId,'a');assert.equal(payload.entryId,'shared-entry');
  h.respond(req,{ok:true,image:'a.jpg',imageWidth:1,imageHeight:1,original:'a.png',assetRev:'abc'});await tick();
  assert.equal(h.run('state.codex.entries[0].image'),undefined);assert.equal(h.node('#done').textContent,0);
});
await test('late upload success cannot mutate a freshly loaded view of the same codex',async()=>{
  const h=harness();await h.load('a');h.begin();h.readers[0].onload();await tick();
  const req=h.requests.at(-1);await h.load('a','reloaded');
  h.respond(req,{ok:true,image:'old.jpg',original:'old.png'});await tick();
  assert.equal(h.run('state.codex.entries[0].image'),undefined);
  assert.equal(h.run("testZone.innerHTML.includes('old.jpg')"),false);
});
await test('a detached old row cannot start an upload into the selected codex',async()=>{
  const h=harness();await h.load('a');h.run('oldRow=makeRow(state.codex.entries[0]);oldInput=oldRow.children[0].children[0]');
  await h.load('b');h.run('oldInput.files=[{}];oldInput.onchange()');
  assert.equal(h.readers.length,0);assert.equal(h.requests.filter(r=>r.options?.method==='POST').length,0);
});
await test('failed current load leaves no writable rows and stale failures leave B intact',async()=>{
  const h=harness();await h.load('a');const b=h.run("load('b')");h.respond(h.requests.at(-1),{},false);await b;
  assert.equal(h.run('state.codex'),null);assert.equal(h.run('state.list.length'),0);
  const old=h.run("load('a')");const req=h.requests.at(-1);await h.load('b');h.respond(req,{},false);await old;
  assert.equal(h.run('state.codex.entries[0].title'),'b');
});
await test('successful upload updates only its current row and releases read-error retries',async()=>{
  const h=harness();await h.load('a');h.begin();h.run('testInput.onchange()');assert.equal(h.readers.length,1);
  h.readers[0].onerror();await tick();h.run('testInput.onchange()');assert.equal(h.readers.length,2);
  h.readers[1].onload();await tick();const req=h.requests.at(-1);
  h.respond(req,{ok:true,image:'new.jpg',original:'new.png',assetRev:'abc'});await tick();
  assert.equal(h.run('state.codex.entries[0].image'),'new.jpg');assert.equal(h.node('#done').textContent,1);
  assert.match(h.run('testZone.innerHTML'),/images\/a\/new.jpg/);
});
if(!failures)console.log(`pei editor state: PASS (${cases} cases)`);
if(failures)process.exitCode=1;
