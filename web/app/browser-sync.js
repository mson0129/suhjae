// Same-origin browser collaboration. Content uses Sohjae CRDT; metadata uses
// per-field Lamport registers and permanent deletion tombstones.
const encode=bytes=>{let text='';for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(text);};
const decode=text=>Uint8Array.from(atob(text),c=>c.charCodeAt(0));
const copy=value=>JSON.parse(JSON.stringify(value));
const newer=(a,b)=>!b||a[0]>b[0]||a[0]===b[0]&&a[1]>b[1];
const fields=['name','parent','type','open','rank'];
export class BrowserSync {
 constructor({key,data,core,onRemote,onError}){Object.assign(this,{key,core,onRemote,onError});this.actor=crypto.randomUUID();this.clock=0;this.records={};this.replicas=new Map();this.pending=new Map();this.states=new Map();this.sources=new Map();this.seen=new Map();this.queue=Promise.resolve();this.closed=false;
  this.channel=typeof BroadcastChannel==='function'?new BroadcastChannel(key+':sync'):null;
  this.channel?.addEventListener('message',e=>{if(e.data?.from!==this.actor&&e.data?.state)this.receive(e.data.state);});
  this.storage=e=>{if(e.key===key&&e.newValue){try{this.receive(JSON.parse(e.newValue));}catch(error){onError(error);}}};window.addEventListener('storage',this.storage);
  this.absorb(data);this.observe(data);
 }
 absorb(data){if(data._sync?.records){for(const [id,incoming]of Object.entries(data._sync.records)){const record=this.records[id]??={};for(const [key,value]of Object.entries(incoming)){if(!value||!Array.isArray(value.stamp))continue;this.clock=Math.max(this.clock,value.stamp[0]);if(newer(value.stamp,record[key]?.stamp))record[key]=copy(value);}}}
  else for(const [rank,node]of data.nodes.entries()){const record=this.records[node.id]??={};for(const field of fields)record[field]??={value:field==='rank'?rank:node[field]??null,stamp:[0,'']};}
  for(const node of data.nodes){if(node.type==='document'&&!this.sources.has(node.id))this.sources.set(node.id,node.markdown||'');if(node.collab)this.states.set(node.id,node.collab);}
 }
 observe(data){this.seen=new Map(data.nodes.map((n,rank)=>[n.id,Object.fromEntries(fields.map(field=>[field,field==='rank'?rank:n[field]??null]))]));}
 async replica(node){if(this.replicas.has(node.id))return this.replicas.get(node.id);if(this.pending.has(node.id))return this.pending.get(node.id);
  const task=(async()=>{const document_id=node.id.replaceAll('-','');const replica=await this.core.create_replica({document_id});const bytes=this.states.get(node.id)||node.collab;
   if(bytes)replica.merge(decode(bytes));else{const seed=await this.core.create_replica({document_id,actor_id:document_id});try{if(node.markdown)seed.import_markdown(node.markdown);replica.merge(seed.export_state());}finally{seed.destroy();}}
   replica.clear_local_history();this.replicas.set(node.id,replica);this.states.set(node.id,encode(replica.export_state()));
   replica.addEventListener('update',()=>{this.states.set(node.id,encode(replica.export_state()));});return replica;
  })();this.pending.set(node.id,task);try{return await task;}finally{this.pending.delete(node.id);}
 }
 nodes(local){const originals=new Map(local.nodes.map(n=>[n.id,n])),nodes=[];
  for(const [id,r]of Object.entries(this.records)){if(r.deleted?.value)continue;const value=key=>r[key]?.value;const type=value('type');if(!['document','folder'].includes(type))continue;const old=originals.get(id);const replica=this.replicas.get(id);nodes.push({id,type,name:value('name')||'제목 없음.md',parent:value('parent')??null,...(type==='folder'?{open:value('open')!==false}:{markdown:replica?.snapshot.markdown??old?.markdown??this.sources.get(id)??'',collab:this.states.get(id)||old?.collab}),_rank:value('rank')??0});}
  const folders=new Set(nodes.filter(n=>n.type==='folder').map(n=>n.id));for(const node of nodes){const visited=new Set([node.id]);let p=node.parent;while(p!==null){if(!folders.has(p)||visited.has(p)){node.parent=null;break;}visited.add(p);p=nodes.find(n=>n.id===p)?.parent??null;}}
  nodes.sort((a,b)=>a._rank-b._rank||a.id.localeCompare(b.id));for(const n of nodes)delete n._rank;return nodes;
 }
 snapshot(local){return {...local,nodes:this.nodes(local),_sync:{records:copy(this.records)}};}
 commit(local,broadcast=true){const updates=[];for(const [rank,node]of local.nodes.entries()){const previous=this.seen.get(node.id);for(const field of fields){const value=field==='rank'?rank:node[field]??null;if(!previous||JSON.stringify(previous[field])!==JSON.stringify(value))updates.push([node.id,field,value]);}}
  for(const id of this.seen.keys())if(!local.nodes.some(n=>n.id===id))updates.push([id,'deleted',true]);
  const stored=localStorage.getItem(this.key);if(stored){const incoming=JSON.parse(stored);this.absorb(incoming);for(const node of incoming.nodes||[]){const replica=this.replicas.get(node.id);if(replica&&node.collab)replica.merge(decode(node.collab));}}
  for(const [id,field,value]of updates){(this.records[id]??={})[field]={value,stamp:[++this.clock,this.actor]};}
  // Never replace a live CRDT with an older snapshot absorbed from storage.
  for(const [id,replica]of this.replicas)this.states.set(id,encode(replica.export_state()));
  const state=this.snapshot(local);state.revision=(local.revision||0)+1;localStorage.setItem(this.key,JSON.stringify(state));this.observe(local);if(broadcast)this.channel?.postMessage({from:this.actor,state});return state;
 }
 receive(state){this.queue=this.queue.then(async()=>{if(this.closed||!Array.isArray(state.nodes))return;this.absorb(state);
   for(const node of state.nodes){if(!node.collab)continue;const replica=await this.replica(node);replica.merge(decode(node.collab));this.states.set(node.id,encode(replica.export_state()));}
   const after=JSON.stringify([this.records,[...this.states].sort()]);if(this.received===after)return;this.received=after;
   await this.onRemote(this); // UI preserves the active document and CRDT selection.
  }).catch(this.onError);}
 close(){this.closed=true;window.removeEventListener('storage',this.storage);this.channel?.close();for(const replica of this.replicas.values())replica.destroy();}
}
