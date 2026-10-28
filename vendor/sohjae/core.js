const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
export const byte_length = text => { if (typeof text !== 'string') throw new TypeError('Text must be a string'); return encoder.encode(text).length; };
export function byte_slice(text, start, end) { return decoder.decode(encoder.encode(text).slice(start, end)); }
export function utf16_to_byte(text, offset) {
  if (!Number.isInteger(offset) || offset < 0 || offset > text.length || (offset > 0 && offset < text.length && /[\uD800-\uDBFF]/u.test(text[offset - 1]) && /[\uDC00-\uDFFF]/u.test(text[offset]))) throw new RangeError('Invalid UTF-16 boundary');
  return byte_length(text.slice(0, offset));
}
export function byte_to_utf16(text, offset) { if (!Number.isInteger(offset) || offset < 0 || offset > byte_length(text)) throw new RangeError('Invalid UTF-8 boundary'); return byte_slice(text, 0, offset).length; }

const modules = new Map();
export async function load_core(wasm_url = new URL('./sohjae_editor.wasm', import.meta.url)) {
  const key = String(wasm_url);
  if (!modules.has(key)) modules.set(key, fetch(wasm_url).then(async response => {
    if (!response.ok) throw new Error(`WASM load failed: ${response.status}. Run scripts/build.sh first.`);
    return WebAssembly.compile(await response.arrayBuffer());
  }).catch(error => { modules.delete(key); throw error; }));
  const instance = await WebAssembly.instantiate(await modules.get(key), {});
  return new Core(instance.exports);
}

export class Core {
  constructor(exports) {
    this.exports = exports;
    this.handle = 0;
    this.revision = 0n;
    if (exports.abi_version() !== 1) throw new Error('Unsupported WASM ABI');
  }
  request(op, text = '', start = 0, end = start) {
    if (typeof text !== 'string') throw new TypeError('Text must be a string');
    for (const value of [start, end]) if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new RangeError('Invalid UTF-8 offset');
    text = text.replace(/\r\n?/gu, '\n');
    const bytes = encoder.encode(text);
    const pointer = this.exports.reserve_input(bytes.length);
    if (!pointer) throw new RangeError('Input exceeds 32 MiB');
    new Uint8Array(this.exports.memory.buffer, pointer, bytes.length).set(bytes);
    const status = this.exports.dispatch(op, this.handle, this.revision, start, end);
    // Copy before any later call can reallocate the output or grow memory.
    const output = new Uint8Array(this.exports.memory.buffer, this.exports.output_pointer(), this.exports.output_length()).slice();
    const view = new DataView(output.buffer);
    let offset = 0;
    const u32 = () => { const value = view.getUint32(offset, true); offset += 4; return value; };
    const string = () => { const length = u32(); const text = decoder.decode(output.subarray(offset, offset + length)); offset += length; return text; };
    if (status) throw new Error(`Core error ${status}: ${string()}`);
    if (op === 1) { this.handle = 0; return; }
    if (op === 8 || op === 13) return string();
    this.handle = u32();
    this.revision = view.getBigUint64(offset, true); offset += 8;
    const anchor = u32(), focus = u32(), flags = u32();
    this.snapshot = { ...this.snapshot, handle: this.handle, revision: this.revision, anchor, focus, can_undo: !!(flags & 1), can_redo: !!(flags & 2), dirty: !!(flags & 4), ...(offset < output.length ? { source: string(), html: string(), layout: string() } : {}) };
    return this.snapshot;
  }
}
