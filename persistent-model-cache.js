// Store immutable compressed chunks, not simplified meshes or decoded GPU data.
// No service worker: page updates stay independent of model caching. Storage
// failure must never prevent a download. Admission stops at 256 MiB; we do not
// remove existing browser data. The browser/user may clear site storage.
const DATABASE = 'vorofacet-model-chunks-v1';
const LIMIT = 256 * 1048576;
const MAX_CHUNK = 7000000;
export async function verifyChunk(bytes, url) {
  const match = new URL(url).pathname.match(/\/blobs\/([a-f0-9]{64})\.ply\.gz$/);
  if (!match || bytes.byteLength > MAX_CHUNK) return false;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(v => v.toString(16).padStart(2,'0')).join('') === match[1];
}
export class PersistentModelCache {
  constructor(onChange = () => {}) {
    this.onChange = onChange;
    this.opening = null;
    this.state = 'unopened';
    this.hits = 0; this.writes = 0; this.pending = 0; this.invalid = 0;
  }
  update(state) { this.state = state; this.onChange(this.stats()); }
  stats() { return {state:this.state, hits:this.hits, writes:this.writes, pending:this.pending, invalid:this.invalid, limit:LIMIT}; }
  open() {
    if (this.opening) return this.opening;
    this.opening = new Promise(resolve => {
      let request, settled = false;
      const finish = db => {
        if (settled) { db?.close(); return; }
        settled = true; clearTimeout(timer);
        this.update(db ? 'available' : 'unavailable'); resolve(db);
      };
      const timer = setTimeout(() => finish(null), 2000);
      try {
        request = indexedDB.open(DATABASE, 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks', {keyPath:'url'});
          if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', {keyPath:'name'});
        };
        request.onsuccess = () => {
          const db = request.result;
          db.onversionchange = () => { db.close(); this.update('unavailable'); };
          finish(db);
        };
        request.onerror = () => finish(null);
        request.onblocked = () => finish(null);
      } catch (_) { finish(null); }
    });
    return this.opening;
  }
  async read(url) {
    const db = await this.open();
    if (!db || this.state === 'unavailable') return null;
    return new Promise(resolve => {
      let transaction, result = null, done = false;
      const finish = value => { if (!done) { done = true; clearTimeout(timer); resolve(value); } };
      const timer = setTimeout(() => { try { transaction?.abort(); } catch (_) {} this.update('unavailable'); finish(null); }, 2000);
      try {
        transaction = db.transaction('chunks', 'readonly');
        const request = transaction.objectStore('chunks').get(url);
        request.onsuccess = () => { result = request.result; };
        transaction.oncomplete = () => finish(result);
        transaction.onabort = transaction.onerror = () => { this.update('unavailable'); finish(null); };
      } catch (_) { this.update('unavailable'); finish(null); }
    });
  }
  async get(url, signal) {
    const entry = await this.read(url);
    if (signal.aborted || !entry) return null;
    try {
      if (!(entry.blob instanceof Blob) || entry.size !== entry.blob.size || entry.size > MAX_CHUNK) { this.invalid++; return null; }
      const bytes = new Uint8Array(await entry.blob.arrayBuffer());
      if (signal.aborted) return null;
      if (!(await verifyChunk(bytes, url))) { this.invalid++; return null; }
      this.hits++; this.onChange(this.stats());
      return bytes;
    } catch (_) { this.update('unavailable'); return null; }
  }
  save(url, bytes) {
    if (this.state === 'unavailable' || this.state === 'quota') return;
    // Snapshot before the decoder transfers/detaches the source ArrayBuffer.
    const blob = new Blob([bytes]);
    this.pending++; this.onChange(this.stats());
    this.write(url, blob).catch(() => this.update('unavailable')).finally(() => {
      this.pending--; this.onChange(this.stats());
    });
  }
  async write(url, blob) {
    const db = await this.open();
    if (!db || this.state === 'unavailable' || this.state === 'quota' || blob.size > MAX_CHUNK) return;
    await new Promise(resolve => {
      let transaction, done = false, admitted = false, writeError;
      const finish = () => { if (!done) { done = true; clearTimeout(timer); resolve(); } };
      const timer = setTimeout(() => { try { transaction?.abort(); } catch (_) {} this.update('unavailable'); finish(); }, 5000);
      try {
        // One atomic transaction serializes admission across tabs as well.
        transaction = db.transaction(['chunks','meta'], 'readwrite');
        const chunks = transaction.objectStore('chunks'), meta = transaction.objectStore('meta');
        const previous = chunks.get(url), usage = meta.get('bytes');
        let oldReady = false, sizeReady = false;
        const store = () => {
          if (!oldReady || !sizeReady) return;
          const size = Math.max(0, Number(usage.result?.value) || 0);
          const oldSize = Math.max(0, Number(previous.result?.size) || 0);
          const next = Math.max(0, size - oldSize) + blob.size;
          if (next > LIMIT) { this.update('full'); return; }
          try {
            chunks.put({url, blob, size:blob.size}); meta.put({name:'bytes',value:next}); admitted = true;
          } catch (error) {
            writeError = error;
            transaction.abort();
          }
        };
        previous.onsuccess = () => { oldReady = true; store(); };
        usage.onsuccess = () => { sizeReady = true; store(); };
        transaction.oncomplete = () => { if (admitted) { this.writes++; if (this.state !== 'quota' && this.state !== 'unavailable') this.update('available'); } finish(); };
        transaction.onabort = transaction.onerror = () => {
          this.update((writeError || transaction.error)?.name === 'QuotaExceededError' ? 'quota' : 'unavailable'); finish();
        };
      } catch (error) { this.update(error.name === 'QuotaExceededError' ? 'quota' : 'unavailable'); finish(); }
    });
  }
}
