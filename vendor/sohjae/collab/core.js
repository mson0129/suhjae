// ABI v2. Each replica owns an independent WASM instance and actor identity.
export { byte_length, byte_to_utf16, utf16_to_byte } from '../core.js';
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
export const COLLABORATION_PROFILE = Object.freeze({ api: 2, abi: 2, protocol: 3, codec: 2, schema: 1 });
export class CollaborationError extends Error {
  constructor(code, message) { super(message); this.name = 'CollaborationError'; Object.defineProperty(this, 'code', {value:code, enumerable:true}); }
}
const modules = new Map();
function frozen(value) {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) frozen(item); Object.freeze(value); }
  return value;
}
function text_bytes(text) {
  if (typeof text !== 'string') throw new TypeError('Text must be a string');
  return encoder.encode(text.replace(/\r\n?/gu, '\n'));
}
function binary(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('Expected Uint8Array');
  return bytes;
}
function optional_id(id) { return id === null ? Uint8Array.of(0) : concat(Uint8Array.of(1), id_bytes(id)); }
function bias_value(bias) { if (!['before','after'].includes(bias)) throw new TypeError('Invalid bias'); return bias === 'after' ? 1 : 0; }

export function new_identity() {
  let bytes;
  do { bytes = crypto.getRandomValues(new Uint8Array(16)); } while (bytes.every(byte => byte === 0));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}
