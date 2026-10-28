// Adapts the shared document to the existing rich/source editor protocol.
// The v1 core is used solely as a local parser/normalizer and DOM projection.
import { load_core, byte_length, byte_slice, byte_to_utf16 } from '../core.js';
import { rebase_source_range } from '../source-map.js';
import { CollaborativeReplica } from './core.js';
function diff(old_text, text) {
  let start = 0, end = old_text.length, to = text.length;
  while (start < Math.min(end,to) && old_text[start] === text[start]) start++;
  if (start && /[\uD800-\uDBFF]/u.test(old_text[start-1])) start--;
  while (end > start && to > start && old_text[end-1] === text[to-1]) { end--; to--; }
  if (end < old_text.length && /[\uDC00-\uDFFF]/u.test(old_text[end])) { end++; to++; }
  return [byte_length(old_text.slice(0,start)), byte_length(old_text.slice(0,end)), text.slice(start,to)];
}
export async function create_editor_core(replica, options = {}) {
  if (!(replica instanceof CollaborativeReplica) || !replica.handle) throw new TypeError('A live replica from this SDK is required');
  const renderer = await load_core(options.wasm_url);
  if (!replica.snapshot.operation_count && options.markdown) { replica.import_markdown(options.markdown); replica.clear_local_history(); }
  renderer.request(0, replica.snapshot.markdown);
  return new SharedEditorCore(replica, renderer);
}
class SharedEditorCore extends EventTarget {
  constructor(replica, renderer) {
    super(); this.replica = replica; this.renderer = renderer; this.revision = 0n;
    this.selection = {anchor:0,focus:0}; this.saved = replica.snapshot.markdown; this.busy = false; this.draft = null; this.draft_redo=[]; this.composition = null; this.undo_selections=[]; this.redo_selections=[];
    this.listener = event => {
      if (this.busy) return;
      if(event.detail.origin === 'local'){this.undo_selections=[];this.redo_selections=[];}
      this.refresh(true);
      this.dispatchEvent(new CustomEvent('remotechange', {detail: {origin: event.detail.origin}}));
    };
    replica.addEventListener('change', this.listener); this.refresh();
  }
  bookmark_pair(){return [this.selection.anchor,this.selection.focus].map(offset=>{
    try{return {anchor:this.replica.projected_anchor(offset,'after'),offset,fallback_table:this.replica.snapshot.projection.find(table=>offset>=table.start&&offset<=table.end)?.id};}
    catch{const table=this.replica.snapshot.projection.find(table=>offset>=table.start&&offset<=table.end);
      return table?{table:table.id,relative:offset-(table.cells.length?table.cells[0].start-2:table.start),offset}: {offset};}
  });}
  restore_pair(pair){const values=pair.map(item=>{
    if(item.table){const table=this.replica.snapshot.projection.find(table=>table.id===item.table);if(table)return Math.max(table.start,Math.min(table.end,(table.cells.length?table.cells[0].start-2:table.start)+item.relative));}
    try{return this.replica.resolve_projected_anchor(item.anchor);}catch{return this.replica.snapshot.projection.find(table=>table.id===item.fallback_table)?.start??item.offset;}
  });this.selection={anchor:values[0],focus:values[1]};}
  record_selection(before){this.undo_selections.push({before,after:this.bookmark_pair()});if(this.undo_selections.length>200)this.undo_selections.shift();this.redo_selections=[];}
  refresh(resolve = false) {
    if (resolve && this.bookmarks && !this.draft) this.restore_pair(this.bookmarks);
    const source = this.draft?.source ?? this.replica.snapshot.markdown;
    this.renderer.request(2, source); this.revision++;
    const boundary = offset => {
      offset = Math.min(Math.max(0,offset),byte_length(source));
      while (offset) { try { byte_slice(source,0,offset); break; } catch { offset--; } } return offset;
    };
    this.selection = {anchor:boundary(this.selection.anchor),focus:boundary(this.selection.focus)};
    this.snapshot = {...this.renderer.snapshot, ...this.selection, source, revision:this.revision,
      can_undo:!!this.draft || this.replica.snapshot.can_undo, can_redo:!!this.draft_redo.length || !!this.format_redo || this.replica.snapshot.can_redo,
      dirty:source !== this.saved, draft:!!this.draft, draft_conflict:!!this.draft && this.draft.version !== this.replica.snapshot.operation_count};
    return this.snapshot;
  }
  remember() {
    if (this.draft) { this.bookmarks = null; return; }
    this.bookmarks=this.bookmark_pair();
  }
  mutate(callback) { this.busy = true; try { return callback(); } finally { this.busy = false; } }
  replace(start,end,text) {
    const before_selection=this.bookmark_pair(),before_count=this.replica.snapshot.operation_count;
    const before = this.snapshot.source,before_caret={...this.selection};
    byte_to_utf16(before,start);byte_to_utf16(before,end);if(start>end)throw new RangeError('Invalid source range');
    const literal=this.source_mode||!!this.draft;
    const source = byte_slice(before,0,start) + text + byte_slice(before,end);
    if (source === before) return this.snapshot;
    this.draft_redo=[];
    let caret;
    let caret_start=start;
    if(!this.source_mode&&!this.draft){
      const cells=this.replica.snapshot.projection.flatMap(table=>table.cells),first=cells.findIndex(cell=>start>=cell.start&&start<=cell.end);
      if(first>=0&&start===cells[first].end&&end>cells[first].end){const next=cells.slice(first+1).find(cell=>cell.start<end);if(next)caret_start=next.start;}
    }
    try { caret = this.replica.projected_anchor(caret_start,'after'); } catch { /* source delimiters may be a local draft */ }
    try {
      if (this.draft?.version !== undefined && this.draft.version !== this.replica.snapshot.operation_count) throw new Error('ProjectionDraft');
      const args = this.draft ? diff(this.draft.base,source) : [start,end,text];
      if(literal){
        // Normalization is a commit boundary, not a replacement for what is being
        // typed. An inexact projection stays local until a complete source edit
        // can be shared without rewriting the user's source or cursor.
        if(this.replica.preview_replace_markdown(...args)!==source)throw new Error('ProjectionDraft');
      }
      this.mutate(() => (this.source_mode||this.draft ? this.replica.replace_markdown(...args) : this.replica.replace_projected_text(...args))); this.draft = null;
      // Literal source edits place the caret after the inserted source bytes.
      // A projected anchor at EOF can resolve before a newly inserted newline.
      const offset = literal ? Math.min(start+byte_length(text),byte_length(this.replica.snapshot.markdown))
        : caret ? this.replica.resolve_projected_anchor(caret) : Math.min(start+byte_length(text),byte_length(this.replica.snapshot.markdown));
      this.selection = {anchor:offset,focus:offset};
    } catch(error) {
      if (!error.message.includes('ProjectionDraft')) throw error;
      this.draft ??= {base:this.replica.snapshot.markdown,source:before,version:this.replica.snapshot.operation_count,steps:[]};
      this.draft.steps.push(this.draft.source);(this.draft.carets??=[]).push(before_caret); this.draft.source = source;
      this.selection = {anchor:start+byte_length(text),focus:start+byte_length(text)};
    }
    this.refresh(); this.remember(); if(this.replica.snapshot.operation_count!==before_count)this.record_selection(before_selection); return this.snapshot;
  }
  request(op,text = '',start = 0,end = start) {
    if (op === 0 || op === 7) return this.snapshot;
    if (op === 1) { this.replica.removeEventListener('change',this.listener); this.renderer.request(1); return; }
    if (op === 12) {
      if(!this.draft && this.undo_selections.length >= 2){
        this.mutate(()=>this.replica.coalesce_history());
        const newest=this.undo_selections.pop();this.undo_selections.at(-1).after=newest.after;
      }
      return this.snapshot;
    }
    if (op === 8 || op === 13) return this.renderer.request(op);
    if (op === 4 || op === 11) { this.selection = {anchor:start,focus:end}; this.refresh_selection(); this.remember(); if(op===11&&this.undo_selections.length)this.undo_selections.at(-1).after=this.bookmark_pair(); return this.snapshot; }
    if (op === 9) { if (!this.draft) this.saved = this.snapshot.source; return this.refresh(); }
    if (op === 2) return this.replace(0,byte_length(this.snapshot.source),text);
    if (op === 3) { this.format_redo = null; return this.replace(start,end,text); }
    if (op === 10) {
      this.format_redo = true; return this.replace(start,end,text);
    }
    if (op === 5 || op === 6) {
      let history;
      if(op===6&&this.draft_redo.length){
        const next=this.draft_redo.pop();this.draft=next.draft;this.selection=next.selection;
      } else if (this.draft) {
        if (op === 5) {
          this.draft_redo.push({draft:{...this.draft,steps:[...this.draft.steps],carets:[...(this.draft.carets||[])]},selection:{...this.selection}});
          this.draft.source = this.draft.steps.pop() ?? this.draft.base;
          this.selection=this.draft.carets?.pop()||{anchor:0,focus:0};
          if (this.draft.source === this.draft.base) this.draft = null;
        }
      } else {
        const undo=op===5||this.format_redo;
        history=(undo?this.undo_selections:this.redo_selections).pop();
        this.mutate(() => {if(undo)this.replica.undo();else this.replica.redo();if(this.format_redo)this.replica.request(29);});
        if(history){this.restore_pair(undo?history.before:history.after);(undo?this.redo_selections:this.undo_selections).push(history);}
        this.format_redo = null;
      }
      this.refresh(false); this.remember(); return this.snapshot;
    }
    throw new Error(`Unsupported shared editor request ${op}`);
  }
  refresh_selection() { this.snapshot = {...this.snapshot,...this.selection}; }
  commit_draft() {
    if(!this.draft)return false;
    if(this.draft.version!==this.replica.snapshot.operation_count)throw new Error('원격 변경과 충돌한 초안은 자동 공유할 수 없습니다. 임시 저장한 뒤 원문을 비교해 주세요.');
    const draft=this.draft,before=this.bookmark_pair(),selection={...this.selection},before_count=this.replica.snapshot.operation_count;
    const args=diff(draft.base,draft.source);
    // Explicit normalization is a single shared transaction with native undo.
    const normalized=this.replica.preview_replace_markdown(...args);
    this.mutate(()=>this.replica.replace_markdown(...args));
    this.draft=null;this.draft_redo=[];
    const map=position=>rebase_source_range(draft.source,normalized,{start:position,end:position}).end;
    this.selection={anchor:map(selection.anchor),focus:map(selection.focus)};
    this.refresh();this.remember();if(this.replica.snapshot.operation_count!==before_count)this.record_selection(before);return true;
  }
  discard_draft() { const source = this.draft?.source; this.draft = null;this.draft_redo=[]; this.refresh(true); this.remember(); return source; }
  begin_composition(start,end) {
    const before=this.bookmark_pair();
    try {
      if(this.draft)throw new Error('draft');
      this.composition = {before,capture:this.replica.projected_capture(start,end),caret:this.replica.projected_anchor(start,'after')};
    } catch {
      this.composition={before,source:this.snapshot.source,start,end,version:this.draft?.version??this.replica.snapshot.operation_count};
    }
  }
  commit_composition(text) {
    const composition = this.composition; this.composition = null;
    if(composition&&text&&!composition.capture){
      if(composition.version!==this.replica.snapshot.operation_count){
        this.draft??={base:composition.source,source:composition.source,version:composition.version,steps:[]};
        this.draft.steps.push(this.draft.source);this.draft.source=byte_slice(composition.source,0,composition.start)+text+byte_slice(composition.source,composition.end);
        const offset=composition.start+byte_length(text);this.selection={anchor:offset,focus:offset};this.refresh();this.remember();return this.snapshot;
      }
      return this.replace(composition.start,composition.end,text);
    }
    if (composition && text) {
      this.mutate(() => this.replica.replace_capture(composition.capture,text));
      try { const offset = this.replica.resolve_projected_anchor(composition.caret); this.selection = {anchor:offset,focus:offset}; } catch { /* remotely hidden cells keep data but lose their visual caret */ }
    }
    this.refresh(); this.remember(); if(composition&&text)this.record_selection(composition.before); return this.snapshot;
  }
  reorder_table(table_id,axis,targets,before) {
    if(this.draft) throw new Error('원본 초안을 완료하거나 보관한 뒤 표를 이동해 주세요.');
    const selection=this.bookmark_pair();
    this.mutate(()=>this.replica.reorder(table_id,axis,targets,before));
    this.refresh(true);this.remember();this.record_selection(selection);return this.snapshot;
  }
  table_action(start,action,row,column,range) {
    if (this.draft) throw new Error('원본 문법 편집을 완료하거나 초안을 되돌린 후 표를 조작해 주세요.');
    const table = this.replica.snapshot.projection.find(table => start >= table.start && start <= table.end);
    if (!table) throw new Error('이 표는 원본을 보존하고 있습니다. 원본에서 헤더와 행의 열 수를 맞춘 뒤 표 도구를 사용해 주세요.');
    const before=this.bookmark_pair();
    this.mutate(() => this.replica.table_action(table.id,action,row,column,range));
    this.refresh(true); this.remember(); this.record_selection(before); return this.snapshot;
  }
}
