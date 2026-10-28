import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const root=new URL('../site/',import.meta.url),hash=b=>createHash('sha256').update(b).digest('hex');
const worker=await readFile(new URL('sw.js',root),'utf8');
const encoded=worker.match(/^const ASSETS=(\[.*\]);$/m)[1];
const records=JSON.parse(encoded);
assert.equal(JSON.parse(worker.match(/^const BUILD=(".*");$/m)[1]),hash(encoded).slice(0,20));
for(const {url,sha256} of records){assert(!url.includes('..'));assert.equal(hash(await readFile(new URL(url==='./'?'index.html':url,root))),sha256,url);}
for(const name of ['sohjae_editor.wasm','sohjae_collaborator.wasm','sohjae_render.wasm']){
 const bytes=await readFile(new URL('vendor/sohjae/'+name,root));
 const module=await WebAssembly.compile(bytes);assert.equal(WebAssembly.Module.imports(module).length,0);
}
const html=await readFile(new URL('index.html',root),'utf8');
assert(html.includes('Suhjae —'));assert(html.includes('data-editor-base="./vendor/sohjae/"'));
assert(html.includes('오프라인에서도 사용 가능'));assert(!html.includes('href="./sohjae_collaborator/"'));
for(const name of ['app.js','app.css','store.js','browser-sync.js','offline.js','export-zip.js'])assert.equal(await readFile(new URL(name,root),'utf8'),await readFile(new URL('../web/app/'+name,import.meta.url),'utf8'));
console.log(`Site: ${records.length} offline assets, three WASM modules and app copies verified.`);
