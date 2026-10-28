// UTF-8 source coordinates are authoritative; DOM points are a view projection.
import {byte_length,byte_slice,byte_to_utf16} from './core.js';
export class SourceMap {
  constructor(editor){this.editor=editor;}
  semantic_edge(element,position){
    if(element.closest('[data-revealed],.styled_markdown'))return position;
    let result=position;
    for(let node=element.closest('[data-kind]');node&&this.editor.surface.contains(node);node=node.parentElement?.closest('[data-kind]')){
      if(!['bold','italic','highlight','strikethrough','subscript','superscript','inline_code','link'].includes(node.dataset.kind))continue;
      const texts=[...node.querySelectorAll('[data-text]')];
      if(texts.length&&+texts.at(-1).dataset.end===position)result=Math.max(result,+node.dataset.end);
      if(texts.length&&+texts[0].dataset.start===position)result=Math.min(result,+node.dataset.start);
    }
    return result;
  }
  dom_to_source(node, offset) {
    const element = node.nodeType === 1 ? node : node.parentElement;
    if(!element)return 0;
    const decoration = element.closest('.break_mark');
    if (decoration?.nextElementSibling?.matches('br[data-break]')) return Number(decoration.nextElementSibling.dataset.start);
    const text = element.closest('[data-text]');
    if (text) {
      const range = document.createRange(); range.setStart(text, 0); range.setEnd(node, offset);
      const displayed = text.textContent, before = range.toString();
      const start = Number(text.dataset.start), end = Number(text.dataset.end), raw = byte_slice(this.editor.state.source, start, end);
      if (raw === displayed) return this.semantic_edge(element,start+byte_length(before));
      if (raw.startsWith('\\') && raw.slice(1) === displayed) return this.semantic_edge(element,start+1+byte_length(before));
      return before.length ? end : start;
    }
    // Browsers may put a caret in the literal space between a task input
    // and its coordinate wrapper instead of in the first label text node.
    if (node.nodeType === 3 && /^[ \t]*$/u.test(node.textContent) && element.matches('li.list_item')
        && node.previousSibling?.matches?.('input[data-task]')) {
      const label = node.nextSibling?.querySelector?.('[data-text]');
      if (label) return Number(label.dataset.start);
    }
    if (node.nodeType === 1) {
      const previousTask=node.childNodes[offset-1];
      if(previousTask?.matches?.('input[data-task]')){
        const label=node.querySelector('[data-text]');
        if(label)return Number(label.dataset.start);
        const start=Number(node.dataset.start),raw=byte_slice(this.editor.state.source,start,Number(node.dataset.end));
        const prefix=raw.match(/^[ \t]*(?:[-+*]|\d+[.)])[ \t]+\[[ xX]\][ \t]?/u);
        if(prefix)return start+byte_length(prefix[0]);
      }
      const after = node.childNodes[offset];
      const target = after?.nodeType === 1 ? (after.matches('[data-text]') ? after : after.querySelector('[data-text]')) : null;
      if (target) return Number(target.dataset.start);
      const previous = node.childNodes[offset - 1];
      if (previous?.nodeType === 1 && previous.matches('[data-break]')) return Number(previous.dataset.end);
      if (after?.nodeType === 1 && after.matches('[data-break]')) return Number(after.dataset.start);
      const spans = previous?.nodeType === 1 ? [...previous.querySelectorAll('[data-text]')] : [];
      if (previous?.nodeType === 1 && previous.matches('[data-text]')) spans.push(previous);
      if (spans.length) return Number(spans.at(-1).dataset.end);
    }
    const owner = element.closest('[data-cell],[data-block]');
    return Number(owner?.dataset.start || 0);
  }
  visual_position(position) {
    if(position===this.editor.table_entry_caret)return position;
    if (this.editor.source_view || this.editor.editing_mode() === 'markdown') return position;
    const gap = [...this.editor.surface.querySelectorAll('[data-gap-start]')].find(block => Number(block.dataset.gapStart) <= position && position <= Number(block.dataset.gapEnd));
    if (!gap) return position;
    const next = gap.querySelector('[data-text]');
    if (next) return Number(next.dataset.start);
    const previous = [...(gap.previousElementSibling?.querySelectorAll('[data-text]') || [])].at(-1);
    return previous ? Number(previous.dataset.end) : position;
  }
  source_to_dom(position) {
    position = this.visual_position(position);
    const separator = [...this.editor.surface.querySelectorAll('.paragraph_separator')].find(block => Number(block.dataset.start) <= position && position <= Number(block.dataset.separatorEnd));
    if (separator && !separator.hasAttribute('data-gap')) return [separator.firstChild, 0];
    const line_break = [...this.editor.surface.querySelectorAll('br[data-break]')].find(br => Number(br.dataset.end) === position);
    if (line_break) return [line_break.parentNode, [...line_break.parentNode.childNodes].indexOf(line_break) + 1];
    const exactCell=[...this.editor.surface.querySelectorAll('[data-cell]')].find(cell=>+cell.dataset.start===position&&+cell.dataset.end===position);
    if(exactCell){const text=exactCell.querySelector('[data-text]');if(!text)return [exactCell,0];}
    const spans = [...this.editor.surface.querySelectorAll('[data-text]')].filter(span=>!span.classList.contains('markdown_eol'));
    let nearest;
    for (const span of spans) {
      const start = Number(span.dataset.start), end = Number(span.dataset.end);
      if (start <= position && position <= end) {
        const raw = byte_slice(this.editor.state.source, start, end), displayed = span.textContent;
        let offset = position === end ? displayed.length : 0;
        if (raw === displayed) offset = byte_to_utf16(raw, position - start);
        else if (raw.startsWith('\\') && raw.slice(1) === displayed) offset = byte_to_utf16(raw, Math.max(1, position - start)) - 1;
        if (!span.firstChild) span.append(document.createTextNode(''));
        return [span.firstChild, Math.max(0, offset)];
      }
      const distance = Math.min(Math.abs(position - start), Math.abs(position - end));
      if (!nearest || distance < nearest.distance) nearest = { span, distance, end: position > end };
    }
    const cell = [...this.editor.surface.querySelectorAll('[data-cell]')].find(cell => Number(cell.dataset.start) === position && Number(cell.dataset.end) === position);
    if (cell) return [cell, 0];
    const empty = [...this.editor.surface.children].find(block => Number(block.dataset.start) === position && Number(block.dataset.end) === position);
    if (empty) return [empty.firstChild || empty, 0];
    if (nearest) {
      if (!nearest.span.firstChild) nearest.span.append(document.createTextNode(''));
      return [nearest.span.firstChild, nearest.end ? nearest.span.textContent.length : 0];
    }
    return [this.editor.surface, 0];
  }
  restore_selection() {
    if (this.editor.html_view) return;
    const { anchor, focus } = this.editor.selection;
    if (this.editor.source_view) {
      this.editor.source_input.setSelectionRange(byte_to_utf16(this.editor.state.source, Math.min(anchor, focus)), byte_to_utf16(this.editor.state.source, Math.max(anchor, focus)), anchor > focus ? 'backward' : 'forward'); return;
    }
    const [a_node, a_offset] = this.source_to_dom(anchor), [f_node, f_offset] = this.source_to_dom(focus);
    this.editor.projected_selection = { source:this.editor.state.source, anchorNode: a_node, anchorOffset: a_offset, focusNode: f_node, focusOffset: f_offset };
    this.editor.dom_selection()?.setBaseAndExtent(a_node, a_offset, f_node, f_offset);
  }
}

// Rebase only a display session after a remote source change. Logical selection
// is restored by the shared replica's stable anchors, never by this text diff.
export function rebase_source_range(before,after,range){
  let prefix=0,oldEnd=before.length,newEnd=after.length;
  while(prefix<Math.min(oldEnd,newEnd)&&before[prefix]===after[prefix])prefix++;
  if(prefix&&/[\uD800-\uDBFF]/u.test(before[prefix-1]))prefix--;
  while(oldEnd>prefix&&newEnd>prefix&&before[oldEnd-1]===after[newEnd-1]){oldEnd--;newEnd--;}
  if(oldEnd<before.length&&/[\uDC00-\uDFFF]/u.test(before[oldEnd])){oldEnd++;newEnd++;}
  const start=byte_length(before.slice(0,prefix)),end=byte_length(before.slice(0,oldEnd)),length=byte_length(after.slice(prefix,newEnd)),shift=length-(end-start);
  const map=(position,bias)=>position<start?position:position>end?position+shift:position===end&&end>start?start+length:start+(bias==='after'?length:0);
  return {...range,start:map(range.start,'before'),end:map(range.end,'after')};
}
