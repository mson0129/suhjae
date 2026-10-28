import { SourceMap, rebase_source_range } from './source-map.js';
import { pretty_html } from './html.js';
import { load_core, byte_length, byte_slice, utf16_to_byte, byte_to_utf16 } from './core.js';
import { html_to_markdown, safe_url, read_file, file_markdown } from './clipboard.js';

const COMMANDS = new Set(['undo', 'redo', ...Array.from({length:6}, (_,i)=>`heading_${i+1}`), 'paragraph', 'bold', 'italic', 'strikethrough', 'highlight', 'subscript', 'superscript', 'inline_code', 'code_block', 'quote', 'list', 'ordered_list', 'task', 'indent', 'outdent', 'hard_break', 'link', 'unlink', 'open_link', 'table', 'table_tools', 'attachment', 'footnote', 'alert', 'details', 'comment', 'line_numbers', 'heading_levels', 'paragraph_marks', 'copy_markdown', 'open', 'save', 'save_local', 'load_local', 'save_session', 'load_session', 'clear_session']);
const is_record = value => value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const initializing = new WeakSet();
const DEFAULTS = {
  local_storage: { key: null, auto_save: false },
  session_storage: { key: null, auto_save: false },
  mode: 'rich', elements: {}, read_only: false, announce_changes: false, show_code_line_numbers: false, show_heading_levels: false, show_paragraph_marks: false,
  auto_close: { enabled: true, pairs: { bold: true, italic: true, strikethrough: true, highlight: true, inline_code: true, link_brackets: true, html_comment: true }, wrap_selection: true, skip_closing: true, delete_empty_pair: true },
  attachments: { enabled: true, storage: 'embedded', max_file_size: 4 * 1024 * 1024, max_total_size: 16 * 1024 * 1024 },
  images: { enabled: true, storage: 'embedded' }, layout: { name: 'default' }, layouts: {}, keybindings: {},
};
// Compare content independently of source coordinates, then patch offsets atomically.
// This preserves text nodes, native selection and unchanged suffix blocks after insertion.
function patch_coordinates(old, incoming) {
  const changes = [], coordinates = ['data-start','data-end','data-task','data-separator-end','data-gap-start','data-gap-end'];
  const compare = (a,b) => {
    if(a.nodeType !== b.nodeType || a.nodeName !== b.nodeName)return false;
    if(a.nodeType !== 1)return a.nodeValue === b.nodeValue;
    const attributes = node => [...node.attributes].filter(attr=>!coordinates.includes(attr.name));
    const attrs=attributes(a),other=attributes(b);
    if(attrs.length!==other.length || attrs.some(attr=>b.getAttribute(attr.name)!==attr.value) || a.childNodes.length!==b.childNodes.length)return false;
    for(const key of coordinates)if(a.getAttribute(key)!==b.getAttribute(key))changes.push([a,key,b.getAttribute(key)]);
    return [...a.childNodes].every((child,index)=>compare(child,b.childNodes[index]));
  };
  if(!compare(old,incoming))return false;
  for(const [node,key,value]of changes)if(value===null)node.removeAttribute(key);else node.setAttribute(key,value);
  return true;
}
function merge(base, value) {
  const result = { ...base };
  for (const [key, item] of Object.entries(value || {})) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
    result[key] = is_record(item) ? merge(is_record(base?.[key]) ? base[key] : {}, item) : item instanceof URL ? new URL(item.href) : Array.isArray(item) ? item.slice() : item;
  }
  return result;
}
function validate_options(options) {
  if (options.replica !== undefined && (!options.replica || typeof options.replica !== 'object')) throw new TypeError('A live replica is required');
  if (!['hybrid', 'rich', 'markdown'].includes(options.mode)) throw new TypeError('Unknown editing mode');
  for (const key of ['read_only', 'announce_changes', 'show_code_line_numbers', 'show_heading_levels', 'show_paragraph_marks']) if (typeof options[key] !== 'boolean') throw new TypeError(`${key} must be boolean`);
  for (const key of ['auto_close','elements','attachments','images','layout','layouts','keybindings']) if (!is_record(options[key])) throw new TypeError(`${key} must be an object`);
  if (!is_record(options.auto_close.pairs)) throw new TypeError('auto_close.pairs must be an object');
  for (const key of ['markdown','filename','css_text']) if (options[key] !== undefined && typeof options[key] !== 'string') throw new TypeError(`${key} must be a string`);
  for (const key of ['wasm_url', 'config_url']) if (options[key] !== undefined && typeof options[key] !== 'string' && !(options[key] instanceof URL)) throw new TypeError(`${key} must be a string or URL`);
  for (const config of [options.layout, ...Object.values(options.layouts)]) {
    if (!is_record(config) || (config.css_url !== undefined && typeof config.css_url !== 'string')) throw new TypeError('Layout must be an object with an optional css_url string');
    if (config.css_url) new URL(config.css_url, document.baseURI);
  }
  for (const command of Object.values(options.keybindings)) if (typeof command !== 'string' || !COMMANDS.has(command)) throw new TypeError('Unknown keybinding command');
  for(const name of ['local_storage','session_storage']){const config=options[name];if(!is_record(config)||typeof config.auto_save!=='boolean'||!(config.key===null||typeof config.key==='string'&&config.key.trim()))throw new TypeError(name+' requires a nonempty key or null and boolean auto_save');}
  for (const [element, config] of Object.entries(options.elements)) if (typeof config?.reveal_markdown !== 'boolean') throw new TypeError(`elements.${element}.reveal_markdown must be boolean`);
  for (const key of ['enabled', 'wrap_selection', 'skip_closing', 'delete_empty_pair']) if (typeof options.auto_close[key] !== 'boolean') throw new TypeError(`auto_close.${key} must be boolean`);
  for (const [key, value] of Object.entries(options.auto_close.pairs)) if (typeof value !== 'boolean') throw new TypeError(`auto_close.pairs.${key} must be boolean`);
  for (const key of ['attachments', 'images']) {
    if (typeof options[key].enabled !== 'boolean' || options[key].storage !== 'embedded') throw new TypeError(`${key} only supports embedded storage`);
  }
  for (const key of ['max_file_size', 'max_total_size']) if (!Number.isSafeInteger(options.attachments[key]) || options.attachments[key] < 1) throw new TypeError(`attachments.${key} must be a positive integer`);
  if (typeof options.layout.name !== 'string') throw new TypeError('layout.name must be a string');
}
const escape_html = text => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export function grapheme_range(source, offset, backwards) {
  const utf16 = byte_to_utf16(source, offset);
  const segments = [...segmenter.segment(source)];
  if (backwards) {
    const previous = segments.findLast(segment => segment.index < utf16);
    return [previous ? utf16_to_byte(source, previous.index) : 0, offset];
  }
  const next = segments.find(segment => segment.index + segment.segment.length > utf16);
  return [offset, next ? utf16_to_byte(source, next.index + next.segment.length) : offset];
}

export async function create_editor(container, options = {}) {
  if (!(container instanceof Element)) throw new TypeError('Container must be an Element');
  if (!is_record(options)) throw new TypeError('Options must be an object');
  if (initializing.has(container) || container.shadowRoot?.childNodes.length) throw new Error('Container already has an active or initializing editor');
  options = merge({}, options);
  initializing.add(container);
  let core;
  try {
    validate_options(merge(DEFAULTS, options));
    if (options.config_url) {
      const response = await fetch(options.config_url);
      if (!response.ok) throw new Error('Unable to load editor configuration');
      const config = await response.json();
      if (!is_record(config)) throw new TypeError('Configuration file must contain an object');
      const { replica, ...instance_options } = options;
      // Replica instances cannot be supplied by JSON configuration.
      const { replica: _ignored_replica, ...file_options } = config;
      options = {...merge(file_options, instance_options), ...(replica ? {replica} : {})};
    }
    validate_options(merge(DEFAULTS, options));
    core = options.replica ? await (await import('./collab/editor_core.js')).create_editor_core(options.replica, options) : await load_core(options.wasm_url);
    const css = options.css_text ?? await fetch(new URL('./editor.css', import.meta.url)).then(response => {
      if (!response.ok) throw new Error('Unable to load editor styles'); return response.text();
    });
    return new MarkdownEditor(container, core, css, options);
  } catch (error) { if (core?.snapshot) core.request(1); throw error; }
  finally { initializing.delete(container); }
}

