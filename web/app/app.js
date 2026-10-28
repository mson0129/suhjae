import {exportWorkspaceZip} from './export-zip.js';
import './offline.js';
import {STORAGE_KEY as DEFAULT_STORAGE_KEY,initialWorkspace,validate,addNode,moveNode,removeNode,documentFilename,importMarkdown} from './store.js';
import {BrowserSync} from './browser-sync.js';
const STORAGE_KEY=document.body.dataset.storageKey||DEFAULT_STORAGE_KEY;
const $=s=>document.querySelector(s),splash=$('#splash'),workspace=$('#workspace'),tree=$('#tree'),menu=$('#menu');
let data,editor,renderer,loading=false,renaming=null,dragging=null,saveTimer,blocked=false,started=false,storageRaw=null,sync=null,sdk=null,editorDocumentId=null,mountQueue=Promise.resolve(),renderingTree=false;
const asset=kind=>new URL(document.body.dataset[kind+'Base'],document.baseURI);
function notice(message){$('#notice').hidden=!message;$('#notice').textContent=message;}
try{storageRaw=localStorage.getItem(STORAGE_KEY);data=storageRaw?validate(JSON.parse(storageRaw)):initialWorkspace();}catch(error){data=initialWorkspace();blocked=true;notice('저장소를 읽을 수 없습니다. 기존 데이터를 덮어쓰지 않습니다. '+error.message);}
function restoreView(){try{const view=JSON.parse(sessionStorage.getItem(STORAGE_KEY+':view')||'null');if(view){for(const key of ['layout','mode','syncScroll','appearance','readingTheme'])if(key in view)data[key]=view[key];if(data.nodes.some(n=>n.id===view.active&&n.type==='document'))data.active=view.active;validate(data);}}catch{}}
restoreView();
function persist(broadcast=true){clearTimeout(saveTimer);if(blocked){$('#save-state').textContent='저장할 수 없음';return false;}try{
 try{sessionStorage.setItem(STORAGE_KEY+':view',JSON.stringify(Object.fromEntries(['active','layout','mode','syncScroll','appearance','readingTheme'].map(key=>[key,data[key]]))));}catch{}
 if(sync){const saved=sync.commit(data,broadcast);storageRaw=JSON.stringify(saved);data._sync=saved._sync;data.revision=saved.revision;}
 else{data.revision++;storageRaw=JSON.stringify(data);localStorage.setItem(STORAGE_KEY,storageRaw);}
 $('#save-state').textContent='저장됨 · 탭 동기화';return true;
 }catch(error){$('#save-state').textContent='저장 실패';notice('브라우저 저장 공간을 확인해 주세요. 문서 메뉴에서 다운로드할 수 있습니다. '+error.message);return false;}}
const active=()=>data.nodes.find(n=>n.id===data.active&&n.type==='document');
function capture(){if(editor&&!loading&&active()&&editorDocumentId===data.active){active().markdown=(editor.get_pending_draft()??editor.get_markdown({normalize:false}));} }
function saveSoon(){capture();renderSearch();$('#save-state').textContent='저장 중…';clearTimeout(saveTimer);saveTimer=setTimeout(persist,250);}
function preview(){if(renderer&&active()){
 const scroller=$('#preview-scroll'),top=scroller.scrollTop;$('#preview').innerHTML=renderer.render(active().markdown);buildToc();scroller.scrollTop=top;
}}
function buildToc(){const links=$('#toc-links');links.replaceChildren();const headings=[...$('#preview').querySelectorAll('h1,h2,h3,h4,h5,h6')];
 const ids=new Set();headings.forEach((heading,index)=>{let id=heading.id||'sohjae-heading-'+index;while(ids.has(id))id+='-'+index;ids.add(id);heading.id=id;const button=document.createElement('button');button.type='button';button.textContent=heading.textContent;button.style.paddingLeft=8+(Number(heading.tagName[1])-1)*12+'px';button.dataset.heading=heading.id;button.onclick=()=>{const scroller=$('#preview-scroll');scroller.scrollTo({top:heading.getBoundingClientRect().top-scroller.getBoundingClientRect().top+scroller.scrollTop-18,behavior:'smooth'});};links.append(button);});
 if(!headings.length){const empty=document.createElement('p');empty.textContent='제목을 추가하면 목차가 표시됩니다.';links.append(empty);}updateToc();
}
function updateToc(){const scroller=$('#preview-scroll'),viewport=scroller.getBoundingClientRect(),visible=new Set([...$('#preview').querySelectorAll('h1,h2,h3,h4,h5,h6')].filter(h=>{const rect=h.getBoundingClientRect();return rect.bottom>viewport.top&&rect.top<viewport.bottom;}).map(h=>h.id));
 for(const button of $('#toc-links').querySelectorAll('button')){const active=visible.has(button.dataset.heading);button.classList.toggle('current',active);if(active)button.setAttribute('aria-current','true');else button.removeAttribute('aria-current');}}