function integer_bytes(hex, length) {
  if (typeof hex !== 'string' || !new RegExp(`^[0-9a-f]{${length * 2}}$`, 'iu').test(hex) || !BigInt(`0x${hex}`)) throw new TypeError('Invalid identity');
  let value = BigInt(`0x${hex}`);
  return Uint8Array.from({ length }, () => { const byte = Number(value & 255n); value >>= 8n; return byte; });
}
function id_bytes(id) {
  if (typeof id !== 'string') throw new TypeError('Invalid operation ID');
  const parts = id.split('-');
  if (parts.length !== 2) throw new TypeError('Invalid operation ID');
  return concat(integer_bytes(parts[0], 8), integer_bytes(parts[1], 16));
}
function u32(value) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new RangeError('Invalid u32');
  const bytes = new Uint8Array(4); new DataView(bytes.buffer).setUint32(0, value, true); return bytes;
}
function concat(...parts) {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0; for (const part of parts) { result.set(part, offset); offset += part.length; } return result;
}
function scope_bytes(scope) {
  if (scope !== null && (!scope || typeof scope !== 'object' || Array.isArray(scope))) throw new TypeError('Invalid scope');
  return scope !== null ? concat(Uint8Array.of(1), id_bytes(scope.table), id_bytes(scope.row), id_bytes(scope.column)) : Uint8Array.of(0);
}
export async function create_replica({ document_id, actor_id = new_identity(), wasm_url = new URL('../sohjae_collaborator.wasm', import.meta.url) }) {
  integer_bytes(document_id, 16); integer_bytes(actor_id, 16);
  if (typeof wasm_url !== 'string' && !(wasm_url instanceof URL)) throw new TypeError('Invalid WASM URL');
  const key = String(wasm_url);
  if (!modules.has(key)) modules.set(key, fetch(wasm_url).then(async response => {
    if (!response.ok) throw new Error(`WASM load failed: ${response.status}`);
    return WebAssembly.compile(await response.arrayBuffer());
  }).catch(error => { modules.delete(key); throw error; }));
  const instance = await WebAssembly.instantiate(await modules.get(key), {});
  return new CollaborativeReplica(instance.exports, document_id, actor_id);
}
export class CollaborativeReplica extends EventTarget {
  constructor(exports, document_id, actor_id) {
    super(); this.exports = exports; this.handle = 0;
    if (typeof exports.collab_abi_version !== 'function' || exports.collab_abi_version() !== COLLABORATION_PROFILE.abi || !(exports.memory instanceof WebAssembly.Memory) || ['collab_dispatch','collab_reserve_input','collab_output_pointer','collab_output_length'].some(name => typeof exports[name] !== 'function')) throw new CollaborationError('UnsupportedABI', 'Unsupported collaboration ABI');
    if (typeof exports.collab_schema_capabilities !== 'function' || exports.collab_schema_capabilities() !== COLLABORATION_PROFILE.schema) throw new CollaborationError('UnsupportedSchema', 'Unsupported collaboration operation schema; update JS and WASM together');
    this.request(0, concat(integer_bytes(document_id, 16), integer_bytes(actor_id, 16)));
  }
  get snapshot() { return this._snapshot; }
  request(op, bytes = new Uint8Array(), start = 0, end = start) {
    if (op !== 0 && !this.handle) throw new CollaborationError('Destroyed', 'Replica is destroyed');
    if (this.notifying && ![4, 16, 17, 18, 22, 23, 24, 33].includes(op)) throw new CollaborationError('ReentrantCall', 'Schedule replica mutations after event delivery');
    binary(bytes); u32(start); u32(end);
    const pointer = this.exports.collab_reserve_input(bytes.length);
    if (!pointer) throw new RangeError('Input exceeds 16 MiB');
    new Uint8Array(this.exports.memory.buffer, pointer, bytes.length).set(bytes);
    const status = this.exports.collab_dispatch(op, this.handle, start, end);
    const output = new Uint8Array(this.exports.memory.buffer, this.exports.collab_output_pointer(), this.exports.collab_output_length()).slice();
    if (status) { const message = decoder.decode(output); throw new CollaborationError(message.match(/^[A-Za-z]+/u)?.[0] || 'InvalidEncoding', `Collaboration core: ${message}`); }
    if (op === 1) { this.handle = 0; return; }
    if ([4, 16, 17, 18, 22, 23, 24, 32, 33].includes(op)) return output;
    const view = new DataView(output.buffer), json_length = view.getUint32(0, true);
    const state = JSON.parse(decoder.decode(output.subarray(4, 4 + json_length)));
    const length = view.getUint32(4 + json_length, true), update = output.slice(8 + json_length);
    if (length !== update.length) throw new Error('Invalid ABI envelope');
    this.handle = state.handle; this._snapshot = frozen(state);
    const origin = op === 3 ? 'remote' : 'local';
    // Install snapshot before emitting: listeners may synchronously read it.
    this.notifying = true;
    try {
      this.dispatchEvent(new CustomEvent('change', { detail: Object.freeze({ snapshot: state, origin }) }));
      if (update.length && new DataView(update.buffer).getUint32(22, true)) this.dispatchEvent(new CustomEvent('update', { detail: update }));
    } finally { this.notifying = false; }
    return state;
  }
  coalesce_history() { this.request(32); return this.snapshot; }
  reorder(table, axis, targets, before = null) {
    if (!Array.isArray(targets) || !targets.length || targets.length > 4096) throw new TypeError('Invalid reorder targets');
    if (!['row','column'].includes(axis)) throw new TypeError('Invalid table axis');
    return this.request(31, concat(id_bytes(table), Uint8Array.of(axis === 'column' ? 1 : 0), u32(targets.length), ...targets.map(id_bytes), optional_id(before)));
  }
  table_action(table, action, row, column, range = [row,row,column,column]) {
    const actions = ['row_before','row_after','column_before','column_after','delete_rows','delete_columns','clear','align_left','align_center','align_right','delete_table'];
    if (!Array.isArray(range) || range.length !== 4) throw new TypeError('Invalid table range');
    const index = actions.indexOf(action); if (index < 0) throw new TypeError('Unknown table action');
    return this.request(26, concat(id_bytes(table), u32(row), u32(column), ...range.map(u32), Uint8Array.of(index)));
  }
  import_markdown(source) { return this.request(20, text_bytes(source)); }
  replace_projected_text(start,end,text) { return this.request(30,text_bytes(text),start,end); }
  replace_markdown(start, end, text) { return this.request(21, text_bytes(text), start, end); }
  projected_anchor(offset, bias = 'after') { return this.request(22, new Uint8Array(), offset, bias_value(bias)); }
  resolve_projected_anchor(anchor) { const bytes = this.request(23, binary(anchor)); return new DataView(bytes.buffer).getUint32(0, true); }
  projected_capture(start, end) { return this.request(24, new Uint8Array(), start, end); }
  replace_text(start, end, text, scope = null) {
    scope_bytes(scope);
    const bytes = text_bytes(text);
    return scope !== null ? this.request(9, concat(id_bytes(scope.table), id_bytes(scope.row), id_bytes(scope.column), bytes), start, end) : this.request(2, bytes, start, end);
  }
  capture_range(start, end, scope = null) { return this.request(18, scope_bytes(scope), start, end); }
  replace_capture(capture, text) { return this.request(19, concat(u32(binary(capture).length), capture, text_bytes(text))); }
  anchor_at(offset, bias = 'after', scope = null) {
    if (!['before', 'after'].includes(bias)) throw new TypeError('Invalid bias');
    return this.request(16, scope_bytes(scope), offset, bias_value(bias));
  }
  resolve_anchor(anchor) { const bytes = this.request(17, binary(anchor)); return new DataView(bytes.buffer).getUint32(0, true); }
  merge(bytes) { return this.request(3, bytes); }
  export_state() { return this.request(4); }
  preview_replace_markdown(start,end,text) {
    try{return decoder.decode(this.request(33,text_bytes(text),start,end));}
    catch(error){if(error.code==='InvalidOperation')throw new CollaborationError('UnsupportedFeature','Atomic source preview requires matching JS and WASM builds');throw error;}
  }
  undo() { return this.request(6); }
  redo() { return this.request(7); }
  create_table(offset, rows = 2, columns = 2) { return this.request(8, concat(u32(rows), u32(columns)), offset); }
  insert_row(table, after = null) { return this.request(10, concat(id_bytes(table), optional_id(after))); }
  insert_column(table, after = null) { return this.request(11, concat(id_bytes(table), optional_id(after))); }
  delete_row(table, row) { return this.request(12, concat(id_bytes(table), id_bytes(row))); }
  delete_column(table, column) { return this.request(13, concat(id_bytes(table), id_bytes(column))); }
  set_alignment(table, column, alignment) {
    const value = ['left', 'center', 'right'].indexOf(alignment);
    if (value < 0) throw new TypeError('Invalid alignment');
    return this.request(14, concat(id_bytes(table), id_bytes(column), Uint8Array.of(value)));
  }
  clear_local_history() { return this.request(28); }
  destroy() { if (!this.handle) return; this.request(1); this.dispatchEvent(new Event('destroy')); }
}
