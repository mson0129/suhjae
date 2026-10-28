// Clipboard HTML is parsed in an inert document and converted to Markdown, never inserted.
const text_escape = text => text.replace(/([\\`*_\[\]~^=])/gu, '\\$1');
const label_escape = text => text.replace(/[\[\]\\]/gu, '\\$&');
export function safe_url(url, image = false) {
  if (/[\u0000-\u0020\\]/u.test(url) || url.startsWith('//')) return false;
  if (url.startsWith('data:')) return image && /^data:image\/(png|jpeg|gif|webp|avif);base64,/iu.test(url);
  return !/^[^/?#]*:/u.test(url) || /^https?:/iu.test(url) || (!image && /^mailto:/iu.test(url));
}

export function html_to_markdown(html) {
  const document = new DOMParser().parseFromString(html, 'text/html');
  const walk = node => {
    if (node.nodeType === 3) return text_escape(node.textContent);
    if (node.nodeType !== 1) return '';
    const tag = node.localName;
    if (['script', 'style', 'iframe', 'object', 'embed', 'noscript', 'svg', 'math', 'template'].includes(tag)) return '';
    const children = () => [...node.childNodes].map(walk).join('');
    if (tag === 'table') return table_to_markdown(node, walk);
    if (tag === 'br') return '<br>';
    if (tag === 'img') {
      const url = node.getAttribute('src') || '';
      return safe_url(url, true) ? `![${label_escape(node.getAttribute('alt') || '')}](${url})` : '';
    }
    if (tag === 'a') {
      const url = node.getAttribute('href') || '';
      return safe_url(url) ? `[${children()}](${url.replace(/\(/gu, '%28').replace(/\)/gu, '%29')})` : children();
    }
    if (tag === 'pre') {
      const text = node.textContent.replace(/\n$/u, '');
      const ticks = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/gu)].map(match => match[0].length + 1)));
      return `\n${ticks}\n${text}\n${ticks}\n`;
    }
    if (tag === 'code') {
      const text = node.textContent;
      const ticks = '`'.repeat(Math.max(1, ...[...text.matchAll(/`+/gu)].map(match => match[0].length + 1)));
      return `${ticks}${text}${ticks}`;
    }
    let body = children();
    if (['strong', 'b'].includes(tag) || /^(bold|[6-9]00)$/u.test(node.style.fontWeight)) body = `**${body}**`;
    if (['em', 'i'].includes(tag) || node.style.fontStyle === 'italic') body = `*${body}*`;
    if (['del', 's', 'strike'].includes(tag) || node.style.textDecoration.includes('line-through')) body = `~~${body}~~`;
    if (tag === 'mark') body = body.split('\n').map(line => line ? `==${line}==` : '').join('\n');
    if (tag === 'dt') return body + '\n';
    if (tag === 'dd') return ': ' + body.trim().replaceAll('\n', '\n    ') + '\n';
    if (tag === 'dl') return '\n' + body + '\n';
    if (tag === 'sub') body = `~${body}~`;
    if (tag === 'sup') body = `^${body}^`;
    if (tag === 'ins') body = `<ins>${body}</ins>`;
    if (/^h[1-6]$/u.test(tag)) return `${'#'.repeat(Number(tag[1]))} ${body.trim()}\n\n`;
    if (tag === 'blockquote') return body.trim().split('\n').map(line => `> ${line}`).join('\n') + '\n\n';
    if (tag === 'li') {
      const ordered = node.parentElement?.localName === 'ol';
      const index = [...node.parentElement.children].indexOf(node) + Number(node.parentElement.getAttribute('start') || 1);
      return `${ordered ? `${index}.` : '-'} ${body.trim()}\n`;
    }
    if (['ul', 'ol'].includes(tag)) return `\n${body}\n`;
    if (['p', 'div', 'section', 'article', 'header', 'footer'].includes(tag)) return body + '\n\n';
    return body;
  };
  return [...document.body.childNodes].map(walk).join('').replace(/\n{3,}/gu, '\n\n').trim();
}

function table_to_markdown(table, walk) {
  const rows = [...table.rows].filter(row => row.closest('table') === table);
  const grid = [];
  rows.forEach((row, row_index) => {
    grid[row_index] ||= [];
    let column = 0;
    for (const cell of row.cells) {
      while (grid[row_index][column] !== undefined) column++;
      const width = Math.min(100, Number(cell.colSpan) || 1), height = Math.min(100, Number(cell.rowSpan) || 1);
      for (let r = row_index; r < row_index + height; r++) {
        grid[r] ||= [];
        for (let c = column; c < column + width; c++) grid[r][c] = '';
      }
      // Nested tables are text; multiple cell paragraphs use hard breaks.
      const copy = cell.cloneNode(true);
      copy.querySelectorAll('table').forEach(nested => nested.replaceWith(nested.textContent));
      grid[row_index][column] = [...copy.childNodes].map(walk).join('').trim().replace(/\n+/gu, '<br>').replace(/\|/gu, '\\|');
      column += width;
    }
  });
  if (!grid.length) return '';
  const width = Math.max(...grid.map(row => row.length));
  const format = row => '| ' + Array.from({ length: width }, (_, i) => row[i] || '').join(' | ') + ' |';
  return '\n' + [format(grid[0]), format(Array(width).fill('---')), ...grid.slice(1).map(format)].join('\n') + '\n';
}

export function file_markdown(file, data_url) {
  const name = file.name;
  const image = /^image\/(png|jpeg|gif|webp|avif)$/iu.test(file.type);
  return image ? `![${label_escape(name)}](${data_url})` : `[${label_escape(name.replace(/[\r\n]/gu, ' '))}](${data_url} "attachment-uri:${encodeURIComponent(name)}")`;
}

export function read_file(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file);
  });
}
