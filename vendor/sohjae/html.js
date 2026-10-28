// Internal, dependency-free formatter for sanitized renderer output.
// Inline/mixed content and whitespace-sensitive elements remain byte-for-byte intact.
const blocks = new Set('address article aside blockquote caption dd details dialog div dl dt fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hr li main nav ol p pre section summary table tbody td tfoot th thead tr ul'.split(' '));
const voids = new Set('area base br col embed hr img input link meta param source track wbr'.split(' '));
export function pretty_html(html) {
  if (typeof html !== 'string') throw new TypeError('HTML must be a string');
  const root = {children:[]}, stack = [root];
  let cursor = 0;
  while (cursor < html.length) {
    const start = cursor;
    if (html[cursor] !== '<') {
      cursor = html.indexOf('<', cursor); if (cursor < 0) cursor = html.length;
      stack.at(-1).children.push({text:html.slice(start,cursor)}); continue;
    }
    if (html.startsWith('<!--',cursor)) {
      const end = html.indexOf('-->',cursor+4); if (end < 0) return html;
      cursor=end+3;stack.at(-1).children.push({text:html.slice(start,cursor)});continue;
    }
    let quote = null; cursor++;
    while (cursor < html.length) {
      const char = html[cursor];
      if (quote) { if (char === quote) quote=null; }
      else if (char === '"' || char === "'") quote=char;
      else if (char === '>') break;
      cursor++;
    }
    if (cursor === html.length) return html;
    cursor++;
    const token=html.slice(start,cursor), match=token.match(/^<(\/?)([a-z][\w:-]*)\b/iu);
    if (!match) return html;
    const tag=match[2].toLowerCase();
    if (match[1]) {
      if (stack.length===1 || stack.at(-1).tag!==tag) return html;
      const node=stack.pop();node.close=token;node.raw=html.slice(node.start,cursor);
    } else {
      const node={tag,open:token,close:'',children:[],start,raw:token};
      stack.at(-1).children.push(node);
      if (!voids.has(tag) && !token.endsWith('/>')) stack.push(node);
    }
  }
  if (stack.length!==1) return html;
  const format=(node,depth)=>{
    if (node.text!==undefined) return node.text;
    const structural=node.children.some(child=>blocks.has(child.tag))
      && node.children.every(child=>blocks.has(child.tag) || child.text!==undefined && /^\s*$/u.test(child.text));
    if (node.tag==='pre' || node.tag==='code' || node.tag==='textarea' || !structural) return node.raw;
    const children=node.children.filter(child=>child.tag).map(child=>'  '.repeat(depth+(node===root?0:1))+format(child,depth+(node===root?0:1))).join('\n');
    return node===root?children:node.open+'\n'+children+'\n'+'  '.repeat(depth)+node.close;
  };
  root.raw=html;
  return format(root,0);
}
