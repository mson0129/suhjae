import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {exportWorkspaceZip} from '../web/app/export-zip.js';
const nodes=[{id:'f',parent:null,type:'folder',name:'한글 폴더'},{id:'e',parent:'f',type:'folder',name:'빈 폴더'},{id:'a',parent:'f',type:'document',name:'기록',markdown:'# 한글😀\n\n**원문**'},{id:'b',parent:'f',type:'document',name:'기록.md',markdown:'중복 이름'},{id:'c',parent:null,type:'document',name:'../escape.md',markdown:'안전한 경로'}];
const original=JSON.stringify(nodes),zip=exportWorkspaceZip(nodes,new Date(2026,9,28)),bytes=new Uint8Array(await zip.arrayBuffer()),view=new DataView(bytes.buffer);assert.equal(JSON.stringify(nodes),original);assert.equal(view.getUint32(bytes.length-22,true),0x06054b50);assert.equal(view.getUint16(bytes.length-12,true),5);
let offset=0,count=0;while(view.getUint32(offset,true)===0x04034b50){assert.equal(view.getUint16(offset+8,true),0,'STORE compression');assert.equal(view.getUint16(offset+6,true),0x800,'UTF-8');const length=view.getUint16(offset+26,true),size=view.getUint32(offset+18,true);offset+=30+length+size;count++;}assert.equal(count,5);assert.equal((await exportWorkspaceZip([]).arrayBuffer()).byteLength,22);
if(process.argv[2])await writeFile(process.argv[2],bytes);
console.log('ZIP STORE, UTF-8 names, nested/empty folders, duplicate names and empty archive verified.');
