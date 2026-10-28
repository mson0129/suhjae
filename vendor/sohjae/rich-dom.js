// Native rich surface: semantic HTML + a private DOM/source map. No text wrappers.
import {byte_length,byte_slice,utf16_to_byte,byte_to_utf16} from './core.js';
import {safe_url} from './clipboard.js';
const allowed=new Set('p h1 h2 h3 h4 h5 h6 strong em del mark sub sup code pre a img br hr ul ol li input table thead tbody tr th td blockquote dl dt dd details summary'.split(' '));
const aliases={b:'strong',i:'em',s:'del',strike:'del',div:'p'};
const text_escape=text=>text.replace(/&/gu,'&amp;').replace(/</gu,'&lt;').replace(/([\\`*_\[\]~^=|#>])/gu,'\\$1').replace(/\u00a0/gu,'&nbsp;');
function diff(before,after){let start=0,end=0;while(start<before.length&&start<after.length&&before[start]===after[start])start++;if(start&&/[\uD800-\uDBFF]/u.test(before[start-1]))start--;while(end<before.length-start&&end<after.length-start&&before.at(-end-1)===after.at(-end-1))end++;if(end&&/[\uDC00-\uDFFF]/u.test(before[before.length-end]))end--;return [start,before.length-end,after.slice(start,after.length-end)];}
export function validate_rich_tables(root){
 if(root.querySelector('td pre,th pre,td ul,th ul,td ol,th ol,td blockquote,th blockquote,td h1,th h1,td h2,th h2,td h3,th h3,td h4,th h4,td h5,th h5,td h6,th h6,td dl,th dl,td details,th details'))throw new Error('표 셀에는 Markdown 인라인 내용과 줄 바꿈만 사용할 수 있습니다.');
 if(root.querySelector('table table'))throw new Error('Markdown은 표 안의 표를 지원하지 않습니다.');
 if([...root.querySelectorAll('th,td')].some(cell=>cell.colSpan!==1||cell.rowSpan!==1))throw new Error('Markdown은 셀 병합을 지원하지 않습니다.');
}
export function sanitize_rich(root,preserve_metadata=false){
 validate_rich_tables(root);
 for(const node of [...root.querySelectorAll('*')]){
  if(node.matches('[data-column-handle],[data-row-handle],.break_mark,[data-caret]')){node.remove();continue;}
  let tag=node.localName;
  if(['script','style','iframe','object','embed','template','svg','math'].includes(tag)){node.remove();continue;}
  if(aliases[tag]){const replacement=document.createElement(aliases[tag]);for(const attr of [...node.attributes])replacement.setAttribute(attr.name,attr.value);replacement.append(...node.childNodes);node.replaceWith(replacement);tag=replacement.localName;}
 }
 for(const node of [...root.querySelectorAll('*')]){
  const tag=node.localName;
  if(!allowed.has(tag)){node.replaceWith(...node.childNodes);continue;}
  for(const attr of [...node.attributes]){
   const keep=tag==='a'&&['href','title','download','rel'].includes(attr.name)||tag==='img'&&['src','alt','title'].includes(attr.name)||tag==='input'&&['type','checked'].includes(attr.name)||tag==='ol'&&attr.name==='start'||tag==='code'&&attr.name==='data-language'||['th','td'].includes(tag)&&attr.name==='class'&&/^align_(left|center|right)$/u.test(attr.value);
   if(!keep&&!(['aria-label','scope'].includes(attr.name))&&!(preserve_metadata&&/^data-(start|end|block|kind|cell|row|column|task)$/u.test(attr.name)))node.removeAttribute(attr.name);
  }
  if(tag==='a'&&!safe_url(node.getAttribute('href')||''))node.removeAttribute('href');
  if(tag==='img'&&!safe_url(node.getAttribute('src')||'',true))node.replaceWith(document.createTextNode(node.getAttribute('alt')||''));
  if(tag==='input'&&(node.type!=='checkbox'||!node.closest('li')))node.remove();
 }
 return root;
}
// A serializer with source boundary points, not a whole-document replacement.
export function serialize_rich(root,metadata=new WeakMap(),selection=null){
 let out='',points=[],anchor=null,focus=null;
 const bounds=node=>metadata.get(node)||(node?.dataset?.start!==undefined?{start:Number(node.dataset.start),end:Number(node.dataset.end)}:{start:0,end:0});
 const mark=(node,offset)=>{if(selection?.anchorNode===node&&selection.anchorOffset===offset)anchor=out.length;if(selection?.focusNode===node&&selection.focusOffset===offset)focus=out.length;};
 const emit=(text,start,end)=>{points.push({at:out.length,raw:start});if(end-start===byte_length(text)){let chars=0,bytes=0;for(const char of text){chars+=char.length;bytes+=byte_length(char);points.push({at:out.length+chars,raw:start+bytes});}}out+=text;points.push({at:out.length,raw:end});};
 const separator=(node,text)=>emit(text,bounds(node).end,node.nextElementSibling?bounds(node.nextElementSibling).start:bounds(node).end);
 const content_bounds=node=>{const items=[...node.childNodes].filter(child=>child.nodeType===3||child.nodeType===1&&!child.matches('input,[data-row-handle],[data-column-handle]'));return {start:items.length?bounds(items[0]).start:bounds(node).start,end:items.length?bounds(items.at(-1)).end:bounds(node).end};};
 const children=(node,context={})=>{mark(node,0);[...node.childNodes].forEach((child,index)=>{walk(child,context);mark(node,index+1);});};
 const walk=(node,context={})=>{
  const range=bounds(node);
  if(node.nodeType===3){
   let offset=0;for(const char of node.data){mark(node,offset);const raw=range.text===node.data?range.start+byte_length(node.data.slice(0,offset)):offset?range.end:range.start;offset+=char.length;const end=range.text===node.data?range.start+byte_length(node.data.slice(0,offset)):range.end;emit(context.code?char:char==='\n'?'<br>':text_escape(char),raw,end);}mark(node,offset);return;
  }
  if(node.nodeType!==1)return;
  mark(node,0);
  const tag=node.localName;if(node.matches('[data-column-handle],[data-row-handle],.break_mark,[data-caret],[data-rich-placeholder]'))return;
  if(tag==='input')return;
  const inner=content_bounds(node),wrap=(open,close)=>{emit(open,range.start,inner.start);children(node,context);emit(close,inner.end,range.end);};
  if(['strong','b','em','i','del','s','mark','sub','sup'].includes(tag)){const syntax={strong:'**',b:'**',em:'*',i:'*',del:'~~',s:'~~',mark:'==',sub:'~',sup:'^'}[tag];if(node.textContent)wrap(syntax,syntax);else children(node,context);return;}
  if(tag==='a'){const href=node.getAttribute('href');if(href&&safe_url(href))wrap('[',`](${href.replace(/\(/gu,'%28').replace(/\)/gu,'%29')}${node.title?' "'+node.title.replace(/"/gu,'&quot;')+'"':''})`);else children(node,context);return;}
  if(tag==='img'){const src=node.getAttribute('src')||'';if(safe_url(src,true))emit(`![${(node.alt||'').replace(/[\[\]\\]/gu,'\\$&')}](${src})`,range.start,range.end);return;}
  if(tag==='br'){emit('<br>',range.start,range.end);return;}
  if(tag==='hr'){emit('---\n\n',range.start,range.end);return;}
  if(tag==='pre'){
   const code=node.querySelector('code')||node,text=code.textContent,ticks='`'.repeat(Math.max(3,...[...text.matchAll(/`+/gu)].map(m=>m[0].length+1)));
   emit(ticks+(code.dataset.language||'')+'\n',range.start,bounds(code.firstChild||code).start);children(code,{code:true});if(!out.endsWith('\n'))emit('\n',range.end,range.end);emit(ticks+'\n\n',range.end,range.end);return;
  }
  if(tag==='code'){const ticks='`'.repeat(Math.max(1,...[...node.textContent.matchAll(/`+/gu)].map(m=>m[0].length+1)));emit(ticks,range.start,inner.start);children(node,{code:true});emit(ticks,inner.end,range.end);return;}
  if(tag==='table'){
   validate_rich_tables(node);const rows=[...node.rows];
   rows.forEach((row,r)=>{mark(node,r);emit('| ',bounds(row).start,bounds(row.cells[0]||row).start);[...row.cells].forEach((cell,c)=>{const cellRange=bounds(cell);if(c)emit(' | ',bounds(row.cells[c-1]).end,cellRange.start);const before=out.length;children(cell,{cell:true});if(out.length===before)points.push({at:out.length,raw:cellRange.start});});emit(' |\n',bounds(row.cells[row.cells.length-1]||row).end,bounds(row).end);
    if(r===0){const alignment=[...row.cells].map(cell=>cell.classList.contains('align_center')?':---:':cell.classList.contains('align_right')?'---:':'---');emit('| '+alignment.join(' | ')+' |\n',bounds(row).end,rows[1]?bounds(rows[1]).start:range.end);}});emit('\n',range.end,range.end);return;
  }
  if(tag==='ul'||tag==='ol'){children(node,{...context,list:tag,number:Number(node.getAttribute('start')||1),depth:(context.depth??-1)+1});if(!context.list)separator(node,'\n');return;}
  if(tag==='li'){
   const siblings=[...node.parentElement.children],number=Number(node.parentElement.getAttribute('start')||1)+siblings.indexOf(node),box=node.querySelector(':scope > input[type="checkbox"]');
   emit('    '.repeat(context.depth||0)+(context.list==='ol'?number+'. ':'- ')+(box?(box.checked?'[x] ':'[ ] '):''),range.start,inner.start);
   children(node,{...context,item:true});if(!out.endsWith('\n'))separator(node,'\n');return;
  }
  if(tag==='blockquote'){
   // Quote prefix mapping is added to each source line after child serialization.
   const start=out.length;children(node,context);const text=out.slice(start).replace(/\n+$/u,'');
   const shifted=position=>{const offset=Math.min(Math.max(0,position-start),text.length);return start+offset+2*(1+(text.slice(0,offset).match(/\n/gu)||[]).length);};
   points=points.map(point=>point.at>=start?{...point,at:shifted(point.at)}:point);
   if(anchor!==null&&anchor>=start)anchor=shifted(anchor);if(focus!==null&&focus>=start)focus=shifted(focus);
   out=out.slice(0,start)+text.split('\n').map(line=>'> '+line).join('\n')+'\n\n';points.push({at:out.length,raw:range.end});return;
  }
  if(tag==='dl'||tag==='dt'||tag==='dd'){if(tag==='dd')emit(': ',range.start,inner.start);children(node,context);if(tag!=='dl')emit('\n',range.end,range.end);else separator(node,'\n');return;}
  if(tag==='details'||tag==='summary'){emit('<'+tag+'>',range.start,inner.start);children(node,context);emit('</'+tag+'>\n\n',inner.end,range.end);return;}
  if(/^h[1-6]$/u.test(tag))emit('#'.repeat(Number(tag[1]))+' ',range.start,inner.start);
  const empty=!node.textContent&&!node.querySelector('img,table,hr')&&['p','div'].includes(tag);
  if(empty)emit('&nbsp;',range.start,range.end);else children(node,context);
  if(['p','div'].includes(tag)||/^h[1-6]$/u.test(tag))separator(node,context.cell?'<br>':context.item?'\n':'\n\n');
 };
 mark(root,0);[...root.childNodes].forEach((node,index)=>{walk(node);mark(root,index+1);});out=out.replace(/\n+$/u,'');
 const raw_at=(position,bias='after')=>{const exact=points.filter(p=>p.at===position);if(exact.length)return (bias==='before'?exact[0]:exact.at(-1)).raw;const before=points.filter(p=>p.at<position).at(-1),after=points.find(p=>p.at>position);if(before&&after&&after.at-before.at===after.raw-before.raw)return before.raw+position-before.at;return (bias==='before'?before:after)?.raw??bounds(root).end;};
 return {markdown:out,raw_at,anchor:Math.min(anchor??out.length,out.length),focus:Math.min(focus??out.length,out.length)};
}
export class RichDOM {
 constructor(editor){
  this.editor=editor;this.metadata=new WeakMap();this.text_nodes=[];
  const on=(type,handler)=>editor.surface.addEventListener(type,event=>{if(!this.active)return;handler.call(this,event);},{capture:true,signal:editor.listeners.signal});
  on('beforeinput',this.before);on('input',this.input);on('compositionstart',this.composition_start);on('compositionend',this.composition_end);on('paste',this.paste);
 }
 get active(){const e=this.editor;return e.options.mode==='rich'&&!e.source_view&&!e.html_view&&!e.reading;}
 fill(template){
  const e=this.editor;this.metadata=new WeakMap();this.text_nodes=[];
  template.content.querySelectorAll('.comment,.front_matter,.reference_definition,[data-kind="comment"],.raw_block').forEach(node=>node.closest('section[data-block]')?.remove());
  template.content.querySelectorAll('input[data-task]').forEach(box=>{const gap=box.nextSibling;if(gap?.nodeType===3&&/^[ \t]*$/u.test(gap.textContent))gap.remove();});
  template.content.querySelectorAll('p').forEach(p=>{if(p.textContent==='\u00a0'&&!p.querySelector('img,input,br'))p.querySelectorAll('[data-text]').forEach(span=>span.textContent='');});
  for(const span of template.content.querySelectorAll('[data-text]')){if(!span.firstChild)span.append(document.createTextNode(''));const nodes=[...span.childNodes],start=Number(span.dataset.start),end=Number(span.dataset.end);for(const node of nodes){this.metadata.set(node,{start,end,text:node.textContent});this.text_nodes.push(node);}span.replaceWith(...nodes);}
  for(const node of template.content.querySelectorAll('[data-start]'))this.metadata.set(node,{start:Number(node.dataset.start),end:Number(node.dataset.end)});
  for(const wrapper of [...template.content.querySelectorAll('section[data-block],.table_scroll,[data-kind="image"]')].reverse()){
   const range=this.metadata.get(wrapper);for(const child of wrapper.children){if(wrapper.matches('[data-block]')){child.dataset.block='1';child.dataset.start=wrapper.dataset.start;child.dataset.end=wrapper.dataset.end;}if(!this.metadata.has(child))this.metadata.set(child,range);}
   wrapper.replaceWith(...wrapper.childNodes);
  }
  for(const node of [...template.content.querySelectorAll('p[data-block]')])if(!node.textContent&&!node.querySelector('img,input')&&Number(node.dataset.start)===Number(node.dataset.end)&&!(e.table_entry_caret===Number(node.dataset.start)&&e.selection.focus===e.table_entry_caret))node.remove();
  // Plain editing placeholders are real Markdown-representable paragraphs.
  if(!template.content.childNodes.length){const p=document.createElement('p');p.dataset.block='1';p.dataset.start='0';p.dataset.end=String(byte_length(e.state.source));p.append(document.createTextNode(''));this.metadata.set(p,{start:0,end:byte_length(e.state.source)});this.metadata.set(p.firstChild,{start:0,end:0,text:''});this.text_nodes.push(p.firstChild);template.content.append(p);}
  for(const item of template.content.querySelectorAll('li'))if(item.querySelector(':scope > input')&&!item.textContent.trim()&&!item.querySelector('br[data-break],img,ul,ol')){
   item.querySelectorAll('br').forEach(br=>br.remove());
   const text=document.createTextNode(''),end=Number(item.dataset.end);item.append(text);this.metadata.set(text,{start:end,end,text:''});this.text_nodes.push(text);
  }
  for(const p of template.content.querySelectorAll('p'))if(!p.firstChild||!p.textContent&&Number(p.dataset.start)===Number(p.dataset.end)){const text=document.createTextNode(''),at=Number(p.dataset.start);p.replaceChildren(text);this.metadata.set(text,{start:at,end:at,text:''});this.text_nodes.push(text);}
  for(const cell of template.content.querySelectorAll('td,th'))if(!cell.textContent&&!cell.querySelector('img,input,br[data-break]')){
   cell.querySelectorAll('br').forEach(br=>br.remove());const text=document.createTextNode(''),start=Number(cell.dataset.start),end=Number(cell.dataset.end);cell.append(text);this.metadata.set(text,{start,end,text:''});this.text_nodes.push(text);
  }
  sanitize_rich(template.content,true);
  for(const cell of template.content.querySelectorAll('td,th'))if(!cell.textContent&&!cell.querySelector('img,input,br')){const br=document.createElement('br');br.dataset.richPlaceholder='1';cell.append(br);}
  // A zero-length text node has no line box. A UI-only BR gives native arrow
  // navigation an editable empty line without inserting a source line break.
  for(const p of template.content.querySelectorAll('p'))if(!p.textContent&&!p.querySelector('br,img,input')){
   const br=document.createElement('br');br.dataset.richPlaceholder='1';p.append(br);
  }
  this.metadata.set(e.surface,{start:0,end:byte_length(e.state.source)});
  e.surface.replaceChildren(template.content);
  for(const node of e.surface.querySelectorAll('tr')){const cells=[...node.cells];if(cells.length)this.metadata.set(node,{start:Number(cells[0].dataset.start)-2,end:Number(cells.at(-1).dataset.end)+2});}
  e.surface.querySelectorAll('input[type="checkbox"]').forEach(box=>box.disabled=e.options.read_only||e.reading);
  // Visual marks are decorations: no text nodes or source bytes are added.
  const blocks='p,h1,h2,h3,h4,h5,h6,pre,li,blockquote,dt,dd,summary,figcaption';
  for(const block of e.surface.querySelectorAll(blocks))if(!block.querySelector(blocks+',ul,ol,dl,table'))block.dataset.paragraphEnd='1';
  for(const br of e.surface.querySelectorAll('br:not([data-rich-placeholder])')){
   const marker=document.createElement('span');marker.className='break_mark';marker.contentEditable='false';marker.setAttribute('aria-hidden','true');br.before(marker);
  }
  this.baseline={source:e.state.source,before:serialize_rich(e.surface,this.metadata),selection:{...e.selection}};
 }
 placeholder_range(node){
  const element=node?.nodeType===1?node:node?.parentElement,p=element?.closest('p');
  return p&&!p.textContent&&p.querySelector('[data-rich-placeholder]')?this.metadata.get(p):null;
 }
 capture(node,offset){
  const element=node?.nodeType===1?node:node?.parentElement,cell=element?.closest('[data-cell]');
  if(cell&&!cell.textContent)return Number(cell.dataset.start);
  const placeholder=this.placeholder_range(node);if(placeholder)return placeholder.start;
  const data=this.metadata.get(node);
  if(node.nodeType===3&&data){const raw=byte_slice(this.editor.state.source,data.start,data.end);return raw===node.data?data.start+byte_length(node.data.slice(0,offset)):offset?data.end:data.start;}
  const result=serialize_rich(this.editor.surface,this.metadata,{anchorNode:node,anchorOffset:offset,focusNode:node,focusOffset:offset});return result.raw_at(result.focus);
 }
 locate(position){
  const cells=[...this.editor.surface.querySelectorAll('[data-cell]')];
  const cell=cells.find(cell=>Number(cell.dataset.start)===position)||cells.find(cell=>Number(cell.dataset.start)<=position&&position<=Number(cell.dataset.end));
  const nodes=cell?this.text_nodes.filter(node=>cell.contains(node)):this.text_nodes;
  if(cell&&!nodes.some(node=>cell.contains(node)))return [cell,0];
  let nearest=null;for(const node of nodes){if(!this.editor.surface.contains(node))continue;const data=this.metadata.get(node);if(data.start<=position&&position<=data.end){const raw=byte_slice(this.editor.state.source,data.start,data.end);return [node,raw===node.data?byte_to_utf16(raw,position-data.start):position===data.end?node.length:0];}const distance=Math.min(Math.abs(position-data.start),Math.abs(position-data.end));if(!nearest||distance<nearest.distance)nearest={node,data,distance};}
  return nearest?[nearest.node,position>nearest.data.end?nearest.node.length:0]:[this.editor.surface.firstChild||this.editor.surface,0];
 }
 vertical_arrow(event){
  if(!this.active||!['ArrowUp','ArrowDown'].includes(event.key)||event.shiftKey||event.ctrlKey||event.metaKey||event.altKey)return false;
  const e=this.editor,selection=e.dom_selection();if(!selection?.isCollapsed||!selection.rangeCount)return false;
  const node=selection.focusNode,element=node.nodeType===1?node:node.parentElement,cell=element.closest('[data-cell]');
  if(!cell||!e.surface.contains(cell))return false;
  // Resolve table navigation in the DOM. Source ranges and visual-line rects
  // are not reliable cell boundaries (wrapped text, entities and empty BRs).
  const down=event.key==='ArrowDown',row=cell.parentElement,table=cell.closest('table');
  const target=table.rows[row.rowIndex+(down?1:-1)]?.cells[cell.cellIndex];
  event.preventDefault();
  if(target){
   const range=document.createRange();range.selectNodeContents(target);range.collapse(true);
   selection.removeAllRanges();selection.addRange(range);
   // Capture for subsequent edits without restoring through source offsets.
   e.capture_selection();
  }
  return true;
 }
 begin(){const e=this.editor;e.capture_selection();const transaction=this.transaction={source:e.state.source,before:serialize_rich(e.surface,this.metadata),selection:{...e.selection}};setTimeout(()=>{if(e.core&&this.transaction===transaction&&!e.composing){this.transaction=null;if(e.state.source!==transaction.source)e.render();}},0);}
 before(event){
  const e=this.editor;event.stopImmediatePropagation();if(e.options.read_only){event.preventDefault();return;}
  if(event.isComposing||e.composing)return;
  if(event.inputType==='historyUndo'||event.inputType==='historyRedo'){event.preventDefault();e.run(event.inputType==='historyUndo'?'undo':'redo');return;}
  if(!/^(insertText|insertReplacementText|insertParagraph|insertLineBreak|deleteContentBackward|deleteContentForward|deleteWordBackward|deleteWordForward|deleteByCut|insertFromPaste|formatBold|formatItalic|formatStrikeThrough)$/u.test(event.inputType)){event.preventDefault();return;}
  if(e.composition_commit!=null&&event.data===e.composition_commit){event.preventDefault();return;}
  if(event.inputType==='insertParagraph'){e.capture_selection();if(e.table_source_enter()||e.paragraph_enter()){event.preventDefault();return;}}
  this.begin();
  const range=e.dom_selection()?.rangeCount?e.dom_selection().getRangeAt(0):null;
  const cell=range&&(range.startContainer.nodeType===1?range.startContainer:range.startContainer.parentElement).closest('td,th');
  const endCell=range&&(range.endContainer.nodeType===1?range.endContainer:range.endContainer.parentElement).closest('td,th');
  if(cell!==endCell&&(cell||endCell)){event.preventDefault();this.transaction=null;e.report(new Error('셀 사이의 병합은 허용하지 않습니다. 표 도구를 사용하세요.'));return;}
  if(cell&&event.inputType==='insertParagraph'){event.preventDefault();this.insert_break();this.commit();}
 }
 input(event){event.stopImmediatePropagation();if(this.editor.options.read_only){this.transaction=null;this.editor.render();return;}if(!this.editor.composing){this.transaction??=this.baseline;this.commit();}}
 insert_break(){const selection=this.editor.dom_selection();if(!selection?.rangeCount)return;const range=selection.getRangeAt(0);range.deleteContents();const br=document.createElement('br');range.insertNode(br);range.setStartAfter(br);range.collapse(true);selection.removeAllRanges();selection.addRange(range);}
 commit(){
  const e=this.editor,transaction=this.transaction;if(!transaction){e.render();return;}
  try{
   validate_rich_tables(e.surface);const after=serialize_rich(e.surface,this.metadata,e.dom_selection());
   if(e.core.snapshot.source!==transaction.source){e.rich_pending_draft=after.markdown;e.last_source_draft=after.markdown;throw new Error('원격 변경과 겹친 리치 편집은 로컬 초안으로 보관했습니다. 원문을 확인하고 다시 적용하세요.');}
   const [from,to,text]=diff(transaction.before.markdown,after.markdown);this.transaction=null;
   if(from===to&&!text){e.render();return;}
   const start=transaction.before.raw_at(from,from===to?'after':'before'),end=from===to?start:transaction.before.raw_at(to,'after');
   const caret=start+byte_length(after.markdown.slice(from,Math.max(from,Math.min(after.focus,from+text.length))));
   e.replace(text,start,end,caret);
  }catch(error){this.transaction=null;e.state=e.core.snapshot;e.selection={anchor:e.state.anchor,focus:e.state.focus};e.render();e.report(error);}
 }
 composition_start(event){const e=this.editor;event.stopImmediatePropagation();if(e.options.read_only){this.blocked_composition=true;return;}this.blocked_composition=false;e.capture_selection();
 const selection=e.dom_selection(),placeholder=selection?.isCollapsed?this.placeholder_range(selection.focusNode):null;
 this.composition=placeholder?{anchor:placeholder.start,focus:placeholder.end}:{...e.selection};
 e.composing=true;e.core.begin_composition?.(Math.min(this.composition.anchor,this.composition.focus),Math.max(this.composition.anchor,this.composition.focus));}
 composition_end(event){const e=this.editor;event.stopImmediatePropagation();e.composing=false;if(this.blocked_composition||e.options.read_only){this.blocked_composition=false;e.render();return;}const text=text_escape(event.data||'');if(e.core.commit_composition){e.state=e.core.commit_composition(text);e.selection={anchor:e.state.anchor,focus:e.state.focus};e.render();if(text)e.emit_change();}else{e.selection=this.composition;if(text)e.replace(text);else e.render();}e.composition_commit=event.data;setTimeout(()=>{e.composition_commit=null;},0);}
 paste(event){event.stopImmediatePropagation();event.preventDefault();const e=this.editor;if(e.options.read_only)return;try{const html=event.clipboardData?.getData('text/html');if(event.clipboardData?.files?.length&&!html){e.capture_selection();e.add_files([...event.clipboardData.files]);return;}const template=document.createElement('template');if(html)template.innerHTML=html;else template.content.append(document.createTextNode(event.clipboardData?.getData('text/plain')||''));sanitize_rich(template.content);this.begin();const selection=e.dom_selection();if(!selection?.rangeCount)return;const range=selection.getRangeAt(0);range.deleteContents();const last=template.content.lastChild;range.insertNode(template.content);if(last){range.setStartAfter(last);range.collapse(true);selection.removeAllRanges();selection.addRange(range);}this.commit();}catch(error){this.transaction=null;e.render();e.report(error);}}
}
