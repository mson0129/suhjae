import {documentFilename} from './store.js';
const encoder=new TextEncoder();
const table=Uint32Array.from({length:256},(_,n)=>{for(let i=0;i<8;i++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
function crc32(bytes){let crc=0xffffffff;for(const byte of bytes)crc=table[(crc^byte)&255]^(crc>>>8);return (crc^0xffffffff)>>>0;}
function safeName(name){return String(name).normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/[. ]+$/g,'')||'Untitled';}
// ZIP method 0 (STORE), UTF-8 names; no compression library or network required.
export function exportWorkspaceZip(nodes,date=new Date()){
 const entries=[],visited=new Set();
 function walk(parent,prefix){const used=new Set();for(const node of nodes.filter(n=>n.parent===parent)){
  if(visited.has(node.id))continue;visited.add(node.id);
  const base=safeName(node.type==='document'?documentFilename(node.name):node.name);let name=base,index=2;
  while(used.has(name.toLocaleLowerCase())){const dot=node.type==='document'?base.lastIndexOf('.'):-1;name=dot>0?base.slice(0,dot)+' ('+(index++)+')'+base.slice(dot):base+' ('+(index++)+')';}used.add(name.toLocaleLowerCase());
  const path=prefix+name+(node.type==='folder'?'/':'');entries.push({path,bytes:node.type==='folder'?new Uint8Array():encoder.encode(node.markdown||''),folder:node.type==='folder'});
  if(node.type==='folder')walk(node.id,path);
 }}walk(null,'');
 if(entries.length>65535)throw Error('ZIP 파일의 항목 수 제한을 초과했습니다.');
 const year=Math.max(1980,Math.min(2107,date.getFullYear())),day=((year-1980)<<9)|((date.getMonth()+1)<<5)|date.getDate(),time=(date.getHours()<<11)|(date.getMinutes()<<5)|(date.getSeconds()>>1);
 const local=[],central=[];let offset=0,centralSize=0;
 for(const entry of entries){const name=encoder.encode(entry.path),size=entry.bytes.length,crc=crc32(entry.bytes);if(name.length>65535||size>0xffffffff)throw Error('ZIP 파일 크기 제한을 초과했습니다.');
  const header=new Uint8Array(30+name.length),view=new DataView(header.buffer);view.setUint32(0,0x04034b50,true);view.setUint16(4,20,true);view.setUint16(6,0x800,true);view.setUint16(10,time,true);view.setUint16(12,day,true);view.setUint32(14,crc,true);view.setUint32(18,size,true);view.setUint32(22,size,true);view.setUint16(26,name.length,true);header.set(name,30);local.push(header,entry.bytes);
  const record=new Uint8Array(46+name.length),v=new DataView(record.buffer);v.setUint32(0,0x02014b50,true);v.setUint16(4,20,true);v.setUint16(6,20,true);v.setUint16(8,0x800,true);v.setUint16(12,time,true);v.setUint16(14,day,true);v.setUint32(16,crc,true);v.setUint32(20,size,true);v.setUint32(24,size,true);v.setUint16(28,name.length,true);v.setUint32(38,entry.folder?16:0,true);v.setUint32(42,offset,true);record.set(name,46);central.push(record);centralSize+=record.length;offset+=header.length+size;
  if(offset+centralSize+22>0xffffffff)throw Error('ZIP 파일이 4GB 제한을 초과했습니다.');
 }
 const end=new Uint8Array(22),v=new DataView(end.buffer);v.setUint32(0,0x06054b50,true);v.setUint16(8,entries.length,true);v.setUint16(10,entries.length,true);v.setUint32(12,centralSize,true);v.setUint32(16,offset,true);
 return new Blob([...local,...central,end],{type:'application/zip'});
}
