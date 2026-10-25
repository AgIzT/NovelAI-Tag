// Actual editor script with controlled fetch/DOM. No browser, files or network writes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('./strings_editor.html', import.meta.url), 'utf8');
const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'))
  .replace('loadCollections().then(()=>loadData(currentFile));', '');
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise, resolve}; }
function harness() {
  const nodes = new Map();
  const reads = new Map();
  const writes = [];
  let overlay = null;
  function node(selector) {
    if(selector==='.form-overlay')return overlay;
    if(selector.startsWith('.'))return null;
    if(!nodes.has(selector))nodes.set(selector,{value:'',checked:false,textContent:'',disabled:false,style:{}});
    return nodes.get(selector);
  }
  Object.defineProperty(node('#libSelect'),'innerHTML',{set(value){this.value=/<option value="([^"]*)"/.exec(value)?.[1]||'';}});
  node('#formTpl').content={firstElementChild:{cloneNode(){return {remove(){if(overlay===this)overlay=null;},querySelector:()=>({})};}}};
  const formControls = [{disabled:false},{disabled:false}];
  const context = vm.createContext({
    console, setTimeout, clearTimeout, confirm: () => true, prompt:()=> 'New B', alert:message=>{throw new Error(message);},
    FormData: class { constructor(){this.values=new Map();} append(key,value){this.values.set(key,value);} get(key){return this.values.get(key);} },
    localStorage: {getItem: () => null, setItem() {}},
    document: {querySelectorAll: () => formControls, querySelector:node,body:{appendChild(value){overlay=value;}}},
    fetch(url, options) {
      const gate = deferred();
      if (options?.method === 'POST') writes.push({url, options, gate});
      else {
        const file = url.startsWith('data/') ? url.slice(5).split('?')[0] : new URL(url, 'http://localhost').searchParams.get('file');
        reads.set(file, gate);
      }
      return gate.promise;
    },
  });
  vm.runInContext(script, context);
  vm.runInContext('renderTree=()=>{};renderList=()=>{};toast=()=>{};', context);
  const run = code => vm.runInContext(code, context);
  function finish(file, id, ok = true) {
    const data = {title: file, author: 'author', categories: [], entries: [{id, images: []}]};
    reads.get(file).resolve({ok, json: async () => ({...data, ok, file, revision: id.repeat(64), data})});
  }
  async function load(file, id) {
    run(`currentFile=${JSON.stringify(file)}`);
    const promise = run(`loadData(${JSON.stringify(file)})`);
    finish(file, id);
    await promise;
  }
  return {run, reads, writes, finish, load, nodes, formControls,node,hasOverlay:()=>!!overlay};
}
async function tick(){for(let i=0;i<12;i++)await Promise.resolve();}

let failures = 0, cases = 0;
async function test(name, task) {
  cases++;
  try { await task(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, error); }
}
await test('late A load cannot replace loaded B content', async () => {
  const h = harness();
  h.run("currentFile='strings_a.json'");
  const a = h.run("loadData('strings_a.json')");
  h.run("currentFile='strings_b.json'");
  const b = h.run("loadData('strings_b.json')");
  h.finish('strings_b.json', 'b'); await b;
  h.finish('strings_a.json', 'a'); await a;
  assert.equal(h.run('entries[0].id'), 'b');
});
await test('failed load cannot save old content into selected file', async () => {
  const h = harness(); await h.load('strings_a.json', 'a');
  h.run("currentFile='strings_b.json'");
  const load = h.run("loadData('strings_b.json')");
  h.finish('strings_b.json', 'b', false); await load;
  const save = h.run('saveAll()');
  if (h.writes.length) h.writes[0].gate.resolve({ok: true, json: async () => ({ok: true, revision: 'b'.repeat(64)})});
  await save;
  assert.equal(h.writes.length, 0);
});
await test('save response does not mark later edits clean', async () => {
  const h = harness(); await h.load('strings_a.json', 'a');
  h.run("dirty=true");
  const save = h.run('saveAll()');
  h.run("entries.push({id:'later',images:[]});if(typeof markDirty==='function')markDirty();else dirty=true;");
  h.writes[0].gate.resolve({ok: true, json: async () => ({ok: true, revision: 'c'.repeat(64)})});
  await save;
  assert.equal(h.run('dirty'), true);
});
await test('second save cannot race an in-flight save', async () => {
  const h = harness(); await h.load('strings_a.json', 'a');
  const one = h.run('saveAll()'); const two = h.run('saveAll()');
  for (const item of h.writes) item.gate.resolve({ok: true, json: async () => ({ok: true, revision: 'c'.repeat(64)})});
  await Promise.all([one, two]);
  assert.equal(h.writes.length, 1);
});
await test('save uses loaded identity, revision and existing metadata', async () => {
  const h = harness(); await h.load('strings_a.json', 'a');
  const save = h.run('saveAll()');
  assert.match(h.writes[0].url, /file=strings_a\.json$/);
  assert.equal(h.writes[0].options.headers['If-Match'], 'a'.repeat(64));
  assert.equal(JSON.parse(h.writes[0].options.body).title, 'strings_a.json');
  assert.equal(JSON.parse(h.writes[0].options.body).author, 'author');
  h.nodes.get('#libSelect').value='strings_b.json';
  await h.run('switchLibrary()');
  assert.equal(h.run('currentFile'), 'strings_a.json');
  assert.equal(h.reads.has('strings_b.json'), false);
  h.writes[0].gate.resolve({ok: true, json: async () => ({ok:true,revision:'c'.repeat(64)})});
  await save;
  assert.equal(h.run('loadedRevision'), 'c'.repeat(64));
  assert.equal(h.run('dirty'), false);
});
await test('stale failed read does not invalidate the successful selection', async () => {
  const h = harness();
  h.run("currentFile='strings_a.json'"); const a=h.run("loadData('strings_a.json')");
  h.run("currentFile='strings_b.json'"); const b=h.run("loadData('strings_b.json')");
  h.finish('strings_b.json','b'); await b;
  h.finish('strings_a.json','a',false); await a;
  assert.equal(h.run('loadedFile'),'strings_b.json');
  assert.equal(h.run('canEdit()'),true);
});
await test('save conflict preserves draft and version', async () => {
  const h=harness(); await h.load('strings_a.json','a'); h.run('markDirty()');
  const save=h.run('saveAll()');
  h.writes[0].gate.resolve({ok:false,json:async()=>({ok:false,error:'conflict'})}); await save;
  assert.equal(h.run('dirty'),true);
  assert.equal(h.run('loadedRevision'),'a'.repeat(64));
});
await test('sequential uploads keep loaded file and advance only its revision', async () => {
  const h=harness(); await h.load('strings_a.json','a');
  h.run("uploadFiles=[{name:'one'},{name:'two'}]");
  const upload=h.run('uploadImages(entries[0])');
  assert(h.formControls.every(control=>control.disabled));
  h.nodes.get('#libSelect').value='strings_b.json'; await h.run('switchLibrary()');
  assert.equal(h.run('currentFile'),'strings_a.json');
  assert.equal(h.writes[0].options.body.get('stringsFile'),'strings_a.json');
  assert.equal(h.writes[0].options.body.get('revision'),'a'.repeat(64));
  h.writes[0].gate.resolve({ok:true,json:async()=>({ok:true,revision:'c'.repeat(64),images:[{file:'one.jpg'}]})});
  for(let i=0;i<5;i++)await Promise.resolve();
  assert.equal(h.writes.length,2);
  assert.equal(h.writes[1].options.body.get('stringsFile'),'strings_a.json');
  assert.equal(h.writes[1].options.body.get('revision'),'c'.repeat(64));
  h.writes[1].gate.resolve({ok:true,json:async()=>({ok:true,revision:'d'.repeat(64),images:[{file:'one.jpg'},{file:'two.jpg'}]})});
  await upload;
  assert(h.formControls.every(control=>!control.disabled));
  assert.equal(h.run('uploadFiles.length'),0);
  assert.equal(h.run('entries[0].images.length'),2);
  assert.equal(h.run('dirty'),true);
});
await test('failed upload keeps unconfirmed files and draft', async () => {
  const h=harness(); await h.load('strings_a.json','a'); h.run("uploadFiles=[{name:'one'}];markDirty()");
  const upload=h.run('uploadImages(entries[0])');
  h.writes[0].gate.resolve({ok:false,json:async()=>({ok:false,error:'conflict'})}); await upload;
  assert.equal(h.run('uploadFiles.length'),1);
  assert.equal(h.run('dirty'),true);
  assert.equal(h.run('loadedRevision'),'a'.repeat(64));
});
await test('creating a collection blocks new forms and overlapping mutations until loaded', async () => {
  const h=harness();await h.load('strings_a.json','a');
  const creating=h.run('addCollection()');
  h.run('openForm(null)');
  assert.equal(h.hasOverlay(),false);
  assert.equal(h.run('canEdit()'),false);
  assert.equal(h.node('#saveAllBtn').disabled,true);
  h.node('#libSelect').value='strings_c.json';await h.run('switchLibrary()');
  await h.run('addCollection()');await h.run('saveAll()');
  assert.equal(h.writes.length,1);assert.equal(h.run('currentFile'),'strings_a.json');
  h.writes[0].gate.resolve({ok:true,json:async()=>({ok:true,file:'strings_b.json'})});await tick();
  h.reads.get('strings_index.json').resolve({ok:true,json:async()=>({collections:[{file:'strings_b.json',name:'B'}]})});await tick();
  assert.equal(h.run('canEdit()'),false);
  h.finish('strings_b.json','b');await creating;
  assert.equal(h.run('loadedFile'),'strings_b.json');assert.equal(h.hasOverlay(),false);
  assert.equal(h.run('canEdit()'),true);
});
await test('collection deletion blocks edits and failure restores the existing form draft', async () => {
  const h=harness();await h.load('strings_a.json','a');
  h.run("collections=[{file:'strings_a.json',name:'A'},{file:'strings_b.json',name:'B'}];openForm(null)");
  h.node('#fTitle').value='A draft';h.node('#fPrompt').value='A prompt';
  const deleting=h.run('deleteCollection()');
  h.run('submitForm()');h.run('saveAll()');h.run('deleteCollection()');
  assert.equal(h.run('entries.length'),1);assert.equal(h.writes.length,1);
  assert(h.formControls.every(control=>control.disabled));
  h.writes[0].gate.resolve({ok:false,json:async()=>({ok:false,error:'synthetic failure'})});await deleting;
  assert.equal(h.run('canEdit()'),true);assert.equal(h.hasOverlay(),true);
  assert.equal(h.node('#fTitle').value,'A draft');
  assert(h.formControls.every(control=>!control.disabled));
});
await test('a form from an older load cannot submit into a new collection or same-file generation', async () => {
  for(const next of ['strings_b.json','strings_a.json']){
    const h=harness();await h.load('strings_a.json','a');h.run('openForm(null)');
    const submit=h.node('#fSubmit').onclick;
    h.node('#fTitle').value='A draft';h.node('#fPrompt').value='A prompt';
    await h.load(next,'b');submit();
    assert.equal(h.run('entries.length'),1);assert.equal(h.run('entries[0].id'),'b');
    assert.equal(h.hasOverlay(),false);assert.equal(h.run('dirty'),false);
  }
});
await test('failed collection creation unlocks the unchanged collection and form draft', async () => {
  const h=harness();await h.load('strings_a.json','a');h.run('openForm(null);markDirty()');
  h.node('#fTitle').value='A draft';h.node('#fPrompt').value='A prompt';
  const creating=h.run('addCollection()');
  assert(h.formControls.every(control=>control.disabled));
  h.writes[0].gate.resolve({ok:false,json:async()=>({ok:false,error:'synthetic failure'})});await creating;
  assert.equal(h.run('loadedFile'),'strings_a.json');assert.equal(h.run('canEdit()'),true);
  assert.equal(h.run('dirty'),true);assert.equal(h.hasOverlay(),true);assert.equal(h.node('#fTitle').value,'A draft');
});
await test('successful deletion keeps the editor locked until the replacement collection is loaded', async () => {
  const h=harness();await h.load('strings_a.json','a');
  h.run("collections=[{file:'strings_a.json',name:'A'},{file:'strings_b.json',name:'B'}];openForm(null)");
  const staleSubmit=h.node('#fSubmit').onclick;const deleting=h.run('deleteCollection()');
  assert.equal(JSON.parse(h.writes[0].options.body).file,'strings_a.json');
  h.writes[0].gate.resolve({ok:true,json:async()=>({ok:true})});await tick();
  h.reads.get('strings_index.json').resolve({ok:true,json:async()=>({collections:[{file:'strings_b.json',name:'B'}]})});await tick();
  assert.equal(h.run('canEdit()'),false);assert.equal(h.hasOverlay(),false);
  h.finish('strings_b.json','b');await deleting;staleSubmit();
  assert.equal(h.run('canEdit()'),true);assert.equal(h.run('entries.length'),1);assert.equal(h.run('entries[0].id'),'b');
});
if(!failures)console.log(`strings editor state: PASS (${cases} cases)`);
if (failures) process.exitCode = 1;