let scrollFrame=0;const programmed=new WeakMap();
function syncFrom(source){if(!editor||['full','read'].includes(data.layout)||!data.syncScroll)return;const expected=programmed.get(source);if(expected!==undefined&&Math.abs(source.scrollTop-expected)<2)return;programmed.delete(source);cancelAnimationFrame(scrollFrame);scrollFrame=requestAnimationFrame(()=>{const editing=editor.source_view?editor.source_input:editor.surface,target=source===$('#preview-scroll')?editing:$('#preview-scroll');const max=source.scrollHeight-source.clientHeight,ratio=max>0?source.scrollTop/max:0,top=ratio*Math.max(0,target.scrollHeight-target.clientHeight);programmed.set(target,top);target.scrollTop=top;});}

let starting=null;
function start(){return starting??=boot().finally(()=>{starting=null;});}
async function boot(){if(started){splash.hidden=true;workspace.hidden=false;return;}started=true;$('#start').disabled=true;$('#start').textContent='작업 공간 준비 중…';try{const [editorModule,{create_renderer},core]=await Promise.all([import(new URL('editor.js',asset('editor'))),import(new URL('renderer.js',asset('renderer'))),import(new URL('collab/core.js',asset('editor')))]);sdk=editorModule;renderer=await create_renderer();
 // Re-read storage after async loading so simultaneous first visits share one seed.
 const current=localStorage.getItem(STORAGE_KEY);if(current)data=validate(JSON.parse(current));restoreView();
 sync=new BrowserSync({key:STORAGE_KEY,data,core,onRemote:async manager=>{
  const selected=data.active;data.nodes=manager.nodes(data);if(!active())data.active=data.nodes.find(n=>n.type==='document')?.id??null;
  if(editor&&editorDocumentId===data.active&&active())active().markdown=(editor.get_pending_draft()??editor.get_markdown({normalize:false}));
  manager.observe(data);persist(false);renderTree();title();if(selected!==data.active||editorDocumentId!==data.active)await showActive();else preview();
 },onError:error=>notice('탭 동기화 오류: '+error.message)});
 // Seed the shared state before exposing an editable document.
 persist();await showActive();$('#start').disabled=false;$('#start').textContent='편집 시작하기 >';splash.hidden=true;workspace.hidden=false;if(innerWidth<650)document.body.classList.add('sidebar-hidden');
 }catch(error){started=false;$('#start').disabled=false;$('#start').textContent='다시 시작하기 >';const p=document.createElement('p');p.textContent='편집기를 불러오지 못했습니다. '+error.message;$('#start').after(p);}}