class MarkdownEditor extends EventTarget {
  constructor(container, core, css, options) {
    super();
    this.core = core;
    const {replica: _shared_replica, ...editor_options} = options;
    this.options = merge(DEFAULTS, editor_options);
    validate_options(this.options);
    if (container.shadowRoot?.childNodes.length) throw new Error('Container already has an active shadow root');
    this.root = container.shadowRoot || container.attachShadow({ mode: 'open' });
    this.container = container;
    this.source_map = new SourceMap(this);
    this.composing = false;
    this.source_view = false;
    this.html_view = false;
    this.reading = false;
    this.selection = { anchor: 0, focus: 0 };
    this.pairs = [];
    this.listeners = new AbortController();
    this.root.innerHTML = `<style>${css}</style><link class="layout_link" rel="stylesheet" disabled>
      <div class="markdown_editor"><header><div class="toolbar" role="toolbar" aria-label="문서 편집 도구"></div>
      <div class="view_bar"><label>편집 방식 <select aria-label="편집 방식"><option value="rich">리치</option><option value="hybrid">하이브리드</option><option value="markdown">마크다운</option></select></label>
      <button data-view="source" aria-pressed="false">원본</button><button data-view="html" aria-pressed="false">HTML</button><button data-view="reading" aria-pressed="false">읽기</button><span class="state"></span><button data-draft-commit hidden>정규화 후 초안 공유</button><button data-draft-discard hidden>원본 초안 되돌리기</button></div></header>
      <div class="surface" contenteditable="true" role="textbox" aria-label="Markdown 문서" aria-describedby="editor_help" aria-multiline="true" spellcheck="false"></div>
      <textarea class="source" aria-label="Markdown 원본" aria-describedby="editor_help" spellcheck="false" hidden></textarea>
      <textarea class="source html_output" aria-label="렌더링된 HTML" readonly spellcheck="false" hidden></textarea>
      <footer><span class="position"></span><span>Esc · 편집 영역 나가기</span></footer>
      <p id="editor_help" class="sr_only">문서에서 Esc를 누르면 편집 영역을 나갑니다. 도구 모음은 방향키와 Home·End로 이동합니다. 모든 명령은 Control 또는 Command와 Shift와 P로 열 수 있습니다. 표 핸들은 Alt와 방향키로 이동합니다.</p>
      <div class="errors sr_only" role="alert" aria-atomic="true"></div>
      <div class="announce" role="status" aria-live="polite"></div>
      <dialog aria-labelledby="command_title"><form method="dialog"><h2 id="command_title"></h2><div class="fields"></div><div class="dialog_actions"><button value="cancel">취소</button><button value="apply">적용</button></div></form></dialog>
      <input class="file_input" type="file" multiple hidden></div>`;
    this.surface = this.root.querySelector('.surface');
    this.source_input = this.root.querySelector('.source');
    this.html_output = this.root.querySelector('.html_output');
    this.toolbar = this.root.querySelector('.toolbar');
    this.dialog = this.root.querySelector('dialog');
    const tools = [
      ['undo', '↶', '실행 취소'], ['redo', '↷', '다시 실행'],
      ...Array.from({ length: 6 }, (_, i) => [`heading_${i + 1}`, `H${i + 1}`, `제목 ${i + 1}`]),
      ['paragraph', 'P', '일반 문단'], ['bold', 'B', '굵게'], ['italic', 'I', '기울임'], ['strikethrough', 'S̶', '취소선'], ['highlight', '형광', '하이라이트'], ['subscript', 'x₂', '아래첨자'], ['superscript', 'x²', '위첨자'],
      ['inline_code', '<>', '인라인 코드'], ['code_block', '{ }', '코드 블록'], ['quote', '❞', '인용문'],
      ['list', '•', '목록'], ['ordered_list', '1.', '순서 목록'], ['task', '☑', '작업 목록'],
      ['indent', '→', '들여쓰기'], ['outdent', '←', '내어쓰기'], ['hard_break', '↓', '줄바꿈'],
      ['link', '↗', '링크 추가·수정'], ['unlink', '⊘', '링크 제거'], ['open_link', '열기', '링크 열기'],
      ['table', '▦', '표 삽입'], ['table_tools', '표 도구', '표 행·열 편집'], ['attachment', '＋파일', '파일·이미지 첨부'],
      ['footnote', '각주', '각주 삽입'], ['alert', '알림', '알림 블록'], ['details', '접기', '접기 영역'],
      ['comment', '<!-- -->', '주석'], ['line_numbers', '줄 번호', '코드 줄 번호 표시'], ['heading_levels', '제목 단계', '제목 단계 표시'], ['paragraph_marks', '문단 표시', '문단 기호 표시'], ['copy_markdown', 'MD 복사', 'Markdown 복사'], ['open', '불러오기', 'Markdown 불러오기'], ['save', '저장', 'Markdown 저장'], ['save_local', '브라우저 저장', '브라우저에 Markdown 저장'], ['load_local', '브라우저 불러오기', '브라우저에서 Markdown 불러오기'], ['save_session','임시 저장','현재 탭에 Markdown 임시 저장'], ['load_session','임시 복원','현재 탭의 Markdown 임시 저장 복원'],
    ];
    tools.forEach(([command, label, title]) => {
      const button = document.createElement('button'); button.type = 'button'; button.dataset.command = command;
      button.textContent = label; button.title = title; button.setAttribute('aria-label', title); this.toolbar.append(button);
    });
    this.on(this.toolbar, 'keydown', event => {
      const buttons=[...this.toolbar.querySelectorAll('button:not(:disabled)')];
      const current=buttons.indexOf(this.root.activeElement);
      const target=event.key==='Home'?0:event.key==='End'?buttons.length-1:['ArrowRight','ArrowDown'].includes(event.key)?(current+1)%buttons.length:['ArrowLeft','ArrowUp'].includes(event.key)?(current-1+buttons.length)%buttons.length:null;
      if(target!==null&&buttons.length){event.preventDefault();this.typing_group=null;buttons.forEach((button,index)=>button.tabIndex=index===target?0:-1);buttons[target].focus();}
      if(event.key==='Escape'){event.preventDefault();this.focus();}
    });
    this.on(this.toolbar,'focusin',event=>{if(event.target.matches('button'))this.toolbar.querySelectorAll('button').forEach(button=>button.tabIndex=button===event.target?0:-1);});
    this.on(this.toolbar, 'pointerdown' , event => { if (event.target.closest('button')) event.preventDefault(); });
    this.on(this.toolbar, 'click', event => { const command = event.target.closest('[data-command]')?.dataset.command; if (command) this.run(command); });
    this.on(this.root.querySelector('[data-draft-commit]'),'click',()=>{try{this.commit_pending_draft();}catch(error){this.report(error);}});
    this.on(this.root.querySelector('[data-draft-discard]'), 'click', () => {
      this.discard_pending_draft();
    });
    this.on(this.root.querySelector('select'), 'change', event => this.set_options({ mode: event.target.value }));
    this.root.querySelectorAll('[data-view]').forEach(button => this.on(button, 'click', () => this.set_view(button.dataset.view)));
    this.on(this.html_output, 'keydown', event => { if (event.key === 'Escape') { event.preventDefault(); this.root.querySelector('[data-view="html"]').focus(); } });
    for(const input of [this.surface,this.source_input])this.on(input,'blur',()=>{this.typing_group=null;});
    this.on(this.source_input,'pointerdown',()=>{this.typing_group=null;});
    this.on(this.surface, 'focus', () => { this.keep_active_syntax = true; this.refresh_syntax(); });
    this.on(this.surface, 'beforeinput', event => this.input_event(event, () => this.before_input(event)));
    this.on(this.surface, 'compositionstart', () => {
      this.typing_group = null;
      this.capture_selection(); this.begin_source_session(Math.min(this.selection.anchor,this.selection.focus),Math.max(this.selection.anchor,this.selection.focus)); this.composing = true; this.composition_selection = { ...this.selection };
      this.composition_visible = this.surface.textContent;
      this.core.begin_composition?.(Math.min(this.selection.anchor,this.selection.focus),Math.max(this.selection.anchor,this.selection.focus));
    });
    this.on(this.surface, 'compositionend', event => {
      this.composing = false;
      if (this.options.read_only || this.reading) { this.render(); return; }
      let text = event.data ?? '';
      if (!text && this.surface.textContent !== this.composition_visible) {
        const before = this.composition_visible, after = this.surface.textContent;
        let prefix = 0, suffix = 0;
        while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
        while (suffix < before.length - prefix && suffix < after.length - prefix && before.at(-suffix - 1) === after.at(-suffix - 1)) suffix++;
        text = after.slice(prefix, after.length - suffix);
      }
      this.selection = this.composition_selection;
      if (this.core.commit_composition) {
        this.state = this.core.commit_composition(text); this.selection = {anchor:this.state.anchor,focus:this.state.focus}; this.render(); if (text) this.emit_change();
      } else if (text) this.replace(text); else this.render();
      if (this.pending_options) { const pending = this.pending_options; this.pending_options = null; this.set_options(pending); }
      this.composition_commit = text;
      setTimeout(() => { this.composition_commit = null; }, 0);
    });
    this.on(this.surface, 'input', () => { if (!this.composing) this.render(); });
    this.on(this.source_input, 'compositionstart', () => {
      if (!this.core.begin_composition) return;
      this.capture_selection(); this.composing = true;
      this.core.begin_composition(Math.min(this.selection.anchor,this.selection.focus),Math.max(this.selection.anchor,this.selection.focus));
    });
    this.on(this.source_input, 'input', event => { if (!event.isComposing && !this.composing && !(this.composition_commit != null && event.data === this.composition_commit)) this.input_event(event, () => this.source_changed()); });
    this.on(this.source_input, 'compositionend', event => {
      if (!this.core.commit_composition) { this.source_changed(); return; }
      this.composing = false; this.state = this.core.commit_composition(event.data ?? ''); this.selection = {anchor:this.state.anchor,focus:this.state.focus};
      this.composition_commit = event.data; setTimeout(() => { this.composition_commit = null; },0); this.render(); this.emit_change();
    });
    for (const element of [this.surface, this.source_input]) {
      this.on(element, 'keydown', event => this.keydown(event));
      this.on(element, 'paste', event => this.paste(event));
      this.on(element, 'copy', event => this.copy(event));
      this.on(element, 'cut', event => { if (!this.options.read_only && !this.reading) { this.copy(event); this.replace(''); } });
      this.on(element, 'dragover', event => event.preventDefault());
      this.on(element, 'drop', event => { event.preventDefault(); this.capture_selection(); this.add_files([...event.dataTransfer.files]); });
    }
    this.on(document, 'selectionchange', () => {
      if (this.composing || this.rendering || this.dialog.open) return;
      if (!this.has_focus()) return;
      const selection = this.dom_selection();
      const at_gap = selection?.isCollapsed && this.at_paragraph_gap(selection.focusNode, selection.focusOffset);
      this.capture_selection();
      if (at_gap && !this.dragging) this.restore_selection();
      // Avoid changing DOM during a pointer drag; expose syntax on pointerup instead.
      if (!this.dragging) this.refresh_syntax();
    });
    this.on(this.surface, 'pointerdown', event => {
      this.typing_group = null;
      if (this.options.read_only || this.reading || this.composing || event.button !== 0) return;
      this.projected_selection = null;
      this.dragging = true;
      const cell = event.target.closest('[data-cell]');
      this.drag_cell = cell;
      this.drag_axis = event.target.closest('[data-row-handle]') ? 'row' : event.target.closest('[data-column-handle]') ? 'column' : null;
      if (this.drag_axis && cell) {
        event.preventDefault(); this.set_selection(Number(cell.dataset.start));
        const axis=this.drag_axis,from=axis==='row'?+cell.dataset.row:+cell.dataset.column;
        const selected=this.cell_selection;
        const range=selected&&selected.first.closest('table')===cell.closest('table') ? (axis==='row'?[+selected.first.dataset.row,+selected.last.dataset.row]:[+selected.first.dataset.column,+selected.last.dataset.column]).sort((a,b)=>a-b):null;
        this.handle_drag={axis,from:range&&from>=range[0]&&from<=range[1]?range[0]:from,to:range&&from>=range[0]&&from<=range[1]?range[1]:from,x:event.clientX,y:event.clientY,select:event.shiftKey,moved:false};
        if(!range||from<range[0]||from>range[1]||event.shiftKey)this.select_cell_rectangle(cell,cell);
      }
      if (event.shiftKey && cell) { event.preventDefault(); this.cell_selection = { first: cell, last: cell }; this.paint_cells(); }
    });
    this.on(this.surface, 'pointermove', event => {
      if (!this.dragging || !this.drag_cell) return;
      const cell = (this.handle_drag&&!this.handle_drag.select&&this.root.elementFromPoint ? this.root.elementFromPoint(event.clientX,event.clientY) : event.target)?.closest('[data-cell]');
      if(this.handle_drag&&!this.handle_drag.select){
        const drag=this.handle_drag;
        if(Math.hypot(event.clientX-drag.x,event.clientY-drag.y)<6)return;
        drag.moved=true;this.clear_table_drop();drag.slot=null;
        if(cell&&cell.closest('table')===this.drag_cell.closest('table')){
          const rect=cell.getBoundingClientRect(),after=drag.axis==='row'?event.clientY>rect.top+rect.height/2:event.clientX>rect.left+rect.width/2;
          drag.slot=(drag.axis==='row'?+cell.dataset.row:+cell.dataset.column)+(after?1:0);
          cell.dataset.drop=drag.axis+(after?'-after':'-before');
        }
        return;
      }
      if (cell && cell !== this.drag_cell && cell.closest('table') === this.drag_cell.closest('table')) {
        this.select_cell_rectangle(this.drag_cell, cell);
      }
    });
    this.on(document, 'pointerup', event => {
      if(!this.dragging)return;
      const drag=this.handle_drag,cell=this.drag_cell;
      const hit=this.root.elementFromPoint?.(event.clientX,event.clientY);
      const target=this.root.elementFromPoint?hit?.closest('[data-cell]'):event.composedPath().find(node=>node?.matches?.('[data-cell]'));
      this.cancel_table_drag();
      if(drag&&!drag.select&&drag.moved&&drag.slot!==null&&target?.closest('table')===cell?.closest('table')){
        try{this.move_table_axis(cell,drag.axis,drag.from,drag.to,drag.slot);}catch(error){this.report(error);}return;
      }
      this.capture_selection();this.refresh_syntax();
    });
    this.on(document,'pointercancel',()=>this.cancel_table_drag());
    this.on(this.surface,'keydown',event=>{if(event.key==='Escape'&&this.dragging){event.preventDefault();this.cancel_table_drag();}});
    this.on(this.surface, 'contextmenu', event => { const cell = event.target.closest('[data-cell]'); if (cell) { event.preventDefault(); this.set_selection(Number(cell.dataset.start)); this.table_dialog(); } });
    this.on(this.surface, 'click', event => {
      if (event.target.closest('.table_handle')) { event.preventDefault(); return; }
      const anchor = event.target.closest('a');
      if (anchor) { event.preventDefault(); if (this.reading) this.open_anchor(anchor); }
      const task = event.target.closest('[data-task]');
      if (task && !this.options.read_only && !this.reading) {
        const start = Number(task.dataset.task);
        const line_end = this.state.source.indexOf('\n', byte_to_utf16(this.state.source, start));
        const line = byte_slice(this.state.source, start, line_end < 0 ? undefined : utf16_to_byte(this.state.source, line_end));
        const index = line.search(/\[[ xX]\]/u);
        if (index >= 0) this.replace(task.checked ? '[x]' : '[ ]', start + byte_length(line.slice(0, index)), start + byte_length(line.slice(0, index + 3)));
      }
    });
    this.on(this.root.querySelector('.file_input'), 'change', event => { this.add_files([...event.target.files]); event.target.value = ''; });
    this.on(this.dialog, 'close', () => {
      const callback = this.dialog_callback; this.dialog_callback = null;
      this.selection = this.dialog_selection || this.selection;
      if (this.dialog.returnValue === 'apply' && callback) callback(new FormData(this.dialog.querySelector('form')));
      this.focus(); this.surface.scrollTop = this.dialog_scroll ?? this.surface.scrollTop; this.dialog_range = null;
    });
    if (window.visualViewport) this.on(window.visualViewport, 'resize', () => this.ensure_caret_visible());
    this.state = this.core.request(0, options.markdown || '');
    this.selection = { anchor: this.state.anchor, focus: this.state.focus };
    this.render();
    if (this.core.replica) this.on(this.core, 'remotechange', () => {
      if (this.composing) return;
      this.cancel_table_drag();
      const previous = this.state.source;
      this.state = this.core.snapshot; this.selection = { anchor:this.state.anchor, focus:this.state.focus };
      if(this.source_edit_session&&previous!==this.state.source)this.source_edit_session=rebase_source_range(previous,this.state.source,this.source_edit_session);
      this.map_dialog_from_sources(previous,this.state.source); this.pairs = []; this.auto_transform = null; this.cell_selection = null;
      this.render(); if(previous!==this.state.source)this.emit_change('remote');
    });
  }
  on(target, name, listener) { target.addEventListener(name, listener, { signal: this.listeners.signal }); }
  has_focus() { return this.root.activeElement === this.surface || this.root.activeElement === this.source_input; }
  assert_active() { if (!this.core) throw new Error('Editor has been destroyed'); }
  get_markdown(options = {}) {
    this.assert_active();
    if (!is_record(options) || (options.normalize !== undefined && typeof options.normalize !== 'boolean')) throw new TypeError('normalize must be boolean');
    return (options.normalize ?? true) ? this.core.request(8) : this.state.source;
  }
  get_selection() { this.assert_active(); return { ...this.selection, revision: this.state.revision }; }
  get_pending_draft() { this.assert_active(); return this.rich_pending_draft ?? this.core.draft?.source ?? null; }
  commit_pending_draft() {
    this.assert_active();if(this.options.read_only||this.reading||this.composing)throw new Error('편집 가능한 상태에서 초안을 공유해 주세요.');
    const previous=this.state.source;
    if(!this.core.commit_draft?.())return false;
    this.state=this.core.snapshot;this.selection={anchor:this.state.anchor,focus:this.state.focus};this.pairs=[];
    this.map_dialog_from_sources(previous,this.state.source);
    if(this.source_edit_session)this.source_edit_session=rebase_source_range(previous,this.state.source,this.source_edit_session);
    this.render();this.emit_change();return true;
  }
  discard_pending_draft() {
    this.assert_active();
    if(this.rich_pending_draft!=null){const draft=this.rich_pending_draft;this.rich_pending_draft=null;return draft;}
    const source=this.core.discard_draft?.(); if(source===undefined)return null;
    this.last_source_draft=source;this.state=this.core.snapshot;this.selection={anchor:this.state.anchor,focus:this.state.focus};this.render();return source;
  }
  storage_key(name) { return this.options[name].key ?? `sohjae:${location.pathname}:${this.container.id||'document'}`; }
  local_storage_key() { return this.storage_key('local_storage'); }
  session_storage_key() { return this.storage_key('session_storage'); }
  save_browser_storage(name) {
    this.assert_active();if(this.composing)throw new Error('한글 조합을 마친 뒤 저장해 주세요.');
    const record={version:1,markdown:this.get_pending_draft()??this.get_markdown({normalize:false}),saved_at:new Date().toISOString()};
    const storage=name==='session_storage'?window.sessionStorage:window.localStorage;
    storage.setItem(this.storage_key(name),JSON.stringify(record));
    this.root.querySelector('.state').textContent=name==='session_storage'?'임시 저장됨':'브라우저 저장됨';return record;
  }
  load_browser_storage(name) {
    this.assert_active();if(this.options.read_only||this.reading||this.composing)throw new Error('편집 가능한 상태에서 불러와 주세요.');
    const storage=name==='session_storage'?window.sessionStorage:window.localStorage;
    const value=storage.getItem(this.storage_key(name));if(value===null)return false;
    const record=JSON.parse(value);if(!record||record.version!==1||typeof record.markdown!=='string')throw new Error('지원하지 않는 브라우저 저장 데이터입니다.');
    this.replace(record.markdown,0,byte_length(this.state.source),0);this.focus();return true;
  }
  save_local() { return this.save_browser_storage('local_storage'); }
  load_local() { return this.load_browser_storage('local_storage'); }
  save_session() { return this.save_browser_storage('session_storage'); }
  load_session() { return this.load_browser_storage('session_storage'); }
  clear_session() { this.assert_active();window.sessionStorage.removeItem(this.session_storage_key()); }
  mark_saved() { this.assert_active(); this.state = this.core.request(9); this.render(); }
  get_options() { this.assert_active(); return merge({}, this.options); }
  set_markdown(source) {
    this.assert_active();
    if (typeof source !== 'string') throw new TypeError('Markdown must be a string');
    this.typing_group = null;
    if (this.composing) throw new Error('Finish composition before replacing the document');
    if (this.dialog.open) { this.dialog_callback = null; this.dialog_selection = { anchor: 0, focus: 0 }; this.dialog.close('cancel'); }
    this.state = this.core.request(2, source); this.auto_transform = null; this.pairs = []; this.selection = { anchor: 0, focus: 0 }; this.render();
  }
  set_options(options) {
    this.assert_active();
    this.typing_group = null;
    if (!is_record(options)) throw new TypeError('Options must be an object');
    if (['replica','markdown','config_url','wasm_url','css_text'].some(key => key in options)) throw new TypeError('Creation options require a new editor');
    const next = merge(merge(this.options, this.pending_options), options);
    validate_options(next);
    if (this.composing) { this.pending_options = merge(this.pending_options || {}, options); return; }
    this.options = next; this.render();
  }
  destroy() { if (!this.core) return; this.listeners.abort(); this.core.request(1); this.core = null; this.state = null; this.pairs = []; this.root.replaceChildren(); }
  focus() { this.assert_active(); if (this.html_view) { this.html_output.focus(); return; } (this.source_view ? this.source_input : this.surface).focus(); this.core.request(4, '', this.selection.anchor, this.selection.focus); this.restore_selection(); }
  set_selection(anchor, focus = anchor, finalize = false) {
    this.assert_active();
    this.typing_group = null;
    this.state = this.core.request(finalize ? 11 : 4, '', anchor, focus); this.selection = { anchor, focus }; this.restore_selection(); this.sync_accessibility();
  }
  set_view(view) {
    this.typing_group = null;
    if (this.composing) return;
    this.capture_selection();
    if (view === 'source') { this.source_view = !this.source_view; this.reading = false; this.html_view = false; }
    else if (view === 'html') { this.html_view = !this.html_view; this.source_view = false; this.reading = false; }
    else { this.reading = !this.reading; this.source_view = false; this.html_view = false; }
    if(this.core.replica)this.core.source_mode=this.source_view||this.options.mode==='markdown';
    this.render(); this.focus();
  }
  replace(text, start, end, caret) {
    this.assert_active();
    if (typeof text !== 'string') throw new TypeError('Replacement must be a string');
    if(text!=='\n')this.table_entry_caret=null;
    text = text.replace(/\r\n?/gu, '\n');
    if (this.options.read_only || this.reading || this.composing) return;
    const before = this.state;
    start ??= Math.min(this.selection.anchor, this.selection.focus);
    end ??= Math.max(this.selection.anchor, this.selection.focus);
    const size = byte_length(text);
    this.begin_source_session(start,end);
    if(this.source_edit_session){
      const session=this.source_edit_session;
      if(start>=session.start&&end<=session.end)session.end+=size-(end-start);
      else this.source_edit_session=null;
    }
    if (caret !== undefined && !this.core.replica) {
      const result = byte_slice(before.source, 0, start) + text + byte_slice(before.source, end);
      if (!Number.isInteger(caret) || caret < 0 || caret > byte_length(result)) throw new RangeError('Invalid UTF-8 caret');
      byte_to_utf16(result, caret); // Validate before editing so an invalid caret cannot partially apply.
    }
    const kind = this.typing_input;
    const eligible = !this.state.draft && (kind === 'insertText' && start === end && !!text && !/[\r\n*_~`\[\]#>\\=]/u.test(text)
      || ['deleteContentBackward','deleteContentForward'].includes(kind) && !text && this.selection.anchor === this.selection.focus && !byte_slice(before.source,start,end).includes('\n'));
    const now = performance.now(), context = `${this.source_view}:${this.active_kind()}`;
    const previous = this.typing_group;
    const join = eligible && previous && previous.kind === kind && previous.revision === before.revision && previous.focus === this.selection.focus && previous.context === context && now - previous.time <= 750;
    const previous_source_mode=this.core.source_mode;
    if(this.core.replica)this.core.source_mode=this.editing_mode()==='markdown';
    try{this.state = this.core.request(3, text, start, end);}
    finally{if(this.core.replica)this.core.source_mode=previous_source_mode;}
    if (join && before.revision !== this.state.revision) this.state = this.core.request(12);
    this.typing_group = eligible && !this.state.draft && before.revision !== this.state.revision ? { kind, context, time:now, revision:this.state.revision, focus:this.state.focus } : null;
    const linear=byte_slice(before.source,0,start)+text+byte_slice(before.source,end)===this.state.source;
    if(this.core.replica)this.map_dialog_from_sources(before.source,this.state.source);else this.map_dialog_positions(start,end,size);
    this.pairs = this.pairs.filter(pair => !(start < pair.start + byte_length(pair.close) && end > pair.start)).map(pair => pair.start >= end ? { ...pair, start: pair.start + size - (end - start) } : pair);
    if(!linear)this.pairs=[];
    this.selection = { anchor: this.state.anchor, focus: this.state.focus };
    if (caret !== undefined && (!this.core.replica || linear)) { this.state = this.core.request(11, '', caret, caret); this.selection = { anchor: caret, focus: caret }; }
    this.source_exit_caret=this.pending_source_exit?this.selection.focus:null;this.pending_source_exit=false;
    this.render();
    if (this.pending_options) { const pending = this.pending_options; this.pending_options = null; this.set_options(pending); }
    if (before.revision !== this.state.revision) this.emit_change();
  }
  emit_change(origin = 'local') {
    for(const name of ['local_storage','session_storage'])if(this.options[name].auto_save&&!this.composing)try{this.save_browser_storage(name);}catch(error){this.report(error);}
    this.dispatchEvent(new CustomEvent('change', { detail: { revision: this.state.revision, dirty: this.state.dirty, origin, shared: !this.state.draft } }));
    const announce = this.root.querySelector('.announce');
    if (this.options.announce_changes && announce) announce.textContent = '문서가 변경되었습니다.';
  }
  render() {
    if(this.core?.replica)this.core.source_mode=this.source_view||this.options.mode==='markdown';
    if (this.composing) return;
    this.rendering = true;
    const focused = this.has_focus();
    const scroll = this.surface.scrollTop;
    const template = document.createElement('template'); template.innerHTML = this.state.html;
    if (this.options.mode === 'markdown' && !this.reading) {
      this.render_markdown_source(template.content);
    } else {
    if (this.reading) template.content.querySelectorAll('.comment,.front_matter,.reference_definition,[data-kind="comment"]').forEach(element => element.remove());
    if(!this.reading)for(const br of template.content.querySelectorAll('br[data-break]')){
      const start=+br.dataset.start,end=+br.dataset.end,raw=byte_slice(this.state.source,start,end),tail=raw.match(/\n([ \t]+)$/u);
      if(tail){const from=end-byte_length(tail[1]),span=document.createElement('span');br.dataset.end=from;span.dataset.text='1';span.dataset.start=from;span.dataset.end=end;span.textContent=tail[1];br.after(span);}
    }
    if(!this.reading)for(const section of template.content.querySelectorAll('section[data-block]')){
      const paragraph=section.querySelector(':scope > p:only-child');
      if(paragraph){const texts=[...paragraph.querySelectorAll('[data-text]')];for(let i=1;i<texts.length;i++){const from=+texts[i-1].dataset.end,to=+texts[i].dataset.start;if(from>=to)continue;const gap=byte_slice(this.state.source,from,to);if(/^[ \t]+$/u.test(gap)){const span=document.createElement('span');span.dataset.text='1';span.dataset.start=from;span.dataset.end=to;span.textContent=gap;texts[i].before(span);}}}
      const first=paragraph?.querySelector('[data-text]');
      if(first){const from=+section.dataset.start,to=+first.dataset.start,head=byte_slice(this.state.source,from,to);if(from<to&&/^[ \t]+$/u.test(head)){const span=document.createElement('span');span.dataset.text='1';span.dataset.start=from;span.dataset.end=to;span.textContent=head;paragraph.prepend(span);}}
      const last=paragraph?[...paragraph.querySelectorAll('[data-text]')].at(-1):null;if(!last)continue;
      const start=+last.dataset.end,end=+section.dataset.end,tail=byte_slice(this.state.source,start,end);
      // Reading HTML trims paragraph-edge spaces. Editing must retain their
      // source coordinates and visible width so the next key stays after them.
      if(start<end&&/^[ \t]+$/u.test(tail)){
        const span=document.createElement('span');span.dataset.text='1';span.dataset.start=start;span.dataset.end=end;span.textContent=tail;paragraph.append(span);
      }
    }

    template.content.querySelectorAll('[data-task]').forEach(input => {
      input.disabled = this.reading || this.options.read_only;
      // Spacing is visual, not an extra editable text node/caret stop.
      const gap = input.nextSibling;
      if (gap?.nodeType === 3 && /^[ \t]*$/u.test(gap.textContent)) gap.remove();
      const item = input.parentElement;
      if (!item.querySelector('[data-text]') && !item.querySelector('ul,ol,p,h1,h2,h3,h4,h5,h6,pre')) {
        item.querySelectorAll('br:not([data-break])').forEach(br => br.remove());
        const caret = document.createElement('span');
        caret.dataset.text = '1'; caret.dataset.start = item.dataset.end; caret.dataset.end = item.dataset.end;
        caret.className = 'empty_task_caret'; item.append(caret);
      }
    });
    template.content.querySelectorAll('br[data-break]:last-child').forEach(br => {
      const placeholder = document.createElement('br'); placeholder.dataset.caret = '1';
      br.after(placeholder);
    });
    template.content.querySelectorAll('br[data-break]').forEach(br => {
      const marker = document.createElement('span');
      marker.className = 'break_mark'; marker.contentEditable = 'false'; marker.setAttribute('aria-hidden', 'true');
      br.before(marker);
    });
    // Blank source lines separate blocks; their count must not create extra paragraphs.
    for (const block of [...template.content.querySelectorAll('section[data-block]')]) {
      const paragraph = block.querySelector(':scope > p:only-child');
      const raw = byte_slice(this.state.source, Number(block.dataset.start), Number(block.dataset.end));
      if (paragraph && !paragraph.textContent && !raw.trim()) block.classList.add('paragraph_separator');
    }
    for (const first of [...template.content.querySelectorAll('.paragraph_separator')]) {
      if (!first.parentNode) continue;
      let last = first;
      while (first.nextElementSibling?.classList.contains('paragraph_separator')) {
        last = first.nextElementSibling; first.dataset.separatorEnd = last.dataset.end; last.remove();
      }
      first.dataset.separatorEnd ??= first.dataset.end;
      if (first.previousElementSibling && first.nextElementSibling) {
        const next = first.nextElementSibling;
        next.dataset.gapStart = first.dataset.start; next.dataset.gapEnd = first.dataset.separatorEnd;
        next.classList.add('after_paragraph_gap'); first.remove();
      }
    }
    if(this.options.mode==='hybrid'&&this.source_exit_caret===this.selection.focus){
      const at=this.selection.focus;
      for(const node of [...template.content.children])if(node.classList.contains('paragraph_separator')&&+node.dataset.start<=at&&at<=+(node.dataset.separatorEnd||node.dataset.end))node.remove();
      const block=document.createElement('section');block.dataset.block='1';block.dataset.start=at;block.dataset.end=at;
      const p=document.createElement('p'),span=document.createElement('span');span.dataset.text='1';span.dataset.start=at;span.dataset.end=at;span.append(document.createTextNode(''));p.append(span);const br=document.createElement('br');br.dataset.caret='1';p.append(br);block.append(p);
      const next=[...template.content.children].find(node=>+node.dataset.start>at);template.content.insertBefore(block,next||null);
    }
    // Mark semantic text blocks, not source-coordinate wrappers or nested containers.
    const blocks = 'p,h1,h2,h3,h4,h5,h6,pre,li,blockquote,dt,dd,summary,figcaption';
    template.content.querySelectorAll(blocks).forEach(block => {
      const owner = block.closest('[data-block]');
      const separator = block.matches('p') && owner?.classList.contains('paragraph_separator');
      if (!separator && !block.querySelector(blocks + ',ul,ol,dl,table')) block.dataset.paragraphEnd = '1';
    });
    const incoming = [...template.content.children];
    const old_nodes = [...this.surface.children];
    let prefix=0,suffix=0;
    while(prefix<Math.min(old_nodes.length,incoming.length)&&patch_coordinates(old_nodes[prefix],incoming[prefix]))prefix++;
    while(suffix<Math.min(old_nodes.length,incoming.length)-prefix&&patch_coordinates(old_nodes.at(-suffix-1),incoming.at(-suffix-1)))suffix++;
    const retained = suffix ? old_nodes[old_nodes.length-suffix] : null;
    const old_middle = old_nodes.slice(prefix,old_nodes.length-suffix);
    const new_middle = incoming.slice(prefix,incoming.length-suffix);
    new_middle.forEach((node,index)=>{
      const old=old_middle[index];
      if(old){if(!patch_coordinates(old,node))old.replaceWith(node);}
      else this.surface.insertBefore(node,retained);
    });
    old_middle.slice(new_middle.length).forEach(node=>node.remove());
    }
    this.source_input.value = this.state.source;
    this.source_input.hidden = !this.source_view;
    this.surface.hidden = this.source_view || this.html_view;
    this.html_output.hidden = !this.html_view;
    if (this.html_view && this.html_source !== this.state.source) {
      const input = this.html_output, {selectionStart, selectionEnd, scrollTop, scrollLeft} = input;
      input.value = pretty_html(this.core.request(13)); this.html_source = this.state.source;
      input.setSelectionRange(selectionStart, selectionEnd); input.scrollTop = scrollTop; input.scrollLeft = scrollLeft;
    }
    this.root.querySelector('[data-view="html"]').setAttribute('aria-pressed', String(this.html_view));
    this.surface.classList.remove('native_rich');
    this.surface.classList.toggle('styled_markdown',this.options.mode==='markdown'&&!this.reading);
    this.surface.contentEditable = String(!this.options.read_only && !this.reading);
    this.source_input.readOnly = this.options.read_only;
    this.root.querySelector('select').value = this.options.mode;
    this.root.querySelector('[data-view="source"]').setAttribute('aria-pressed', String(this.source_view));
    this.root.querySelector('[data-view="reading"]').setAttribute('aria-pressed', String(this.reading));
    this.root.querySelector('.state').textContent = this.options.read_only ? '읽기 전용' : this.state.draft_conflict ? '원격 변경 도착 · 공유되지 않은 원본 초안' : this.state.draft ? '표 문법 편집 중 · 아직 공유되지 않음' : this.state.dirty ? '수정됨' : '저장됨';
    this.root.querySelector('[data-draft-discard]').hidden = !this.state.draft;
    const commit=this.root.querySelector('[data-draft-commit]');commit.hidden=!this.state.draft;commit.disabled=!!this.state.draft_conflict||this.options.read_only||this.reading||this.composing;
    this.toolbar.querySelectorAll('button').forEach(button => {
      const command = button.dataset.command;
      button.disabled = ((this.options.read_only || this.reading || this.html_view) && !['copy_markdown', 'save', 'save_local', 'save_session', 'clear_session', 'open_link', 'open'].includes(command)) || command === 'undo' && !this.state.can_undo || command === 'redo' && !this.state.can_redo;
    });
    this.add_table_handles();
    this.add_block_switcher();
    this.sync_accessibility();
    this.refresh_syntax(false);
    this.apply_layout();
    const shell = this.root.querySelector('.markdown_editor');
    for (const key of ['show_code_line_numbers', 'show_heading_levels', 'show_paragraph_marks']) shell.classList.toggle(key, this.options[key]);
    this.surface.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach(heading => { heading.dataset.level = heading.tagName; });
    if (focused) this.restore_selection();
    this.surface.scrollTop = scroll;
    this.root.querySelector('.position').textContent = `${byte_length(this.state.source)} bytes · ${this.state.source.split('\n').length}줄`;
    this.rendering = false;
    requestAnimationFrame(() => this.ensure_caret_visible());
  }
  apply_layout() {
    const name = this.state.layout && this.options.layouts[this.state.layout] ? this.state.layout : this.options.layout.name;
    const config = this.options.layouts[name] || this.options.layout;
    const link = this.root.querySelector('.layout_link');
    if (config?.css_url) { link.href = new URL(config.css_url, document.baseURI); link.disabled = false; } else link.disabled = true;
    this.root.querySelector('.markdown_editor').dataset.layout = name || 'default';
  }
  render_markdown_source(markup) {
    this.surface.replaceChildren(this.markdown_source_fragment(markup));
  }
  markdown_source_fragment(markup, rangeStart=0, rangeEnd=byte_length(this.state.source)) {
    const ranges=[];
    const code=[...markup.querySelectorAll('pre[data-kind="code_block"]')].map(node=>[+node.dataset.start,+node.dataset.end]);
    for(const node of markup.querySelectorAll('[data-kind]')){
      const kind=node.dataset.kind,start=+node.dataset.start,end=+node.dataset.end;
      if(!['bold','italic','strikethrough','highlight','subscript','superscript','inline_code','link','heading','quote','table','code_block'].includes(kind))continue;
      ranges.push({start,end,kind});
      if(['bold','italic','strikethrough','highlight','subscript','superscript','inline_code','heading'].includes(kind)){
        const texts=[...node.querySelectorAll('[data-text]')];
        if(texts.length){const first=+texts[0].dataset.start,last=+texts.at(-1).dataset.end;if(start<first)ranges.push({start,end:first,kind:'delimiter'});if(last<end)ranges.push({start:last,end,kind:'delimiter'});}
      }
    }
    const headings=[...markup.querySelectorAll('h1,h2,h3,h4,h5,h6')];
    const size=rangeEnd,fragment=document.createDocumentFragment();let start=rangeStart;
    for(const line of byte_slice(this.state.source,rangeStart,rangeEnd).split('\n')){
      const end=start+byte_length(line),row=document.createElement('div');row.className='markdown_line';row.dataset.block='1';row.dataset.start=start;row.dataset.end=end;
      const heading=headings.find(node=>{const owner=node.closest('[data-block]');return owner&&+owner.dataset.start===start;});
      if(heading&&!code.some(([a,b])=>a<=start&&start<b))row.dataset.level=heading.localName;
      const points=[...new Set([start,end,...ranges.flatMap(r=>[r.start,r.end]).filter(at=>start<at&&at<end)])].sort((a,b)=>a-b);
      if(points.length===1)points.push(end);
      for(let i=0;i<points.length-1;i++){
        const from=points[i],to=points[i+1],span=document.createElement('span');span.dataset.text='1';span.dataset.start=from;span.dataset.end=to;
        span.append(document.createTextNode(byte_slice(this.state.source,from,to)));
        for(const r of ranges)if(r.start<=from&&to<=r.end)span.classList.add('md_'+r.kind);
        row.append(span);
      }
      if(!line){const br=document.createElement('br');br.dataset.caret='1';row.append(br);}
      if(end<size){const newline=document.createElement('span');newline.dataset.text='1';newline.dataset.start=end;newline.dataset.end=end+1;newline.className='markdown_eol';newline.textContent='\n';row.append(newline);}
      fragment.append(row);start=end+1;
    }
    return fragment;
  }
  should_reveal(kind) {
    if(this.options.mode==='rich')return false;
    if (this.options.elements[kind]?.reveal_markdown !== undefined) return this.options.elements[kind].reveal_markdown;
    return this.options.mode === 'hybrid';
  }
  refresh_syntax(restore = true) {
    if (this.options.mode !== 'hybrid' || this.composing || this.dragging || this.source_view || this.html_view || this.reading || (!this.keep_active_syntax && !this.has_focus())) return;
    const focus = this.selection.focus;
    let session=this.source_edit_session;
    if(session&&(focus<session.start||focus>session.end)){this.source_edit_session=null;session=null;}
    const reveal = [...this.surface.querySelectorAll('[data-kind]')].filter(element => this.should_reveal(element.dataset.kind) && focus >= Number(element.dataset.start) && focus <= Number(element.dataset.end));
    // Restore only if the active syntax region changed; never rebuild on caret movement inside it.
    let desired = reveal.find(element => !reveal.some(other => other !== element && other.contains(element)));
    // Inline syntax reveals only the approached element. Structural containers
    // (lists, tables, fenced code) retain their complete source projection.
    // Lists reveal as a complete container, including nested items and inline syntax.
    if(this.should_reveal('list')){
      const item=reveal.find(element=>element.dataset.kind==='list');
      if(item){
        let list=item.closest('ul,ol');
        if(list){while(list.parentElement.closest('ul,ol'))list=list.parentElement.closest('ul,ol');
          const items=[...list.querySelectorAll('[data-kind="list"]')];
          list.dataset.start=Math.min(...items.map(item=>+item.dataset.start));
          list.dataset.end=Math.max(...items.map(item=>+item.dataset.end));
          desired=list;
        }
      }
    }
    if(session&&this.should_reveal(session.kind)){
      let block=[...this.surface.querySelectorAll('[data-kind="'+session.kind+'"]')].find(node=>+node.dataset.start===session.start);
      if(block&&session.kind==='list'){
        let list=block.closest('ul,ol');
        if(list){while(list.parentElement.closest('ul,ol'))list=list.parentElement.closest('ul,ol');block=list;}
      }
      if(!block&&['bold','italic','strikethrough','highlight','subscript','superscript','inline_code','link'].includes(session.kind)){
        // A broken delimiter remains a local source island, not a whole paragraph.
        const [from,fromOffset]=this.source_to_dom(session.start),[to,toOffset]=this.source_to_dom(session.end);
        if(from&&to){
          const range=document.createRange();range.setStart(from,fromOffset);range.setEnd(to,toOffset);
          block=document.createElement('span');block.dataset.kind=session.kind;
          range.deleteContents();range.insertNode(block);
          // Range extraction can leave empty coordinate wrappers at its edges.
          // They must not win source_to_dom over the new editable island.
          for(const span of this.surface.querySelectorAll('[data-text]'))if(!span.textContent&&+span.dataset.start<+span.dataset.end&&!span.querySelector('br,img,input'))span.remove();
        }
      }
      if(!block){
        const owner=[...this.surface.querySelectorAll('section[data-block]')].find(node=>+node.dataset.start<=session.start&&session.start<=+node.dataset.end);
        block=owner?.firstElementChild;
        if(block){session.start=+owner.dataset.start;session.end=Math.max(session.end,+owner.dataset.end);block.dataset.kind=session.kind;}
      }
      if(block){block.dataset.start=session.start;block.dataset.end=Math.max(+block.dataset.end||0,session.end);desired=block;}
    }
    const current = this.surface.querySelector('[data-revealed]');
    if (current && (!desired || current !== desired)) { this.render(); return; }
    if (!desired || desired.dataset.revealed) return;
    const start = Number(desired.dataset.start), end = Number(desired.dataset.end);
    const fragment=this.markdown_source_fragment(this.editing_markup(),start,end);
    // Inline syntax and headings share the same token styles without introducing
    // a second block box or applying the heading size twice.
    if(!desired.matches('ul,ol,pre,table,p,h1,h2,h3,h4,h5,h6,blockquote')&&!['table','paragraph','heading','quote','code_block'].includes(desired.dataset.kind)&&!desired.classList.contains('list_source')){
      for(const row of [...fragment.children])row.replaceWith(...row.childNodes);
    }
    if(desired.matches('ul,ol,table,p,h1,h2,h3,h4,h5,h6,pre,blockquote')){
      const kind=desired.matches('ul,ol')?'list':desired.matches('table')?'table':desired.dataset.kind||'paragraph';
      const block=document.createElement('div');block.dataset.kind=kind;block.dataset.start=start;block.dataset.end=end;block.className=kind+'_source';desired.replaceWith(block);desired=block;
    }
    if(session){
      const owner=desired.closest('section[data-block]');
      let next=owner?.nextElementSibling;
      while(next&&+next.dataset.start<=end&&+next.dataset.end<=end){const following=next.nextElementSibling;next.remove();next=following;}
    }
    desired.replaceChildren(fragment); desired.dataset.revealed = '1'; desired.classList.add('source_revealed');
    if (restore && this.has_focus()) this.restore_selection();
  }
  dom_selection() { return this.root.getSelection?.() || document.getSelection(); }
  capture_selection() {
    if (this.source_view) {
      const input = this.source_input;
      const start = utf16_to_byte(input.value, input.selectionStart), end = utf16_to_byte(input.value, input.selectionEnd);
      this.selection = input.selectionDirection === 'backward' ? { anchor: end, focus: start } : { anchor: start, focus: end };
    } else {
      const selection = this.dom_selection();
      if (!selection?.anchorNode || !this.surface.contains(selection.anchorNode) || !this.surface.contains(selection.focusNode)) return;
      const projected = this.projected_selection;
      if (projected && projected.source===this.state.source && selection.anchorNode === projected.anchorNode && selection.anchorOffset === projected.anchorOffset && selection.focusNode === projected.focusNode && selection.focusOffset === projected.focusOffset) return;
      this.projected_selection = null;
      this.selection = { anchor: this.dom_to_source(selection.anchorNode, selection.anchorOffset), focus: this.dom_to_source(selection.focusNode, selection.focusOffset) };
    }
    if(this.core.replica)this.core.source_mode=this.editing_mode()==='markdown';
    this.core.request(4, '', this.selection.anchor, this.selection.focus);
  }
  at_paragraph_gap(node, offset) {
    if (this.options.mode==='markdown') return false;
    return node?.nodeType === 1 && (node === this.surface || node.matches('section[data-block]'));
  }
  dom_to_source(node,offset) { return this.source_map.dom_to_source(node,offset); }
  visual_position(position) { return this.source_map.visual_position(position); }
  source_to_dom(position) { return this.source_map.source_to_dom(position); }
  restore_selection() { return this.source_map.restore_selection(); }
  sync_accessibility() {
    this.surface.setAttribute('role',this.reading?'document':'textbox');
    if(this.reading){this.surface.removeAttribute('aria-readonly');this.surface.removeAttribute('aria-multiline');}
    else {this.surface.setAttribute('aria-readonly',String(this.options.read_only));this.surface.setAttribute('aria-multiline','true');}
    this.surface.tabIndex=0;
    this.source_input.setAttribute('aria-readonly',String(this.options.read_only));
    const buttons=[...this.toolbar.querySelectorAll('button')];
    const active=buttons.find(button=>!button.disabled&&button.tabIndex===0)||buttons.find(button=>!button.disabled);
    buttons.forEach(button=>button.tabIndex=button===active?0:-1);
    const kinds=new Set([...this.surface.querySelectorAll('[data-kind]')].filter(element=>+element.dataset.start<=this.selection.focus&&+element.dataset.end>=this.selection.focus).map(element=>element.dataset.kind));
    const formats={bold:'bold',italic:'italic',strikethrough:'strikethrough',highlight:'highlight',subscript:'subscript',superscript:'superscript',inline_code:'inline_code'};
    const display={line_numbers:'show_code_line_numbers',heading_levels:'show_heading_levels',paragraph_marks:'show_paragraph_marks'};
    for(const button of buttons){const command=button.dataset.command;if(formats[command]||display[command])button.setAttribute('aria-pressed',String(display[command]?this.options[display[command]]:kinds.has(formats[command])));}
  }
  input_event(event, run) {
    this.typing_input = event.inputType;
    try { return run(); } finally { this.typing_input = null; }
  }
  editing_mode() {
    if(this.source_view||this.options.mode==='markdown')return 'markdown';
    if(this.options.mode==='rich')return 'rich';
    const {anchor,focus}=this.selection;
    const revealed=[...this.surface.querySelectorAll('[data-revealed]')].some(node=>+node.dataset.start<=Math.min(anchor,focus)&&Math.max(anchor,focus)<=+node.dataset.end);
    if(revealed)return 'markdown';
    // Plain paragraphs need no source decoration; retain literal typing policy.
    const paragraph=[...this.surface.querySelectorAll('section[data-block] > p')].find(node=>+node.parentElement.dataset.start<=Math.min(anchor,focus)&&Math.max(anchor,focus)<=+node.parentElement.dataset.end);
    if(paragraph&&!paragraph.querySelector('[data-kind]')&&this.should_reveal('paragraph'))return 'markdown';
    return 'rich';
  }
  begin_source_session(start,end) {
    if(this.pending_source_exit)return;
    if(this.options.mode==='hybrid'&&this.editing_mode()==='markdown'&&!this.source_edit_session){
      const block=[...this.surface.querySelectorAll('[data-revealed]')].find(node=>+node.dataset.start<=start&&end<=+node.dataset.end);
      if(block)this.source_edit_session={kind:block.dataset.kind,start:+block.dataset.start,end:+block.dataset.end};
    }
  }
  source_delete(inputType) {
    const at=this.selection.focus,backwards=!inputType.includes('Forward');
    if(inputType.includes('Word')){
      const source=this.state.source,index=byte_to_utf16(source,at),part=backwards?source.slice(0,index):source.slice(index);
      const segments=[...new Intl.Segmenter(undefined,{granularity:'word'}).segment(part)];
      if(backwards){while(segments.length&&!segments.at(-1).segment.trim())segments.pop();const target=segments.at(-1);return this.replace('',target?byte_length(part.slice(0,target.index)):0,at);}
      let to=0;for(const segment of segments){to=segment.index+segment.segment.length;if(segment.segment.trim())break;}
      return this.replace('',at,at+byte_length(part.slice(0,to)));
    }
    const [start,end]=grapheme_range(this.state.source,at,backwards);return this.replace('',start,end);
  }
  source_enter() {
    const line=this.line_range(),at=Math.min(this.selection.anchor,this.selection.focus);
    const prefix=byte_slice(this.state.source,line.start,at);
    const code=[...this.editing_markup().querySelectorAll('pre')].some(node=>+node.dataset.start<=at&&at<+node.dataset.end);
    if(!code){
      const list=prefix.match(/^([ \t]*)([-+*]|(\d+)([.)]))[ \t]+(\[[ xX]\][ \t]+)?(.*)$/u);
      if(list){
        if(!list[6].trim()&&at===line.end){
          if(list[1])return this.replace('',line.start,line.start+byte_length(list[1].startsWith('\t')?'\t':list[1].slice(0,Math.min(4,list[1].length))));
          this.pending_source_exit=true;this.source_edit_session=null;return this.replace('\n',line.start,line.end,line.start+1);
        }
        const marker=list[3]?String(Number(list[3])+1)+list[4]:list[2];
        return this.replace('\n'+list[1]+marker+' '+(list[5]?'[ ] ':''));
      }
      const quote=prefix.match(/^([ \t]*> ?)(.*)$/u);
      if(quote){if(!quote[2].trim()&&at===line.end){this.pending_source_exit=true;this.source_edit_session=null;return this.replace('\n',line.start,line.end,line.start+1);}return this.replace('\n'+quote[1]);}
    }
    return this.replace('\n');
  }
  source_indent(outdent) {
    const start=Math.min(this.selection.anchor,this.selection.focus),end=Math.max(this.selection.anchor,this.selection.focus),source=this.state.source;
    if(start===end&&!outdent&&!/^\s*(?:[-+*]|\d+[.)])[ \t]/u.test(this.line_range().text))return this.replace('    ');
    const prefix=byte_slice(source,0,start),from=byte_length(prefix.slice(0,prefix.lastIndexOf('\n')+1));
    const selected=byte_slice(source,from,end),lines=selected.split('\n');
    const mapped=lines.map(line=>outdent?line.replace(/^(?:\t| {1,4})/u,''):'    '+line);
    const delta=byte_length(mapped[0])-byte_length(lines[0]);
    this.replace(mapped.join('\n'),from,end,Math.max(from,start+delta));
  }
  before_input(event) {
    if (this.options.read_only || this.reading) { event.preventDefault(); return; }
    if (event.isComposing || this.composing || event.inputType === 'insertCompositionText') return;
    if (this.composition_commit != null && event.data === this.composition_commit) { event.preventDefault(); return; }
    event.preventDefault(); this.capture_selection();
    if (event.inputType === 'historyUndo') return this.run('undo');
    if (event.inputType === 'historyRedo') return this.run('redo');
    if (event.inputType.startsWith('delete')) {
      if (this.selection.anchor !== this.selection.focus) return this.replace('');
      const backwards = !event.inputType.includes('Forward');
      if(this.editing_mode()==='markdown')return this.source_delete(event.inputType);
      if(this.rich_delete_guard(backwards))return;
      if (this.editing_mode() !== 'markdown') {
        const boundary = backwards ? 'end' : 'start';
        const edge = this.inline_edge(this.selection.focus, backwards);
        const line_break = [...this.editing_markup().querySelectorAll('br[data-break]')].find(br => Number(br.dataset[boundary]) === edge);
        if (line_break) return this.replace('', Number(line_break.dataset.start), Number(line_break.dataset.end));
        const entity = [...this.surface.querySelectorAll('[data-text]')].find(span => {
          const raw = byte_slice(this.state.source, Number(span.dataset.start), Number(span.dataset.end));
          return Number(span.dataset[boundary]) === this.selection.focus && /^&(?:#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]+);$/.test(raw) && raw !== span.textContent;
        });
        if (entity) return this.replace('', Number(entity.dataset.start), Number(entity.dataset.end));
        if (this.merge_paragraph_boundary(backwards)) return;
      }
      const pair = this.pairs.find(pair => pair.start === this.selection.focus);
      if (backwards && pair && this.options.auto_close.delete_empty_pair && byte_slice(this.state.source, pair.start - byte_length(pair.open), pair.start) === pair.open) {
        return this.replace('', pair.start - byte_length(pair.open), pair.start + byte_length(pair.close));
      }
      if (this.delete_displayed_character(backwards)) return;
      const [start, end] = grapheme_range(this.state.source, this.selection.focus, backwards);
      return this.replace('', start, end);
    }
    if (event.inputType === 'insertParagraph') return this.editing_mode()==='markdown'?this.source_enter():this.enter();
    if (event.inputType === 'insertLineBreak') return this.editing_mode()==='markdown'?this.replace('  \n'):this.run('hard_break');
    if (event.inputType === 'insertText' || event.inputType === 'insertReplacementText') return this.type_text(event.data || '');
    if (event.inputType.startsWith('format')) {
      const map = { formatBold: 'bold', formatItalic: 'italic', formatStrikeThrough: 'strikethrough' }; if (map[event.inputType]) this.run(map[event.inputType]);
    }
  }
  merge_paragraph_boundary(backwards) {
    const caret = this.text_caret();
    if (!caret || !(backwards ? caret.at_start : caret.at_end)) return false;
    const blocks = this.text_blocks(), index = blocks.indexOf(caret.block);
    const left = backwards ? blocks[index - 1] : caret.block, right = backwards ? caret.block : blocks[index + 1];
    if (!left || !right || right.localName !== 'p') return false;
    const start = Number(left.parentElement.dataset.end), end = Number(right.parentElement.dataset.start);
    if (!/^(?:[ \t]*\n)+$/u.test(byte_slice(this.state.source, start, end))) return false;
    this.replace('', start, end, start); return true;
  }
  rich_delete_guard(backwards) {
    const at=this.selection.focus,markup=this.editing_markup();
    for(const input of markup.querySelectorAll('[data-task]')){
      const item=input.closest('li'),start=+item.dataset.start,raw=byte_slice(this.state.source,start,+item.dataset.end);
      const match=raw.match(/^(?:[ \t]*)(?:[-+*]|\d+[.)])[ \t]+(\[[ xX]\])([ \t]?)/u);
      if(!match)continue;
      const marker=start+byte_length(match[0])-byte_length(match[1]+match[2]),end=marker+byte_length(match[1]+match[2]);
      if(backwards&&at>=marker+3&&at<=end || !backwards&&at===marker){this.replace('',marker,end,marker);return true;}
    }
    const sections=[...markup.querySelectorAll('section[data-block]')];
    const target=sections.find(section=>{
      const block=section.firstElementChild;if(!block||block.matches('p,h1,h2,h3,h4,h5,h6'))return false;
      const edge=+(backwards?section.dataset.end:section.dataset.start);
      return backwards?edge<=at&&/^[ \t\n]*$/u.test(byte_slice(this.state.source,edge,at)):edge>=at&&/^[ \t\n]*$/u.test(byte_slice(this.state.source,at,edge));
    });
    if(!target)return false;
    const start=+target.dataset.start,end=+target.dataset.end,source=this.state.source;
    this.show_dialog('블록 삭제', '<p>이 블록을 삭제하시겠습니까?</p>',()=>{
      if(this.state.source!==source){this.report(new Error('문서가 변경되었습니다. 삭제할 블록을 다시 확인해 주세요.'));return;}
      this.replace('',start,end,start);this.focus();
    });
    this.dialog.querySelector('[value="apply"]').textContent='예';return true;
  }
  move_inline_character(key) {
    if(this.editing_mode()!=='rich')return false;
    const backwards=key==='ArrowLeft',at=this.selection.focus,markup=this.editing_markup();
    const inline=[...markup.querySelectorAll('[data-kind]')].filter(node=>['bold','italic','strikethrough','highlight','subscript','superscript','inline_code','link'].includes(node.dataset.kind));
    const edge=inline.find(node=>+(backwards?node.dataset.end:node.dataset.start)===at);
    if(!edge)return false;
    const spans=[...edge.querySelectorAll('[data-text]')],span=backwards?spans.at(-1):spans[0];if(!span)return false;
    const raw=byte_slice(this.state.source,+span.dataset.start,+span.dataset.end);
    const range=grapheme_range(raw,backwards?byte_length(raw):0,backwards);
    this.set_selection(+span.dataset.start+range[backwards?0:1]);return true;
  }
  delete_displayed_character(backwards) {
    let caret = this.text_caret();
    if(!caret){const [node]=this.source_to_dom(this.selection.focus),element=node.nodeType===1?node:node.parentElement,block=element?.closest('li,td,th,pre,blockquote');if(block){const spans=[...block.querySelectorAll('[data-text]')];caret={block,spans,at_start:false,at_end:false};}}
    if (!caret) return true;
    // A rendered block edge cannot delete hidden Markdown punctuation.
    if (backwards ? caret.at_start : caret.at_end) return true;
    const position = this.selection.focus;
    const span = backwards ? caret.spans.filter(span => Number(span.dataset.start) < position).at(-1)
      : caret.spans.find(span => Number(span.dataset.end) > position);
    if (!span) return true;
    const from = Number(span.dataset.start), to = Number(span.dataset.end);
    const raw = byte_slice(this.state.source, from, to), displayed = span.textContent;
    let start = from, end = to;
    if (raw === displayed || raw.startsWith('\\') && raw.slice(1) === displayed) {
      const escape = raw === displayed ? 0 : 1;
      const offset = Math.max(0, Math.min(byte_length(displayed), position - from - escape));
      const range = grapheme_range(displayed, offset, backwards);
      start = from + escape + range[0]; end = from + escape + range[1];
      if (escape && start === from + 1) start = from;
    }
    // Remove an emptied inline construct as a unit (including nested delimiters).
    for (const element of caret.block.querySelectorAll('[data-kind]')) {
      if (!['bold','italic','strikethrough','highlight','subscript','superscript','link','inline_code'].includes(element.dataset.kind)) continue;
      if (element.querySelector('img,br,input')) continue;
      const texts = [...element.querySelectorAll('[data-text]')];
      if (texts.length && Number(texts[0].dataset.start) >= start && Number(texts.at(-1).dataset.end) <= end) {
        start = Math.min(start, Number(element.dataset.start)); end = Math.max(end, Number(element.dataset.end));
      }
    }
    this.replace('', start, end, start); return true;
  }
  source_changed() {
    const input = this.source_input, value = input.value;
    const start_selection = input.selectionStart, end_selection = input.selectionEnd, direction = input.selectionDirection;
    let start = 0;
    while (start < value.length && start < this.state.source.length && value[start] === this.state.source[start]) start++;
    if (start > 0 && /[\uD800-\uDBFF]/u.test(value[start - 1])) start--;
    let old_end = this.state.source.length, new_end = value.length;
    while (old_end > start && new_end > start && this.state.source[old_end - 1] === value[new_end - 1]) { old_end--; new_end--; }
    if (old_end < this.state.source.length && /[\uDC00-\uDFFF]/u.test(this.state.source[old_end])) { old_end++; new_end++; }
    if (value !== this.state.source) this.replace(value.slice(start, new_end), utf16_to_byte(this.state.source, start), utf16_to_byte(this.state.source, old_end));
    if (this.core.replica && value !== this.state.source) { this.set_selection(this.state.anchor,this.state.focus); return; }
    const a = utf16_to_byte(value, start_selection), f = utf16_to_byte(value, end_selection);
    const group=this.typing_group;
    this.set_selection(direction === 'backward' ? f : a, direction === 'backward' ? a : f);
    this.typing_group=group;
  }
  at_visual_line_start(position) {
    const [node, offset] = this.source_to_dom(position);
    const element = node.nodeType === 1 ? node : node.parentElement;
    const block = element.closest('p,h1,h2,h3,h4,h5,h6,td,th,li') || element.closest('[data-block]') || this.surface;
    const range = document.createRange(); range.selectNodeContents(block); range.setEnd(node, offset);
    const last_break = [...block.querySelectorAll('br[data-break]')].findLast(br => Number(br.dataset.end) <= position);
    if (last_break) range.setStartAfter(last_break);
    return /^[ \u00a0]*$/u.test(range.toString().split('\n').at(-1));
  }
  type_text(text) {
    const start = Math.min(this.selection.anchor, this.selection.focus), end = Math.max(this.selection.anchor, this.selection.focus);
    if(text===' '&&start===end&&this.editing_mode()==='markdown'&&!this.source_view){
      const line=this.line_range(),prefix=byte_slice(this.state.source,line.start,start);
      if(prefix==='|'&&line.text.trim()==='|'){
        const table=[...this.editing_markup().querySelectorAll('[data-kind="table"]')].find(node=>{
          const from=+node.dataset.start,to=+node.dataset.end;
          return from<line.start&&(to>=line.start||byte_slice(this.state.source,to,line.start)==='\n');
        });
        const columns=table?.querySelector('table')?.rows[0]?.cells.length;
        if(columns){
          const row='| '+Array(columns).fill('').join(' | ')+' |';
          this.replace(row,line.start,line.end,line.start+2);return;
        }
      }
    }
    const auto = this.options.auto_close;
    const context = this.active_kind();
    const empty_task = [...this.surface.querySelectorAll('.empty_task_caret')].find(span => Number(span.dataset.start) === start);
    if (start === end && !this.source_view && this.editing_mode() !== 'markdown' && empty_task
        && /\[[ xX]\]$/u.test(this.line_range().text)) {
      this.replace(' ' + (text === ' ' ? '&nbsp;' : text)); return;
    }
    if (text === ' ' && start === end && !this.source_view && this.editing_mode() !== 'markdown'
        && !['code_block', 'inline_code', 'comment', 'front_matter'].includes(context) && this.at_visual_line_start(start)) {
      this.replace('&nbsp;'); return;
    }
    const tracked = this.pairs.find(pair => pair.start === start && pair.close.startsWith(text));
    if (auto.enabled && tracked && start === end && ['*', '_'].includes(text) && tracked.open === text && auto.pairs.bold) {
      this.pairs = this.pairs.filter(pair => pair !== tracked);
      this.replace(text.repeat(3), start, start + 1, start + 1);
      this.pairs.push({ start: start + 1, open: text.repeat(2), close: text.repeat(2) }); return;
    }
    if (auto.enabled && tracked && start === end && auto.skip_closing) {
      tracked.start += byte_length(text); tracked.close = tracked.close.slice(text.length);
      this.pairs = this.pairs.filter(pair => pair.close); this.set_selection(start + byte_length(text)); return;
    }
    if (auto.enabled && !['code_block', 'inline_code', 'comment', 'front_matter'].includes(context)) {
      const before = byte_slice(this.state.source, 0, start);
      const candidates = [['<!--', '-->', 'html_comment'], ['**', '**', 'bold'], ['~~', '~~', 'strikethrough'], ['==', '==', 'highlight'], ['`', '`', 'inline_code'], ['[', ']', 'link_brackets'], ['*', '*', 'italic'], ['_', '_', 'italic']];
      if (auto.wrap_selection && start !== end && ['*', '_', '~', '`', '['].includes(text)) {
        const closer = text === '[' ? ']' : text;
        this.replace(text + byte_slice(this.state.source, start, end) + closer, start, end, end + byte_length(text)); return;
      }
      for (const [open, close, key] of candidates) {
        if (auto.pairs[key] && (before + text).endsWith(open)) {
          const previous = this.state;
          this.replace(text + close, start, end, start + byte_length(text));
          this.detect_autoformat(previous);
          this.pairs.push({ start: start + byte_length(text), open, close }); return;
        }
      }
    }
    const previous = this.state;
    this.replace(text);
    this.detect_autoformat(previous);
  }
  detect_autoformat(previous) {
    const focus = this.selection.focus;
    const element = [...this.surface.querySelectorAll('[data-kind]')].find(element => ['bold', 'italic', 'strikethrough', 'highlight', 'subscript', 'superscript', 'heading', 'list', 'quote'].includes(element.dataset.kind) && Number(element.dataset.start) <= focus && Number(element.dataset.end) >= focus);
    if (!element) { this.auto_transform = null; return; }
    const start = Number(element.dataset.start), end = Number(element.dataset.end);
    if (!previous.html.includes(`data-kind="${element.dataset.kind}" data-start="${start}"`)) this.auto_transform = { revision: this.state.revision, start, end };
  }
  active_kind() {
    const position = this.selection.focus;
    return [...this.surface.querySelectorAll('[data-kind]')].filter(element => Number(element.dataset.start) <= position && Number(element.dataset.end) >= position).at(-1)?.dataset.kind;
  }
  line_range() {
    const source = this.state.source, focus = byte_to_utf16(source, this.selection.focus);
    const start = source.lastIndexOf('\n', focus - 1) + 1, next = source.indexOf('\n', focus);
    const end = next < 0 ? source.length : next;
    return { start: utf16_to_byte(source, start), end: utf16_to_byte(source, end), text: source.slice(start, end) };
  }
  editing_markup() {
    // Commands use parser coordinates, never syntax-revealed or decorated live DOM.
    if (this.editing_html !== this.state.html) {
      const template = document.createElement('template'); template.innerHTML = this.state.html;
      this.editing_tree = template.content; this.editing_html = this.state.html;
    }
    return this.editing_tree;
  }
  inline_edge(position, backwards) {
    let edge = position;
    for (const element of this.editing_markup().querySelectorAll('[data-kind]')) {
      if (!['bold','italic','strikethrough','highlight','subscript','superscript','link','inline_code'].includes(element.dataset.kind)) continue;
      const spans = [...element.querySelectorAll('[data-text]')], text = backwards ? spans[0] : spans.at(-1);
      if (text && Number(text.dataset[backwards ? 'start' : 'end']) === position) {
        const raw = Number(element.dataset[backwards ? 'start' : 'end']);
        edge = backwards ? Math.min(edge, raw) : Math.max(edge, raw);
      }
    }
    return edge;
  }
  text_blocks() {
    return [...this.editing_markup().querySelectorAll('section[data-block] > p,section[data-block] > h1,section[data-block] > h2,section[data-block] > h3,section[data-block] > h4,section[data-block] > h5,section[data-block] > h6')]
      .filter(block => !block.closest('li,blockquote,td,th,pre') && block.querySelector('[data-text]'));
  }
  text_caret() {
    if (this.source_view || this.editing_mode() === 'markdown' || this.selection.anchor !== this.selection.focus) return null;
    const focus = this.selection.focus;
    const block = this.text_blocks().find(block => Number(block.parentElement.dataset.start) <= focus && focus <= Number(block.parentElement.dataset.end));
    if (!block) return null;
    const spans = [...block.querySelectorAll('[data-text]')], first = spans[0], last = spans.at(-1);
    const start = Number(block.parentElement.dataset.start), end = Number(block.parentElement.dataset.end);
    const visible = [...block.querySelectorAll('[data-text],br,img,input')];
    return { block, spans, start, end,
      at_start: focus === start || visible[0] === first && (focus === Number(first.dataset.start) || focus === this.inline_edge(Number(first.dataset.start), true)),
      at_end: focus === end || visible.at(-1) === last && (focus === Number(last.dataset.end) || focus === this.inline_edge(Number(last.dataset.end), false)) };
  }
  inline_opening_position() {
    return this.source_view || this.editing_mode() === 'markdown' || this.selection.anchor !== this.selection.focus
      ? this.selection.focus : this.inline_edge(this.selection.focus, true);
  }
  table_source_enter() {
    if(this.source_view||this.editing_mode()!=='rich'||this.selection.anchor!==this.selection.focus)return false;
    const at=this.selection.focus,before=byte_slice(this.state.source,0,at);
    if(!before.endsWith('|')||['code_block','inline_code','front_matter','comment'].includes(this.active_kind()))return false;
    const escapes=before.slice(0,-1).match(/\\+$/u)?.[0].length||0;if(escapes%2)return false;
    this.table_entry_caret=at+1;
    if(this.core.replica)this.core.source_mode=true;
    try{this.replace('\n',at,at,at+1);}finally{if(this.core.replica)this.core.source_mode=this.source_view||this.options.mode==='markdown';}
    return true;
  }
  paragraph_enter() {
    if(this.source_view||this.editing_mode()!=='rich'||this.selection.anchor!==this.selection.focus)return false;
    const focus=this.selection.focus,markup=this.editing_markup();
    const block=[...markup.querySelectorAll('p,h1,h2,h3,h4,h5,h6')].find(node=>{const section=node.closest('[data-block]');return section&&+section.dataset.start<=focus&&focus<=+section.dataset.end;});
    if(!block||block.closest('li,td,th,pre,blockquote'))return false;
    const section=block.closest('[data-block]'),breaks=[...block.querySelectorAll('br[data-break]')];
    const left=breaks.filter(br=>+br.dataset.end<=focus).at(-1),right=breaks.find(br=>+br.dataset.start>=focus);
    const spans=[...block.querySelectorAll('[data-text]')].filter(span=>(!left||+span.dataset.start>=+left.dataset.end)&&(!right||+span.dataset.end<=+right.dataset.start));
    const visible=span=>span.textContent.replace(/\u00a0/gu,'').length>0;
    const before=spans.some(span=>visible(span)&&+span.dataset.start<focus),after=spans.some(span=>visible(span)&&+span.dataset.end>focus);
    if(!before){const at=left?this.inline_edge(focus,true):+section.dataset.start;this.replace('&nbsp;\n\n',at,at,focus+byte_length('&nbsp;\n\n'));return true;}
    if(!after){const at=right?this.inline_edge(focus,false):+section.dataset.end;this.replace('\n\n&nbsp;',at,at,at+2);return true;}
    let close='',open='';
    for(const node of block.querySelectorAll('[data-kind]')){
      if(!['bold','italic','strikethrough','highlight','subscript','superscript','link','inline_code'].includes(node.dataset.kind))continue;
      const texts=[...node.querySelectorAll('[data-text]')];if(!texts.length)continue;
      const start=+texts[0].dataset.start,end=+texts.at(-1).dataset.end;
      if(start<focus&&focus<end){open+=byte_slice(this.state.source,+node.dataset.start,start);close=byte_slice(this.state.source,end,+node.dataset.end)+close;}
    }
    const opening=this.inline_edge(focus,true),at=opening<focus?opening:this.inline_edge(focus,false);
    this.replace(close+'\n\n'+open,at,at,at+byte_length(close+'\n\n'+open));return true;
  }
  enter() {
    if(this.table_source_enter())return;
    if (this.active_cell()) return this.run('hard_break');
    if(this.paragraph_enter())return;
    const line = this.line_range();
    const caret = this.text_caret();
    if (caret?.at_start) return this.replace('&nbsp;\n\n', caret.start, caret.start, this.selection.focus+byte_length('&nbsp;\n\n'));
    if (this.active_kind() === 'code_block' || this.active_kind() === 'front_matter') return this.replace('\n');
    const list = line.text.match(/^(\s*)([-+*]|\d+[.)]) (\[[ xX]\](?: |$))?/u);
    if (list) {
      if (line.text.slice(list[0].length).trim() === '') return this.replace('', line.start, line.end);
      const marker = /^\d/u.test(list[2]) ? `${parseInt(list[2]) + 1}.` : list[2];
      if (this.selection.anchor === this.selection.focus && this.selection.focus === line.start + byte_length(list[0])) {
        const prefix = list[0].trimEnd();
        return this.replace(`${prefix}\n${list[1]}${marker} ${list[3] ? '[ ] ' : ''}`, line.start, this.selection.focus);
      }
      return this.replace(`\n${list[1]}${marker} ${list[3] ? '[ ] ' : ''}`);
    }
    if (line.text.startsWith('> ')) return this.replace('\n> ');
    if (caret?.at_end) {
      const start = caret.end;
      const remaining = byte_slice(this.state.source, start, byte_length(this.state.source));
      const gap = remaining.match(/^(?:[ \t]*\n)+/u)?.[0] || '';
      return this.replace('\n\n&nbsp;' + (remaining.slice(gap.length) ? '\n\n' : ''), start, start + byte_length(gap), start + 2);
    }
    const opening = this.inline_opening_position();
    if (opening < this.selection.focus) return this.replace('\n\n', opening, opening);
    this.replace('\n\n');
  }
  move_line_break(key) {
    if (this.source_view || this.html_view || this.reading || this.editing_mode() === 'markdown' || this.selection.anchor !== this.selection.focus) return false;
    const forwards = key === 'ArrowRight';
    const br = [...this.surface.querySelectorAll('br[data-break]')].find(br => Number(br.dataset[forwards ? 'start' : 'end']) === this.selection.focus);
    if (!br) return false;
    this.set_selection(Number(br.dataset[forwards ? 'end' : 'start']));
    this.refresh_syntax(); return true;
  }
  move_block_boundary(key) {
    if (this.source_view || this.html_view || this.reading || this.editing_mode() === 'markdown' || this.selection.anchor !== this.selection.focus || this.active_cell()) return false;
    const caret = this.text_caret();
    if (caret) {
      if (!(key === 'ArrowRight' ? caret.at_end : caret.at_start)) return false;
      const edge = key === 'ArrowRight' ? caret.spans.at(-1) : caret.spans[0];
      if ([...caret.block.querySelectorAll('br[data-break]')].some(br => key === 'ArrowRight' ? Number(br.dataset.start) >= Number(edge.dataset.end) : Number(br.dataset.end) <= Number(edge.dataset.start))) return false;
      const all = [...this.editing_markup().querySelectorAll('[data-text]')];
      const target = all[all.indexOf(edge) + (key === 'ArrowRight' ? 1 : -1)];
      if (!target) return false;
      this.set_selection(Number(target.dataset[key === 'ArrowRight' ? 'start' : 'end'])); this.refresh_syntax(); return true;
    }
    const [node] = this.source_to_dom(this.selection.focus);
    const element = node.nodeType === 1 ? node : node.parentElement;
    const block = element.closest('p,h1,h2,h3,h4,h5,h6,li,dt,dd');
    if (!block || block.closest('pre')) return false;
    const spans = [...block.querySelectorAll('[data-text]')];
    const edge = key === 'ArrowRight' ? spans.at(-1) : spans[0];
    if (!edge || Number(edge.dataset[key === 'ArrowRight' ? 'end' : 'start']) !== this.selection.focus) return false;
    if ([...block.querySelectorAll('br[data-break]')].some(br => key === 'ArrowRight' ? Number(br.dataset.start) >= this.selection.focus : Number(br.dataset.end) <= this.selection.focus)) return false;
    const all = [...this.surface.querySelectorAll('[data-text]')];
    const target = all[all.indexOf(edge) + (key === 'ArrowRight' ? 1 : -1)];
    if (!target) return false;
    this.set_selection(Number(target.dataset[key === 'ArrowRight' ? 'start' : 'end']));
    this.refresh_syntax(); return true;
  }
  move_visual_line_edge(event) {
    if (!['Home','End'].includes(event.key) || event.ctrlKey || event.metaKey || event.altKey || this.html_view) return false;
    const forward=event.key==='End';
    if(this.source_view){
      const input=this.source_input,focus=input.selectionDirection==='backward'?input.selectionStart:input.selectionEnd;
      const target=forward?input.value.indexOf('\n',focus):input.value.lastIndexOf('\n',focus-1)+1;
      const end=target<0?input.value.length:target;
      const anchor=event.shiftKey?(input.selectionDirection==='backward'?input.selectionEnd:input.selectionStart):end;
      input.setSelectionRange(Math.min(anchor,end),Math.max(anchor,end),end<anchor?'backward':'forward');
    }else{
      const selection=this.dom_selection();
      if(!selection?.focusNode||!this.surface.contains(selection.focusNode))return false;
      if(typeof selection.modify==='function')selection.modify(event.shiftKey?'extend':'move',forward?'forward':'backward','lineboundary');
      else{
        const line=this.line_range(),target=forward?line.start+byte_length(line.text):line.start;
        this.set_selection(event.shiftKey?this.selection.anchor:target,target);
      }
    }
    event.preventDefault();this.capture_selection();this.refresh_syntax();return true;
  }
  keydown(event) {
    if (/^(Arrow|Home|End|Page|Escape)/u.test(event.key)) this.typing_group=null;
    if (event.isComposing || this.composing) return;
    this.capture_selection();
    if(this.move_visual_line_edge(event))return;
    const modifier = event.ctrlKey || event.metaKey;
    const digit=event.code?.match(/^Digit([0-9])$/u)?.[1]||(/^[0-9]$/u.test(event.key)?event.key:null);
    if(modifier&&event.altKey&&!event.shiftKey&&digit!==null){
      event.preventDefault();const target=({0:'p',7:'pre',8:'blockquote',9:'details'})[digit]||'h'+digit;
      try{this.convert_current_block(target);}catch(error){this.report(error);}return;
    }
    // Formatting shortcuts use physical B/I keys even with a Korean input source.
    const shortcutKey=modifier&&!event.altKey&&['KeyB','KeyI'].includes(event.code)?event.code.slice(3).toLowerCase():event.key.toLowerCase();
    const key = `${modifier ? 'mod+' : ''}${event.shiftKey ? 'shift+' : ''}${event.altKey ? 'alt+' : ''}${shortcutKey}`;
    const bindings = { 'mod+b': 'bold', 'mod+i': 'italic', 'mod+k': 'link', 'mod+z': 'undo', 'mod+shift+z': 'redo', 'mod+y': 'redo',
      'mod+shift+c': 'copy_markdown', 'mod+s': 'save', 'mod+shift+u': 'unlink', 'mod+shift+x': 'strikethrough',
      ...Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`mod+alt+${i + 1}`, `heading_${i + 1}`])),
      ...Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`mod+${i + 1}`, `heading_${i + 1}`])), ...this.options.keybindings };
    if (bindings[key]) { event.preventDefault(); this.run(bindings[key]); return; }
    // Command palette makes every toolbar command keyboard reachable without reserved shortcuts.
    if (modifier && event.shiftKey && event.key.toLowerCase() === 'p') { event.preventDefault(); this.command_palette(); return; }
    if (event.key === 'Escape') { event.preventDefault(); this.cell_selection = null; this.paint_cells(); this.root.querySelector('select').focus(); return; }
    if(event.key==='Tab'&&!this.source_view&&this.editing_mode()==='markdown'){event.preventDefault();this.source_indent(event.shiftKey);return;}
    if (event.key === 'Tab' && !this.source_view) {
      const selection=this.dom_selection(),node=selection?.focusNode,element=node?.nodeType===1?node:node?.parentElement;
      const dom_cell=element?.closest('[data-cell]');
      if(dom_cell&&this.surface.contains(dom_cell)&&this.editing_mode()!=='markdown'){
        event.preventDefault();this.set_selection(Number(dom_cell.dataset.start));this.move_cell(event.shiftKey?-1:1);
      }
      else if (this.active_cell()) { event.preventDefault(); this.move_cell(event.shiftKey ? -1 : 1); }
      else if (/^\s*(?:[-+*]|\d+[.)]) /u.test(this.line_range().text)) { event.preventDefault(); this.run(event.shiftKey ? 'outdent' : 'indent'); }
    }
    if (!event.shiftKey && !modifier && !event.altKey && ['ArrowLeft','ArrowRight'].includes(event.key) && (this.move_inline_character(event.key) || this.move_line_break(event.key) || this.move_block_boundary(event.key))) { event.preventDefault(); return; }
    // Rich and hybrid share source-coordinate table navigation.
    if (!this.source_view && this.editing_mode()==='rich' && !event.shiftKey && !modifier && event.key.startsWith('Arrow')) this.cell_arrow(event);
  }
  async run(command) {
    try { await this.execute_command(command); } catch (error) { this.report(error); }
  }
  async execute_command(command) {
    this.assert_active();
    if (typeof command !== 'string' || !COMMANDS.has(command)) throw new TypeError('Unknown editor command');
    this.typing_group = null;
    this.root.querySelector('.errors').textContent = '';
    if (this.composing) return;
    const read_command = ['save', 'save_local', 'save_session', 'clear_session', 'open', 'open_link', 'copy_markdown'].includes(command);
    if ((this.options.read_only || this.reading || this.html_view) && !read_command) return;
    if (this.active_cell() && (command==='table'||command.startsWith('heading_')||['quote','list','ordered_list','task','code_block','details','alert'].includes(command))) { this.report(new Error('표 셀에는 인라인 내용만 허용합니다. 중첩 표와 블록 삽입은 사용할 수 없습니다.')); return; }
    const display_options = { line_numbers: 'show_code_line_numbers', heading_levels: 'show_heading_levels', paragraph_marks: 'show_paragraph_marks' };
    if (display_options[command]) { this.set_options({ [display_options[command]]: !this.options[display_options[command]] }); return; }
    if (command === 'undo' || command === 'redo') {
      if (!this.state[command === 'undo' ? 'can_undo' : 'can_redo']) return;
      const previous_source = this.state.source;
      if (command === 'undo' && this.auto_transform?.revision === this.state.revision) {
        const { start, end } = this.auto_transform;
        const literal = byte_slice(this.state.source, start, end).replace(/([\\`*_~=#>\[\]!.+-])/gu, '\\$1');
        this.state = this.core.request(10, literal, start, end);
      } else this.state = this.core.request(command === 'undo' ? 5 : 6);
      this.map_dialog_from_sources(previous_source, this.state.source);
      this.auto_transform = null; this.selection = { anchor: this.state.anchor, focus: this.state.focus }; this.pairs = []; this.render(); this.focus(); this.emit_change(); return;
    }
    const wrappers = { bold: ['**', '**'], italic: ['*', '*'], strikethrough: ['~~', '~~'], highlight: ['==', '=='], subscript: ['~', '~'], superscript: ['^', '^'], inline_code: ['`', '`'], comment: ['<!--', '-->'], details: ['<details>\n<summary>제목</summary>\n\n', '\n</details>'], code_block: ['```\n', '\n```'] };
    if(command==='save_session')return this.save_session();
    if(command==='clear_session')return this.clear_session();
    if(command==='load_session'){if(!this.load_session())this.root.querySelector('.state').textContent='현재 탭에 임시 저장된 문서가 없습니다.';return;}
    if(command==='save_local')return this.save_local();
    if(command==='load_local'){if(!this.load_local())this.root.querySelector('.state').textContent='브라우저에 저장된 문서가 없습니다.';return;}
    if (wrappers[command]) {
      const [open, close] = wrappers[command], start = Math.min(this.selection.anchor, this.selection.focus), end = Math.max(this.selection.anchor, this.selection.focus);
      const selected = byte_slice(this.state.source, start, end);
      if (start === end) {
        const active = [...this.editing_markup().querySelectorAll('[data-kind]')].find(element => element.dataset.kind === command && Number(element.dataset.start) <= start && Number(element.dataset.end) >= end);
        if (active) {
          const from = Number(active.dataset.start), to = Number(active.dataset.end), raw = byte_slice(this.state.source, from, to);
          if (raw.startsWith(open) && raw.endsWith(close)) { this.replace(raw.slice(open.length, -close.length), from, to, Math.max(from, Math.min(to - byte_length(open + close), start - byte_length(open)))); this.focus(); return; }
        }
      }
      if (selected.startsWith(open) && selected.endsWith(close) && selected.length >= open.length + close.length) this.replace(selected.slice(open.length, -close.length));
      else this.replace(open + selected + close, start, end, start + byte_length(open + selected));
      this.focus(); return;
    }
    if (command.startsWith('heading_') || ['paragraph', 'quote', 'list', 'ordered_list', 'task', 'indent', 'outdent', 'alert'].includes(command)) {
      const line = this.line_range();
      if (command === 'indent') { this.replace('    ' + line.text, line.start, line.end); }
      else if (command === 'outdent') this.replace(line.text.replace(/^( {1,4}|\t)/u, ''), line.start, line.end);
      else {
        const prefix = command.startsWith('heading_') ? '#'.repeat(Number(command.slice(-1))) + ' ' : ({ paragraph: '', quote: '> ', list: '- ', ordered_list: '1. ', task: '- [ ] ', alert: '> [!NOTE]\n> ' })[command];
        this.replace(prefix + line.text.replace(/^(#{1,6} |> |(?:[-+*]|\d+[.)]) (?:\[[ xX]\] )?)/u, ''), line.start, line.end);
      }
      this.focus(); return;
    }
    if (command === 'hard_break') {
      const literal = ['code_block', 'comment', 'front_matter'].includes(this.active_kind());
      let position = this.inline_opening_position();
      if (!literal && position < this.selection.focus) {
        const text = position === this.line_range().start ? '<br>\n' : '<br>';
        this.replace(text, position, position, position + byte_length(text)); this.focus(); return;
      }
      const consumed = new Set();
      if (!literal && !this.source_view && this.editing_mode() !== 'markdown' && this.selection.anchor === position) {
        // Exit only still-tracked generated closers, never arbitrary source syntax.
        for (;;) {
          const pair = this.pairs.find(pair => !consumed.has(pair) && pair.start === position
            && byte_slice(this.state.source, position, position + byte_length(pair.close)) === pair.close);
          if (!pair) break;
          consumed.add(pair); position += byte_length(pair.close);
        }
      }
      if (consumed.size) {
        this.pairs = this.pairs.filter(pair => !consumed.has(pair));
        this.replace('<br>', position, position);
      } else this.replace(literal ? '\n' : '<br>');
      this.focus(); return;
    }
    if (command === 'link') return this.link_dialog();
    if (command === 'unlink') {
      const link = this.active_link(); if (!link) return;
      const start = Number(link.dataset.start), end = Number(link.dataset.end), raw = byte_slice(this.state.source, start, end);
      const label = raw.match(/^\[((?:\\.|[^\]])*)\]/u)?.[1] || raw;
      this.replace(label, start, end); return;
    }
    if (command === 'open_link') { const link = this.active_link(); if (link) this.open_anchor(link); return; }
    if (command === 'footnote') {
      const name = `note-${this.state.revision + 1n}`;
      const start = Math.min(this.selection.anchor, this.selection.focus);
      const text = byte_slice(this.state.source, 0, start) + `[^${name}]` + byte_slice(this.state.source, Math.max(this.selection.anchor, this.selection.focus)) + `\n\n[^${name}]: 각주 내용`;
      this.replace(text, 0, byte_length(this.state.source), start + byte_length(`[^${name}]`)); return;
    }
    if (command === 'table') { this.replace('\n| 제목 | 제목 |\n| --- | --- |\n|  |  |\n\n'); this.focus(); return; }
    if (command === 'table_tools') return this.table_dialog();
    if (command === 'attachment') { this.root.querySelector('.file_input').click(); return; }
    if (command === 'copy_markdown') { await navigator.clipboard.writeText(byte_slice(this.state.source, Math.min(this.selection.anchor, this.selection.focus), Math.max(this.selection.anchor, this.selection.focus)) || this.get_markdown()); return; }
    if (command === 'save') {
      const markdown = this.get_markdown({normalize:!this.state.draft}); const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = this.options.filename || 'document.md'; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      this.mark_saved(); this.dispatchEvent(new CustomEvent('save', { detail: { markdown } })); return;
    }
    if (command === 'open') {
      const input = document.createElement('input'); input.type = 'file'; input.accept = '.md,.markdown,.txt,text/markdown,text/plain';
      const revision = this.state.revision;
      input.onchange = async () => {
        try {
          if (!this.core || !input.files[0]) return;
          const source = await input.files[0].text();
          if (!this.core) return;
          if (this.state.revision !== revision) throw new Error('Document changed while opening the file');
          this.set_markdown(source);
        } catch (error) { this.report(error); }
      }; input.click();
    }
  }
  command_palette() {
    const commands = [...this.toolbar.querySelectorAll('button')];
    this.show_dialog('명령 실행', `<label>명령<select name="command">${commands.map(button => `<option value="${button.dataset.command}">${button.title}</option>`).join('')}</select></label>`, data => this.run(data.get('command')));
  }
  map_dialog_from_sources(before, after) {
    if (!this.dialog.open || before === after) return;
    let start = 0, suffix = 0;
    while (start < before.length && start < after.length && before[start] === after[start]) start++;
    if (start && /[\uD800-\uDBFF]/u.test(before[start - 1])) start--;
    while (suffix < before.length - start && suffix < after.length - start && before.at(-suffix - 1) === after.at(-suffix - 1)) suffix++;
    if (suffix && /[\uDC00-\uDFFF]/u.test(before[before.length - suffix])) suffix--;
    this.map_dialog_positions(utf16_to_byte(before, start), utf16_to_byte(before, before.length - suffix), byte_length(after.slice(start, after.length - suffix)));
  }
  map_dialog_positions(start, end, inserted) {
    if (!this.dialog.open) return;
    const map = position => position < start ? position : position > end ? position - (end - start) + inserted : start + inserted;
    if (this.dialog_selection) this.dialog_selection = { anchor: map(this.dialog_selection.anchor), focus: map(this.dialog_selection.focus) };
    if (this.dialog_range) this.dialog_range = { start: map(this.dialog_range.start), end: map(this.dialog_range.end) };
  }
  show_dialog(title, fields, callback) {
    this.dialog.querySelector('[value="apply"]').textContent='적용';
    this.dialog_selection = { ...this.selection }; this.dialog_scroll = this.surface.scrollTop; this.dialog_range = null;
    this.dialog.querySelector('h2').textContent = title;
    this.dialog.querySelector('.fields').innerHTML = fields;
    this.dialog_callback = callback; this.dialog.returnValue = 'cancel'; this.dialog.showModal(); this.dialog.querySelector('input,select')?.focus();
  }
  active_link() { const focus = this.selection.focus; return [...this.surface.querySelectorAll('a[data-kind="link"]')].find(link => Number(link.dataset.start) <= focus && Number(link.dataset.end) >= focus); }
  link_dialog() {
    const link = this.active_link();
    const start = link ? Number(link.dataset.start) : Math.min(this.selection.anchor, this.selection.focus), end = link ? Number(link.dataset.end) : Math.max(this.selection.anchor, this.selection.focus);
    const raw = byte_slice(this.state.source, start, end);
    const label = link ? raw.match(/^\[((?:\\.|[^\]])*)\]/u)?.[1] || raw : raw;
    this.show_dialog('링크', `<label>표시 텍스트<input name="label" value="${escape_html(label)}"></label><label>주소<input name="url" type="text" value="${escape_html(link?.getAttribute('href') || '')}" required></label>`, data => {
      const url = data.get('url'); if (!safe_url(url)) { this.report(new Error('허용하지 않는 링크 주소입니다.')); return; }
      const range = this.dialog_range || { start, end };
      this.replace(`[${data.get('label').replace(/[\[\]\\]/gu, '\\$&')}](${url.replace(/\(/gu, '%28').replace(/\)/gu, '%29')})`, range.start, range.end);
    });
    this.dialog_range = { start, end };
  }
  open_anchor(anchor) {
    const url = anchor.getAttribute('href');
    if (anchor.hasAttribute('download') && url?.startsWith('data:')) {
      const [prefix, body] = url.split(',');
      const binary = atob(body), bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
      const object_url = URL.createObjectURL(new Blob([bytes], { type: prefix.slice(5).split(';')[0] }));
      const download = document.createElement('a'); download.href = object_url; download.download = anchor.getAttribute('download') || 'attachment'; download.click(); setTimeout(() => URL.revokeObjectURL(object_url), 1000); return;
    }
    if (!url || !safe_url(url)) return;
    if (url.startsWith('#')) {
      const name = decodeURIComponent(url.slice(1)); const target = this.root.getElementById(name) || this.root.querySelector(`[name="${CSS.escape(name)}"]`); target?.scrollIntoView({ block: 'center' }); return;
    }
    window.open(new URL(url, document.baseURI), '_blank', 'noopener,noreferrer');
  }
  active_cell() { const focus = this.selection.focus; return [...this.surface.querySelectorAll('[data-cell]')].find(cell => Number(cell.dataset.start) <= focus && Number(cell.dataset.end) >= focus); }
  move_cell(direction) {
    const cell = this.active_cell(); if (!cell) return;
    const cells = [...cell.closest('table').querySelectorAll('[data-cell]')], index = cells.indexOf(cell), next = cells[index + direction];
    if (next) { this.set_selection(Number(next.dataset.start)); this.focus(); return; }
    if (direction > 0) {
      if(this.options.read_only||this.reading||this.composing)return;
      const row=Number(cell.dataset.row)+1;this.cell_selection=null;
      this.table_action('row_after');this.move_to_cell(row,0);
    }
    else this.exit_table(-1);
  }
  move_to_cell(row, column) {
    const cells = [...this.surface.querySelectorAll('[data-cell]')];
    const cell = cells.find(cell => Number(cell.dataset.row) === row && Number(cell.dataset.column) === column && Number(cell.dataset.start) >= (this.table_start || 0));
    if (cell) { this.set_selection(Number(cell.dataset.start), Number(cell.dataset.start), true); this.focus(); }
  }
  cell_arrow(event) {
    const cell = this.active_cell(); if (!cell || this.selection.anchor !== this.selection.focus) return;
    const focus = this.selection.focus;
    const at_start = focus === Number(cell.dataset.start), at_end = focus === Number(cell.dataset.end);
    if (event.key === 'ArrowLeft' && at_start || event.key === 'ArrowRight' && at_end) { event.preventDefault(); this.move_cell(event.key === 'ArrowLeft' ? -1 : 1); }
    if (event.key === 'ArrowUp' && at_start || event.key === 'ArrowDown' && at_end) {
      event.preventDefault();
      const row = Number(cell.dataset.row) + (event.key === 'ArrowUp' ? -1 : 1), column = Number(cell.dataset.column);
      const target = cell.closest('table').querySelector(`[data-row="${row}"][data-column="${column}"]`);
      if (target) this.set_selection(Number(target.dataset.start));
      else this.exit_table(event.key === 'ArrowUp' ? -1 : 1);
    }
  }
  exit_table(direction) {
    const cell = this.active_cell(); if (!cell) return;
    const block = cell.closest('[data-block]');
    const position = Number(block.dataset[direction < 0 ? 'start' : 'end']);
    if (direction < 0 && position === 0) this.replace('\n', 0, 0, 0);
    else if (direction > 0 && position === byte_length(this.state.source)) this.replace('\n\n', position, position, position + 2);
    else this.set_selection(position + direction);
    this.focus();
  }
  table_dialog() {
    if (!this.active_cell()) return;
    this.show_dialog('표 도구', `<label>작업<select name="action"><option value="row_before">위에 행 삽입</option><option value="row_after">아래에 행 삽입</option><option value="column_before">왼쪽에 열 삽입</option><option value="column_after">오른쪽에 열 삽입</option><option value="move_row_up">선택 행 위로 이동</option><option value="move_row_down">선택 행 아래로 이동</option><option value="move_column_left">선택 열 왼쪽으로 이동</option><option value="move_column_right">선택 열 오른쪽으로 이동</option><option value="delete_rows">선택 행 삭제</option><option value="delete_columns">선택 열 삭제</option><option value="select_row">행 선택</option><option value="select_column">열 선택</option><option value="clear">선택 셀 비우기</option><option value="align_left">왼쪽 정렬</option><option value="align_center">가운데 정렬</option><option value="align_right">오른쪽 정렬</option><option value="exit_before">표 앞으로 이동</option><option value="exit_after">표 뒤로 이동</option><option value="delete_table">표 삭제</option></select></label>`, data => this.table_action(data.get('action')));
  }
  convert_current_block(target) {
    if(this.options.read_only||this.reading||this.source_view||this.html_view||this.composing)return;
    const focus=this.selection.focus;
    const section=[...this.editing_markup().children].find(node=>+node.dataset.start<=focus&&focus<=+node.dataset.end);
    const content=section?.firstElementChild;if(!content)return;
    const kind=content.matches('h1,h2,h3,h4,h5,h6,p,pre,blockquote')?content.localName:content.matches('div')&&content.querySelector(':scope > details')?'details':null;
    if(!kind||content.matches('.raw_block,.front_matter,.reference_definition'))return;
    const block=content.cloneNode(true);block.dataset.start=section.dataset.start;block.dataset.end=section.dataset.end;block.dataset.conversionKind=kind;
    this.block_conversion(block,target);
  }
  block_conversion(block, target) {
    if(this.options.read_only||this.reading||this.source_view||this.html_view||this.composing)return;
    const start=+block.dataset.start,end=+block.dataset.end;
    const raw=byte_slice(this.state.source,start,end),kind=block.dataset.conversionKind;
    if(kind===target)return;
    let body=raw;
    if(/^h[1-6]$/u.test(kind))body=raw.replace(/^ {0,3}#{1,6}[ \t]+/u,'').replace(/[ \t]+#+[ \t]*$/u,'').replace(/\n {0,3}(?:=+|-+)[ \t]*$/u,'').replace(/[ \t]+\{#[^}]+\}[ \t]*$/u,'');
    if(kind==='pre'){
      const match=raw.match(/^ {0,3}(`{3,}|~{3,})[^\n]*\n([\s\S]*?)(?:\n {0,3}(?:`{3,}|~{3,})[ \t]*)?$/u);
      const literal=match?match[2]:raw.replace(/^(?: {4}|\t)/gmu,'');
      const node=document.createElement('div');node.textContent=literal;body=html_to_markdown(node.innerHTML);
    }
    if(kind==='blockquote')body=raw.split('\n').map(line=>line.replace(/^ {0,3}>[ \t]?/u,'')).join('\n').replace(/^\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\n|$)/iu,'');
    if(kind==='details')body=raw.replace(/^\s*<details\b[^>]*>/iu,'').replace(/<summary\b[^>]*>[\s\S]*?<\/summary>/iu,'').replace(/<\/details>\s*$/iu,'').trim();
    let replacement;
    if(/^h[1-6]$/u.test(target))replacement='#'.repeat(+target[1])+' '+body.replace(/\n/gu,'<br>');
    else if(target==='p')replacement=body||'&nbsp;';
    else if(target==='blockquote')replacement=(body||'&nbsp;').split('\n').map(line=>'> '+line).join('\n');
    else if(target==='details')replacement='<details>\n<summary>제목</summary>\n\n'+(body||'&nbsp;')+'\n\n</details>';
    else if(target==='pre'){
      const canonical=[...this.editing_markup().children].find(node=>+node.dataset.start===start&&+node.dataset.end===end)?.firstElementChild;
      const clone=(canonical||block).cloneNode(true);clone.querySelectorAll('.alert_label,summary,.break_mark,[data-caret]').forEach(node=>node.remove());
      const text=node=>node.nodeType===3?node.data:node.nodeType!==1?'':node.localName==='br'?'\n':[...node.childNodes].map(text).join('')+(/^(p|h[1-6]|li|dt|dd)$/u.test(node.localName)?'\n':'');
      const literal=kind==='pre'?body:text(clone).replace(/^\n+|\n+$/gu,'');
      const ticks='`'.repeat(Math.max(3,...[...literal.matchAll(/`+/gu)].map(match=>match[0].length+1)));
      replacement=ticks+'\n'+literal.replace(/\n$/u,'')+'\n'+ticks;
    }else return;
    this.replace(replacement,start,end,start);this.focus();
  }
  add_block_switcher() {
    if(!this.block_switcher){
      const select=this.block_switcher=document.createElement('select');select.className='block_switcher';select.hidden=true;select.setAttribute('aria-label','블록 유형 전환');select.title='블록 유형 전환';
      for(const [value,label] of [['h1','H₁ 제목 1'],['h2','H₂ 제목 2'],['h3','H₃ 제목 3'],['h4','H₄ 제목 4'],['h5','H₅ 제목 5'],['h6','H₆ 제목 6'],['pre','⌘ 코드 블록'],['blockquote','❞ 인용문'],['details','▸ 접기'],['p','¶ 문단']]){const option=document.createElement('option');option.value=value;const digit=/^h[1-6]$/u.test(value)?value[1]:({pre:'7',blockquote:'8',details:'9',p:'0'})[value];option.textContent=label+' · Ctrl/Cmd+Alt/Option+'+digit;select.append(option);}
      this.surface.parentElement.append(select);
      this.on(this.root,'pointermove',event=>{
        if(event.target===select||this.dragging||this.composing)return;
        if(this.options.read_only||this.reading||this.source_view||this.html_view||!['rich','hybrid'].includes(this.options.mode)){select.hidden=true;return;}
        let found=null;
        for(const block of this.conversion_blocks||[]){const r=block.getBoundingClientRect();if(event.clientX>=r.left-34&&event.clientX<=r.right&&event.clientY>=r.top-5&&event.clientY<=r.bottom){found=block;break;}}
        select.hidden=!found;if(!found)return;
        this.conversion_target={block:found,source:this.state.source};select.value=found.dataset.conversionKind;
        const r=found.getBoundingClientRect(),parent=select.parentElement.getBoundingClientRect();select.style.left=Math.max(2,r.left-parent.left-38)+'px';select.style.top=(r.top-parent.top)+'px';
      });
      this.on(select,'pointerdown',event=>{event.stopPropagation();});
      this.on(select,'change',()=>{const pending=this.conversion_target;if(!pending||pending.source!==this.state.source||!pending.block.isConnected){select.hidden=true;return;}try{this.block_conversion(pending.block,select.value);}catch(error){this.report(error);}});
      this.on(this.root,'pointerleave',()=>{if(this.root.activeElement!==select)select.hidden=true;});
    }
    this.block_switcher.hidden=true;this.conversion_blocks=[];
    if(!['rich','hybrid'].includes(this.options.mode)||this.reading||this.options.read_only||this.source_view||this.html_view)return;
    const markup=this.editing_markup();
    for(const section of [...markup.children].filter(node=>node.matches('section[data-block]'))){
      const content=section.firstElementChild;if(!content)continue;
      const kind=content.matches('h1,h2,h3,h4,h5,h6,p,pre,blockquote')?content.localName:content.matches('div')&&content.querySelector(':scope > details')?'details':null;
      if(!kind||content.matches('.raw_block,.front_matter,.reference_definition'))continue;
      const start=section.dataset.start,end=section.dataset.end;
      const live=[...this.surface.querySelectorAll('[data-block]')].find(node=>node.dataset.start===start&&node.dataset.end===end);
      const block=live?.matches('section')?live.firstElementChild:live;
      if(!block)continue;block.dataset.conversionKind=kind;block.dataset.start=start;block.dataset.end=end;this.conversion_blocks.push(block);
    }
  }
  add_table_handles() {
    if (!this.row_grip) {
      const grip=this.row_grip=document.createElement('button');
      grip.type='button';grip.className='row_grip';grip.hidden=true;grip.tabIndex=-1;grip.textContent='⠿';
      grip.setAttribute('aria-label','행 이동');grip.title='드래그하여 행 이동 · Alt+위/아래 방향키';
      this.surface.parentElement.append(grip);
      this.on(this.root,'pointermove',event=>{
        if(this.row_drag||event.target===grip)return;
        if(this.reading||this.source_view||this.html_view||this.options.read_only){grip.hidden=true;return;}
        let hovered=null;
        for(const table of this.surface.querySelectorAll('table')){
          const rect=table.getBoundingClientRect();
          if(event.clientX<rect.left-30||event.clientX>rect.right)continue;
          hovered=[...table.rows].slice(1).find(row=>{const r=row.getBoundingClientRect();return event.clientY>=r.top&&event.clientY<r.bottom;});
          if(hovered)break;
        }
        this.grip_cell=hovered?.cells[0];grip.hidden=!hovered;
        if(hovered){const r=hovered.getBoundingClientRect(),parent=grip.parentElement.getBoundingClientRect();grip.style.left=(r.left-parent.left-27)+'px';grip.style.top=(r.top-parent.top+r.height/2-14)+'px';grip.setAttribute('aria-label',`${hovered.rowIndex+1}행 이동`);}
      });
      this.on(this.root,'pointerleave',()=>{if(!this.row_drag)grip.hidden=true;});
      this.on(grip,'pointerdown',event=>{
        if(event.button!==0||!this.grip_cell||this.options.read_only||this.reading||this.composing)return;
        event.preventDefault();this.capture_selection();this.dragging=true;
        const cell=this.grip_cell;this.row_drag={cell,table:cell.closest('table'),from:+cell.dataset.row,slot:null};
        grip.classList.add('dragging');grip.setPointerCapture(event.pointerId);
      });
      this.on(document,'pointermove',event=>{
        const drag=this.row_drag;if(!drag)return;event.preventDefault();this.clear_table_drop();drag.slot=null;
        const rect=drag.table.getBoundingClientRect();if(event.clientX<rect.left-60||event.clientX>rect.right+60)return;
        const rows=[...drag.table.rows].slice(1),row=rows.find(row=>{const r=row.getBoundingClientRect();return event.clientY>=r.top&&event.clientY<=r.bottom;})||(event.clientY>rect.bottom?rows.at(-1):event.clientY<rows[0]?.getBoundingClientRect().top?rows[0]:null);
        if(!row)return;const r=row.getBoundingClientRect(),after=event.clientY>r.top+r.height/2;
        drag.slot=row.rowIndex+(after?1:0);for(const cell of row.cells)cell.dataset.drop='row'+(after?'-after':'-before');
      });
      this.on(document,'pointerup',()=>{
        const drag=this.row_drag;if(!drag)return;this.row_drag=null;this.dragging=false;grip.classList.remove('dragging');this.clear_table_drop();
        if(drag.slot!==null)try{this.move_table_axis(drag.cell,'row',drag.from,drag.from,drag.slot);}catch(error){this.report(error);}
        grip.hidden=true;
      });
      const cancel=()=>{if(this.row_drag){this.row_drag=null;this.dragging=false;grip.classList.remove('dragging');grip.hidden=true;this.clear_table_drop();}};
      this.on(document,'pointercancel',cancel);this.on(grip,'keydown',event=>{
        if(event.key==='Escape'){cancel();return;}
        if(event.altKey&&['ArrowUp','ArrowDown'].includes(event.key)&&this.grip_cell){event.preventDefault();const cell=this.grip_cell,index=+cell.dataset.row;try{this.move_table_axis(cell,'row',index,index,index+(event.key==='ArrowUp'?-1:2));}catch(error){this.report(error);}}
      });
    }
    this.row_grip.hidden=true;
  }
  clear_table_drop(){this.surface.querySelectorAll('[data-drop]').forEach(cell=>delete cell.dataset.drop);}
  cancel_table_drag(){this.dragging=false;this.handle_drag=null;this.drag_cell=null;this.clear_table_drop();}
  move_table_axis(cell,axis,from,to,slot){
    if(this.options.read_only||this.reading||this.composing||!cell?.isConnected)return;
    if(!['row','column'].includes(axis))throw new Error('Invalid table axis');
    const table=cell.closest('table'),block=cell.closest('[data-block]'),start=+block.dataset.start,end=+block.dataset.end;
    const length=axis==='row'?table.rows.length:table.rows[0].cells.length;
    if(from<0||to<from||to>=length||slot<0||slot>length)return;
    if(axis==='row'&&(from===0||slot===0))return; // Markdown header stays pinned.
    const indices=Array.from({length},(_,i)=>i),targets=indices.slice(from,to+1),before=indices.slice(slot).find(i=>!targets.includes(i));
    const order=indices.filter(i=>!targets.includes(i)),at=before===undefined?order.length:order.indexOf(before);order.splice(at,0,...targets);
    if(order.every((value,index)=>value===index))return;
    this.table_start=start;this.set_selection(+cell.dataset.start);
    if(this.core.reorder_table){
      const projection=this.core.replica.snapshot.projection.find(table=>start>=table.start&&start<=table.end);
      const view=this.core.replica.snapshot.tables.find(table=>table.id===projection?.id);
      if(!view)throw new Error('원본 표의 열 수를 맞춘 뒤 이동해 주세요.');
      const ids=axis==='row'?view.rows:view.columns;
      this.state=this.core.reorder_table(view.id,axis,targets.map(i=>ids[i]),before===undefined?null:ids[before]);
      this.selection={anchor:this.state.anchor,focus:this.state.focus};this.cell_selection=null;this.pairs=[];this.render();this.emit_change();
    }else{
      const rows=[...table.rows].map(row=>[...row.cells].map(cell=>byte_slice(this.state.source,+cell.dataset.start,+cell.dataset.end)));
      let align=[...table.rows[0].cells].map(cell=>cell.classList.contains('align_right')?'---:':cell.classList.contains('align_center')?':---:':'---');
      const arranged=axis==='row'?order.map(i=>rows[i]):rows.map(row=>order.map(i=>row[i]));
      if(axis==='column')align=order.map(i=>align[i]);
      const format=row=>'| '+row.join(' | ')+' |';this.cell_selection=null;
      this.replace([format(arranged[0]),format(align),...arranged.slice(1).map(format)].join('\n'),start,end,start);
    }
    const row=axis==='row'?at:+cell.dataset.row,column=axis==='column'?at:+cell.dataset.column;
    this.move_to_cell(row,column);this.core.request(11,'',this.selection.anchor,this.selection.focus);
    const moved=[...this.surface.querySelectorAll(`[data-${axis}-handle="${axis==='row'?row:column}"]`)].find(handle=>+handle.closest('[data-block]').dataset.start===start);moved?.focus();
    this.root.querySelector('.announce').textContent=`${axis==='row'?'행':'열'}을 ${at+1}번째 위치로 이동했습니다.`;
  }
  select_cell_rectangle(first, last) {
    const table = first.closest('table');
    if (this.drag_axis === 'row') this.cell_selection = { first: table.rows[+first.dataset.row].cells[0], last: table.rows[+last.dataset.row].cells[table.rows[+last.dataset.row].cells.length - 1] };
    else if (this.drag_axis === 'column') this.cell_selection = { first: table.rows[0].cells[+first.dataset.column], last: table.rows[table.rows.length - 1].cells[+last.dataset.column] };
    else this.cell_selection = { first, last };
    this.paint_cells();
  }
  paint_cells() {
    this.surface.querySelectorAll('[data-selected]').forEach(cell => cell.removeAttribute('data-selected'));
    if (!this.cell_selection) return;
    const { first, last } = this.cell_selection;
    for (const cell of first.closest('table').querySelectorAll('[data-cell]')) {
      const row = Number(cell.dataset.row), column = Number(cell.dataset.column);
      if (row >= Math.min(+first.dataset.row, +last.dataset.row) && row <= Math.max(+first.dataset.row, +last.dataset.row) && column >= Math.min(+first.dataset.column, +last.dataset.column) && column <= Math.max(+first.dataset.column, +last.dataset.column)) cell.dataset.selected = '1';
    }
  }
  table_action(action) {
    const cell = this.active_cell(); if (!cell) return;
    if (action === 'exit_before' || action === 'exit_after') return this.exit_table(action === 'exit_before' ? -1 : 1);
    const block = cell.closest('[data-block]'), start = Number(block.dataset.start), end = Number(block.dataset.end), row = Number(cell.dataset.row), column = Number(cell.dataset.column);
    this.table_start = start;
    const rows = [...cell.closest('table').rows].map(row => [...row.cells].map(cell => byte_slice(this.state.source, Number(cell.dataset.start), Number(cell.dataset.end))));
    const selected = this.cell_selection;
    const r1 = selected ? Math.min(+selected.first.dataset.row, +selected.last.dataset.row) : row, r2 = selected ? Math.max(+selected.first.dataset.row, +selected.last.dataset.row) : row;
    const c1 = selected ? Math.min(+selected.first.dataset.column, +selected.last.dataset.column) : column, c2 = selected ? Math.max(+selected.first.dataset.column, +selected.last.dataset.column) : column;
    if(action.startsWith('move_')){
      const axis=action.startsWith('move_row')?'row':'column',from=axis==='row'?r1:c1,to=axis==='row'?r2:c2;
      return this.move_table_axis(cell,axis,from,to,action.endsWith('up')||action.endsWith('left')?from-1:to+2);
    }
    let align = [...cell.closest('table').rows[0].cells].map(cell => cell.classList.contains('align_right') ? '---:' : cell.classList.contains('align_center') ? ':---:' : '---');
    if (action === 'select_row' || action === 'select_column') {
      const table = cell.closest('table');
      this.cell_selection = action === 'select_row' ? { first: table.rows[row].cells[0], last: table.rows[row].cells[rows[row].length - 1] } : { first: table.rows[0].cells[column], last: table.rows[rows.length - 1].cells[column] };
      this.paint_cells(); return;
    }
    if (this.core.table_action) {
      this.state = this.core.table_action(start, action, row, column, [r1,r2,c1,c2]);
      this.selection = {anchor:this.state.anchor,focus:this.state.focus}; this.cell_selection = null; this.pairs = []; this.render();
      const view = this.core.replica.snapshot.projection.find(table => start >= table.start && start <= table.end);
      if (view?.cells.length) this.move_to_cell(Math.min(row, this.core.replica.snapshot.tables.find(table => table.id === view.id).rows.length-1),Math.min(column,this.core.replica.snapshot.tables.find(table => table.id === view.id).columns.length-1));
      this.emit_change(); return;
    }
    if (action === 'delete_table') { this.cell_selection = null; this.replace('', start, end); return; }
    if (action === 'row_before' || action === 'row_after') rows.splice(action === 'row_before' ? Math.max(1, row) : row + 1, 0, Array(align.length).fill(''));
    if (action === 'column_before' || action === 'column_after') { const at = column + (action === 'column_after' ? 1 : 0); rows.forEach(row => row.splice(at, 0, '')); align.splice(at, 0, '---'); }
    if (action === 'delete_rows') { rows.splice(r1, r2 - r1 + 1); }
    if (action === 'delete_columns') { rows.forEach(row => row.splice(c1, c2 - c1 + 1)); align.splice(c1, c2 - c1 + 1); }
    if (action === 'clear') for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) rows[r][c] = '';
    if (action.startsWith('align_')) for (let c = c1; c <= c2; c++) align[c] = action === 'align_center' ? ':---:' : action === 'align_right' ? '---:' : '---';
    this.cell_selection = null;
    if (!rows.length || !align.length) { this.replace('', start, end); return; }
    const format = row => '| ' + row.join(' | ') + ' |';
    const text = [format(rows[0]), format(align), ...rows.slice(1).map(format)].join('\n');
    this.replace(text, start, end, start);
    this.move_to_cell(Math.min(row, rows.length - 1), Math.min(column, align.length - 1));
  }
  async paste(event) {
    event.preventDefault(); if (this.options.read_only || this.reading || this.composing) return;
    this.capture_selection();
    try {
      const files = [...event.clipboardData.files]; if (files.length) return await this.add_files(files);
      const html = event.clipboardData.getData('text/html');
      const text = html && this.editing_mode()==='rich' ? html_to_markdown(html) : event.clipboardData.getData('text/plain');
      this.replace(text);
    } catch (error) { this.report(error); }
  }
  copy(event) {
    this.capture_selection();
    if (this.selection.anchor === this.selection.focus) return;
    event.preventDefault();
    const raw = byte_slice(this.state.source, Math.min(this.selection.anchor, this.selection.focus), Math.max(this.selection.anchor, this.selection.focus));
    let plain = raw;
    if (!this.source_view && this.dom_selection()?.rangeCount) {
      const copy = this.dom_selection().getRangeAt(0).cloneContents();
      copy.querySelectorAll('[contenteditable="false"]').forEach(element => element.remove());
      const wrapper = document.createElement('div'); wrapper.append(copy);
      plain = wrapper.textContent;
      wrapper.querySelectorAll('*').forEach(element => { for (const attribute of [...element.attributes]) if (!['href','src','alt','title','width','height'].includes(attribute.name)) element.removeAttribute(attribute.name); });
      event.clipboardData.setData('text/html', wrapper.innerHTML);
    }
    event.clipboardData.setData('text/plain', plain);
    event.clipboardData.setData('text/markdown', raw);
  }
  async add_files(files) {
    if (this.options.read_only || this.reading || this.composing || !files.length) return;
    try {
      const selection = { ...this.selection }, revision = this.state.revision;
      const max = this.options.attachments.max_file_size, total = this.options.attachments.max_total_size;
      const embedded = [...this.state.source.matchAll(/data:[^,\s]*;base64,([A-Za-z0-9+/=]+)/gu)].reduce((sum, match) => sum + Math.floor(match[1].length * 3 / 4) - (match[1].endsWith('==') ? 2 : match[1].endsWith('=') ? 1 : 0), 0);
      if (files.some(file => file.size > max) || embedded + files.reduce((sum, file) => sum + file.size, 0) > total) throw new Error('첨부 용량 제한을 초과했습니다.');
      for (const file of files) {
        if (/^image\/(png|jpeg|gif|webp|avif)$/iu.test(file.type) ? !this.options.images.enabled : !this.options.attachments.enabled) throw new Error('첨부가 비활성화되어 있습니다.');
      }
      const markdown = await Promise.all(files.map(async file => file_markdown(file, await read_file(file))));
      if (this.state.revision !== revision) throw new Error('첨부를 읽는 동안 문서가 변경되었습니다. 다시 삽입해 주세요.');
      this.selection = selection; this.replace('\n' + markdown.join('\n') + '\n'); this.focus();
    } catch (error) { this.report(error); }
  }
  ensure_caret_visible() {
    if (!this.has_focus()) return;
    const viewport = window.visualViewport;
    const range = this.dom_selection()?.rangeCount ? this.dom_selection().getRangeAt(0) : null;
    const rect = range?.getBoundingClientRect();
    if (rect && viewport && rect.bottom > viewport.height + viewport.offsetTop - 32) this.surface.scrollTop += rect.bottom - viewport.height - viewport.offsetTop + 48;
    this.active_cell()?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  report(error) { const errors = this.root.querySelector('.errors'), state = this.root.querySelector('.state'); if (errors) errors.textContent = error.message; if (state) state.textContent = error.message; this.dispatchEvent(new CustomEvent('error', { detail: error })); }
}
