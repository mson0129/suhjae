// Standalone Markdown rendering: no editor, history, CRDT or WebRTC dependencies.
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const modules = new Map();

export async function create_renderer({ wasm_url = new URL('./sohjae_render.wasm', import.meta.url) } = {}) {
  const key = String(wasm_url);
  if (!modules.has(key)) modules.set(key, fetch(wasm_url).then(async response => {
    if (!response.ok) throw new Error(`Renderer WASM load failed: ${response.status}. Run scripts/build_renderer.sh first.`);
    return WebAssembly.compile(await response.arrayBuffer());
  }).catch(error => { modules.delete(key); throw error; }));
  return new Renderer((await WebAssembly.instantiate(await modules.get(key), {})).exports);
}

export class Renderer {
  constructor(exports) {
    if (exports.renderer_abi_version() !== 1) throw new Error('Unsupported renderer WASM ABI');
    this.exports = exports;
  }
  render(markdown) {
    if (!this.exports) throw new Error('Renderer has been destroyed');
    if (typeof markdown !== 'string') throw new TypeError('Markdown must be a string');
    const bytes = encoder.encode(markdown);
    const pointer = this.exports.renderer_reserve_input(bytes.length);
    if (!pointer) throw new RangeError('Input exceeds 32 MiB');
    new Uint8Array(this.exports.memory.buffer, pointer, bytes.length).set(bytes);
    const status = this.exports.renderer_render();
    const output = new Uint8Array(this.exports.memory.buffer, this.exports.renderer_output_pointer(), this.exports.renderer_output_length()).slice();
    const text = decoder.decode(output);
    if (status) throw new Error(`Renderer error ${status}: ${text}`);
    return text;
  }
  destroy() { this.exports = null; }
}