async function mountActive(){const node=active();if(!node){editor?.destroy();editor=null;editorDocumentId=null;loading=false;renderTree();applyAppearance();return;}if(editorDocumentId===node.id&&editor){preview();return;}
 loading=true;$('#editor').style.visibility='hidden';editor?.destroy();editor=null;editorDocumentId=null;
 const replica=await sync.replica(node);if(data.active!==node.id)return;
 editor=await sdk.create_editor($('#editor'),{replica,mode:data.mode,filename:documentFilename(node.name)});if(data.active!==node.id){editor.destroy();editor=null;return;}editorDocumentId=node.id;node.markdown=(editor.get_pending_draft()??editor.get_markdown({normalize:false}));
 const style=document.createElement('style');style.textContent=`:host{height:100%;--content_max_width:850px;--body_font_size:16px;--text_color:#333b30}.markdown_editor{height:100%;border:0;border-radius:0;box-shadow:none;display:flex;flex-direction:column}header{background:#fff;border-color:#eeeee7}.toolbar{padding:8px 22px;gap:1px}.toolbar button{color:#748269;font-size:11px;min-height:28px}button[data-command="save_local"],button[data-command="load_local"],button[data-command="save_session"],button[data-command="load_session"]{display:none}.view_bar{padding:5px 24px;background:#fafbf7}.view_bar [data-view],.view_bar .state{display:none}.surface,.source{flex:1;min-height:0;max-height:none;height:100%;resize:none;padding:32px max(40px,calc((100% - 790px)/2)) 80px}.surface{line-height:1.85}.footer{flex:none} :host([data-split]) .view_bar{display:none} :host([data-split]) .surface,:host([data-split]) .source{padding:24px 32px 70px}`;style.textContent+=`:host([data-dark]){--text_color:#dce1d8;--background_color:#1c211d;color-scheme:dark}.source{color:var(--text_color)}:host([data-dark]) header,:host([data-dark]) .view_bar{background:#202621;border-color:#343e33}:host([data-dark]) .toolbar button,:host([data-dark]) select{color:#b4c5a6}:host([data-dark]) .source{background:#1b211c;color:#dce1d8}:host([data-dark]) table th,:host([data-dark]) pre,:host([data-dark]) code{background:#293229;color:#d5dfcf}:host([data-dark]) td,:host([data-dark]) th{border-color:#46523e}:host([data-dark]) blockquote{background:#242e25;color:#b8c8b1}:host([data-dark]) mark{background:#626035;color:#fff3b4}`;editor.root.append(style);
 editor.addEventListener('change',()=>{if(loading||editorDocumentId!==data.active)return;saveSoon();preview();});editor.addEventListener('error',e=>notice(e.detail?.message||'편집 오류가 발생했습니다.'));
 editor.root.querySelector('select').addEventListener('change',()=>{if(data.layout==='full'){data.mode=editor.options.mode;persist();}});
 for(const source of [editor.surface,editor.source_input])source.addEventListener('scroll',()=>syncFrom(source),{passive:true});
 $('#sync-scroll').checked=data.syncScroll;$('#layout').value=data.layout;loading=false;$('#editor').style.visibility='';renderTree();title();applyLayout();persist();
}
function renderTree(){renderSearch();const renameValue=renaming?tree.querySelector('.rename-input')?.value:null;renderingTree=true;tree.replaceChildren();const draw=(parent,depth)=>{for(const node of data.nodes.filter(n=>n.parent===parent)){const row=document.createElement('div');row.className='tree-row'+(node.id===data.active?' active':'');row.dataset.id=node.id;row.style.paddingLeft=8+depth*17+'px';row.draggable=false;row.setAttribute('role','treeitem');row.setAttribute('aria-level',depth+1);row.setAttribute('aria-label',node.name);row.tabIndex=node.id===data.active?0:-1;if(node.type==='folder')row.setAttribute('aria-expanded',!!node.open);else row.setAttribute('aria-selected',node.id===data.active);
 const toggle=document.createElement('button');toggle.className='twisty';toggle.textContent=node.type==='folder'?(node.open?'⌄':'›'):'';toggle.setAttribute('aria-label',node.type==='folder'?(node.open?'폴더 접기':'폴더 펼치기'):'문서');toggle.tabIndex=node.type==='folder'?0:-1;toggle.onclick=()=>{if(node.type==='folder'){node.open=!node.open;persist();renderTree();}};row.append(toggle);
 const icon=document.createElement('span');icon.className='node-icon';icon.textContent=node.type==='folder'?'📁':'📄';icon.setAttribute('aria-hidden','true');row.append(icon);
 if(node.id===renaming){const input=document.createElement('input');input.className='rename-input';input.value=renameValue??node.name;input.maxLength=255;input.setAttribute('aria-label','이름 입력');let finished=false;const finish=cancel=>{if(finished)return;finished=true;if(!cancel&&input.value.trim())node.name=input.value.trim();renaming=null;persist();renderTree();title();};input.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();finish(false);}if(e.key==='Escape'){e.preventDefault();finish(true);}};input.onblur=()=>{if(!renderingTree)finish(false);};row.append(input);queueMicrotask(()=>{input.focus();input.select();});}
 else{const name=document.createElement('button');name.className='node-name';name.textContent=node.name;name.onclick=()=>node.type==='folder'?toggle.click():openDocument(node.id);name.ondblclick=()=>rename(node.id);row.append(name);const more=document.createElement('button');more.className='node-more';more.textContent='···';more.setAttribute('aria-label',node.name+' 메뉴');more.setAttribute('aria-haspopup','menu');more.onclick=e=>{e.stopPropagation();openMenu(more,node);};row.append(more);}
 row.onkeydown=e=>{if(e.target.tagName==='INPUT')return;if(e.key==='F2'){e.preventDefault();rename(node.id);}if(e.altKey&&['ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();const siblings=data.nodes.filter(n=>n.parent===node.parent),index=siblings.indexOf(node),target=siblings[index+(e.key==='ArrowUp'?-1:1)];if(target){moveNode(data,node.id,target.id,e.key==='ArrowUp'?'before':'after');persist();renderTree();}}};
 row.oncontextmenu=e=>{if(e.target.closest('input'))return;e.preventDefault();openMenu(row,node,{x:e.clientX,y:e.clientY});};
 row.onpointerdown=e=>{if(e.button===0&&node.id!==renaming&&!e.target.closest('.node-more,.twisty,input'))pointerDrag={id:node.id,x:e.clientX,y:e.clientY};};
 tree.append(row);if(node.type==='folder'&&node.open)draw(node.id,depth+1);}};draw(null,0);renderingTree=false;}
function renderSearch(){
 const query=$('#search-documents').value.trim(),results=$('#search-results');tree.hidden=!!query;results.hidden=!query;$('#clear-search').hidden=!query;
 const items=$('#search-items');items.replaceChildren();if(!query)return;
 const needle=query.toLocaleLowerCase(),matches=data.nodes.filter(node=>node.type==='document'&&(node.name.toLocaleLowerCase().includes(needle)||(node.markdown||'').toLocaleLowerCase().includes(needle)));
 $('#search-count').textContent=matches.length?matches.length+'개 문서':'검색 결과가 없습니다.';
 const highlight=(element,text)=>{const at=text.toLocaleLowerCase().indexOf(needle);if(at<0){element.textContent=text;return;}element.append(document.createTextNode(text.slice(0,at)));const mark=document.createElement('mark');mark.textContent=text.slice(at,at+query.length);element.append(mark,document.createTextNode(text.slice(at+query.length)));};
 for(const node of matches){const button=document.createElement('button');button.className='search-result'+(node.id===data.active?' active':'');
 const name=document.createElement('strong');highlight(name,node.name);const path=document.createElement('small');let parent=node.parent,parts=[],seen=new Set();while(parent&&!seen.has(parent)){seen.add(parent);const folder=data.nodes.find(n=>n.id===parent);if(!folder)break;parts.unshift(folder.name);parent=folder.parent;}path.textContent=parts.join(' / ')||'웹 브라우저 저장소';
 const excerpt=document.createElement('span'),source=node.markdown||'',at=source.toLocaleLowerCase().indexOf(needle),start=Math.max(0,at-28);highlight(excerpt,(start?'…':'')+source.slice(start,start+120).replace(/\s+/g,' ')+(source.length>start+120?'…':''));
 button.append(name,path,excerpt);button.onclick=()=>openDocument(node.id);items.append(button);}
}
$('#search-documents').oninput=()=>{capture();renderSearch();};
$('#search-documents').onkeydown=e=>{if(e.key==='Escape'){$('#clear-search').click();}if(e.key==='Enter'){$('#search-items button')?.click();}};
$('#clear-search').onclick=()=>{$('#search-documents').value='';renderSearch();$('#search-documents').focus();};
function clearDrops(){tree.querySelectorAll('[data-drop],.dragging').forEach(row=>{delete row.dataset.drop;row.classList.remove('dragging');});delete tree.dataset.drop;}
function rename(id){closeMenu();renaming=id;renderTree();}
function title(){if(editor&&editorDocumentId===data.active&&active()&&editor.options.filename!==documentFilename(active().name))editor.set_options({filename:documentFilename(active().name)});$('#doc-title').textContent=active()?.name??'문서 없음';$('#doc-title').disabled=!active();}
function showActive(){title();const exists=!!active();$('#panes').hidden=!exists;$('#empty').hidden=exists;$('#layout').disabled=!exists;mountQueue=mountQueue.then(mountActive).catch(error=>{loading=false;$('#editor').style.visibility='';notice('문서를 열지 못했습니다. '+error.message);});return mountQueue;}
function openDocument(id){capture();data.active=id;persist();renderTree();showActive();if(innerWidth<650)document.body.classList.add('sidebar-hidden');}
function create(parent,type){capture();const node=addNode(data,parent,type);if(type==='document')data.active=node.id;persist();closeMenu();showActive();rename(node.id);}
function openMenu(anchor,node,point){menu.replaceChildren();const add=(label,run,css='')=>{const b=document.createElement('button');b.type='button';b.role='menuitem';b.textContent=label;b.className=css;b.onclick=()=>{closeMenu();run();};menu.append(b);};if(!node||node.type==='folder'){add('폴더 추가하기',()=>create(node?.id??null,'folder'));add('문서 추가하기',()=>create(node?.id??null,'document'));}if(!node)add('업로드하기',()=>{const input=$('#upload-files');input.value='';input.click();});if(!node)add('전체 문서 내보내기',exportAllDocuments);if(node?.type==='document')add('다운로드하기',()=>downloadDocument(node.id));if(node){add('이름 변경하기',()=>rename(node.id));add('삭제하기',()=>askDelete(node),'delete');}menu.hidden=false;const rect=anchor.getBoundingClientRect();menu.style.left=Math.max(8,Math.min(point?.x??rect.right,innerWidth-menu.offsetWidth-8))+'px';menu.style.top=Math.max(8,Math.min(point?.y??rect.bottom+5,innerHeight-menu.offsetHeight-8))+'px';menu.querySelector('button').focus();}
function closeMenu(){menu.hidden=true;}
function askDelete(node){const dialog=$('#confirm');$('#confirm-message').textContent=node.type==='folder'?'폴더 안의 모든 항목이 삭제됩니다. 계속하시겠습니까?':'이 문서를 삭제하시겠습니까?';dialog.dataset.id=node.id;dialog.showModal();}
$('#confirm').addEventListener('close',()=>{if($('#confirm').returnValue!=='yes')return;capture();removeNode(data,$('#confirm').dataset.id);persist();renderTree();showActive();});
function applyLayout(){if(!editor)return;capture();const reading=data.layout==='read',split=!['full','read'].includes(data.layout);$('#panes').classList.toggle('reading',reading);$('#editor-pane').hidden=reading;$('#reading-theme-label').hidden=!reading;$('#panes').classList.toggle('split',split);$('#preview-pane').hidden=!(split||reading);$('#sync-label').hidden=!split;$('#editor').toggleAttribute('data-split',split);if(editor.source_view!==(data.layout==='source'))editor.set_view('source');if(editor.reading)editor.set_view('reading');editor.set_options({mode:data.layout==='full'?data.mode:'markdown'});$('#edit-label').textContent=data.layout==='source'?'MARKDOWN SOURCE':data.layout==='markdown'?'MARKDOWN EDITOR':'YOUR DOCUMENT';applyAppearance();preview();programmed.delete(editor.surface);programmed.delete(editor.source_input);programmed.delete($('#preview-scroll'));syncFrom(editor.source_view?editor.source_input:editor.surface);}
$('#layout').onchange=()=>{data.layout=$('#layout').value;applyLayout();persist();};$('#start').onclick=start;$('#home').onclick=()=>{capture();persist();workspace.hidden=true;splash.hidden=false;};$('#add').onclick=()=>openMenu($('#add'),null);$('#empty-add').onclick=()=>create(null,'document');$('#doc-title').onclick=()=>active()&&rename(active().id);$('#toggle-sidebar').onclick=()=>document.body.classList.toggle('sidebar-hidden');
function exportAllDocuments(){capture();persist();try{const blob=exportWorkspaceZip(data.nodes),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='suhjae-documents-'+new Date().toISOString().slice(0,10)+'.zip';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(error){notice('내보내기 실패: '+error.message);}}
function downloadDocument(id=data.active){capture();const node=data.nodes.find(n=>n.id===id&&n.type==='document');if(!node)return;persist();const url=URL.createObjectURL(new Blob([node.markdown],{type:'text/markdown;charset=utf-8'})),a=document.createElement('a');a.href=url;a.download=documentFilename(node.name);a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
document.addEventListener('keydown',e=>{if(!workspace.hidden&&(e.ctrlKey||e.metaKey)&&!e.altKey&&!e.shiftKey&&(e.code==='KeyS'||e.key.toLowerCase()==='s')){e.preventDefault();e.stopImmediatePropagation();if(!e.isComposing)downloadDocument();}},true);
document.addEventListener('pointerdown',e=>{if(!menu.contains(e.target)&&e.target!==$('#add')&&!e.target.closest('.node-more'))closeMenu();});document.addEventListener('keydown',e=>{if(e.key==='Escape')closeMenu();if(!menu.hidden&&['ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();const buttons=[...menu.querySelectorAll('button')],at=buttons.indexOf(document.activeElement);buttons[(at+(e.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length].focus();}});
window.addEventListener('pagehide',()=>{capture();if(started)persist();});window.addEventListener('beforeunload',()=>{capture();if(started)persist();});
// Renderer output uses its built-in sanitization; external links open separately.
$('#preview').addEventListener('click',e=>{const link=e.target.closest('a');if(link&&!link.getAttribute('href')?.startsWith('#')){e.preventDefault();if(/^https?:/i.test(link.href))window.open(link.href,'_blank','noopener,noreferrer');}});
if(document.body.dataset.editorBase==='../'){$('[data-demo]').href='../collab/rich.html';}

// Pointer-driven layer movement also works when the drag begins on a name button.
let pointerDrag=null,pointerTarget=null,suppressClick=false;
document.addEventListener('pointermove',e=>{
 if(!pointerDrag)return;
 if(!dragging&&Math.hypot(e.clientX-pointerDrag.x,e.clientY-pointerDrag.y)<5)return;
 dragging=pointerDrag.id;suppressClick=true;closeMenu();clearDrops();
 tree.querySelector('[data-id="'+dragging+'"]')?.classList.add('dragging');
 const hit=document.elementFromPoint(e.clientX,e.clientY),row=hit?.closest('.tree-row');pointerTarget=null;
 if(row&&row.dataset.id!==dragging){const node=data.nodes.find(n=>n.id===row.dataset.id),ratio=(e.clientY-row.getBoundingClientRect().top)/row.offsetHeight,position=node.type==='folder'&&ratio>.25&&ratio<.75?'inside':ratio<.5?'before':'after';row.dataset.drop=position;pointerTarget={id:node.id,position};}
 else if(hit===tree){tree.dataset.drop='root';pointerTarget={id:null,position:'inside'};}
});
document.addEventListener('pointerup',()=>{if(pointerDrag&&dragging&&pointerTarget&&moveNode(data,dragging,pointerTarget.id,pointerTarget.position)){persist();renderTree();}pointerDrag=null;pointerTarget=null;dragging=null;clearDrops();setTimeout(()=>suppressClick=false,0);});
document.addEventListener('pointercancel',()=>{pointerDrag=null;pointerTarget=null;dragging=null;suppressClick=false;clearDrops();});
document.addEventListener('click',e=>{if(suppressClick){e.preventDefault();e.stopImmediatePropagation();}},true);

$('#preview-scroll').addEventListener('scroll',()=>{updateToc();syncFrom($('#preview-scroll'));},{passive:true});
$('#sync-scroll').onchange=()=>{data.syncScroll=$('#sync-scroll').checked;programmed.delete($('#preview-scroll'));if(editor){programmed.delete(editor.surface);programmed.delete(editor.source_input);}persist();};

let fileDragDepth=0;
const externalFiles=e=>[...(e.dataTransfer?.types||[])].includes('Files');
window.addEventListener('dragenter',e=>{if(externalFiles(e)){e.preventDefault();fileDragDepth++;document.body.classList.add('file-drop');}},true);
window.addEventListener('dragleave',e=>{if(externalFiles(e)&&--fileDragDepth<=0){fileDragDepth=0;document.body.classList.remove('file-drop');}},true);
window.addEventListener('dragover',e=>{if(externalFiles(e)){e.preventDefault();e.dataTransfer.dropEffect='copy';}},true);
window.addEventListener('drop',async e=>{
 if(!externalFiles(e))return;const files=[...e.dataTransfer.files].filter(file=>/\.md$/iu.test(file.name));fileDragDepth=0;document.body.classList.remove('file-drop');
 if(!files.length&&e.composedPath().includes($('#editor')))return;
 e.preventDefault();e.stopImmediatePropagation();
 if(!files.length){if(editor)notice('.md 파일을 드롭하면 문서함에 추가됩니다.');return;}
 const folder=e.composedPath().find(node=>node instanceof HTMLElement&&node.matches('.tree-row'))?.dataset.id;
 await importFiles(files,folder);
},true);
async function importFiles(files,folder=null){
 files=[...files].filter(file=>/\.md$/iu.test(file.name));if(!files.length)return;
 try{if(!editor){await start();await mountQueue;}if(!editor)throw Error('편집기를 불러오지 못했습니다.');capture();const incoming=[],errors=[];
  for(const file of files){try{if(file.size>32*1024*1024)throw Error('32 MiB 이하 파일을 사용해 주세요.');incoming.push({name:file.name,markdown:new TextDecoder('utf-8',{fatal:true}).decode(await file.arrayBuffer())});}catch(error){errors.push(file.name+': '+error.message);}}
  const parent=data.nodes.some(n=>n.id===folder&&n.type==='folder')?folder:null;
  const added=importMarkdown(data,parent,incoming);if(added.length){persist();renderTree();await showActive();}
  if(errors.length)notice('일부 파일을 불러오지 못했습니다. '+errors.join(' / '));
 }catch(error){notice('파일을 불러오지 못했습니다. '+error.message);}
}
$('#upload-files').addEventListener('change',event=>{const files=[...event.target.files];event.target.value='';void importFiles(files);});

function applyAppearance(){document.body.dataset.appearance=data.appearance;document.body.dataset.readingTheme=data.readingTheme;$('#appearance').textContent=data.appearance==='dark'?'☀':'◐';$('#appearance').setAttribute('aria-label',data.appearance==='dark'?'라이트모드 켜기':'다크모드 켜기');$('#appearance').setAttribute('aria-pressed',String(data.appearance==='dark'));$('#reading-theme').value=data.readingTheme;if(editor)editor.container.toggleAttribute('data-dark',data.appearance==='dark');requestAnimationFrame(updateToc);}
$('#appearance').onclick=()=>{data.appearance=data.appearance==='dark'?'light':'dark';applyAppearance();persist();};$('#reading-theme').onchange=()=>{data.readingTheme=$('#reading-theme').value;applyAppearance();persist();};window.addEventListener('resize',updateToc);applyAppearance();

// Print a semantic copy, independent of editor layout, theme and scroll position.
window.addEventListener('beforeprint',()=>{capture();const node=active();$('#print-document').innerHTML=renderer&&node?renderer.render(node.markdown):'';});
window.addEventListener('afterprint',()=>$('#print-document').replaceChildren());
