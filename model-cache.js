// Decoded geometry is shared between panes; only unreferenced LRU entries evict.
// Active views and in-flight transactions are pinned, including during case swaps.
export class ModelCache {
  constructor(limit = 160 * 1048576) {
    this.limit = limit;
    this.entries = new Map();
    this.bytes = 0;
    this.hits = 0;
    this.misses = 0;
  }
  has(key) { return this.entries.has(key); }
  acquire(key) {
    const entry = this.entries.get(key);
    if (!entry) { this.misses++; return null; }
    this.hits++;
    entry.refs++;
    this.entries.delete(key); this.entries.set(key, entry);
    return entry.geometry;
  }
  insert(key, geometry) {
    // A cancelled transaction may finish just as a new one starts.
    const existing = this.entries.get(key);
    if (existing) { geometry.dispose(); return this.acquire(key); }
    const bytes = geometry.getAttribute('position').array.byteLength + geometry.index.array.byteLength;
    this.entries.set(key, {geometry, bytes, refs:1});
    this.bytes += bytes;
    this.trim();
    return geometry;
  }
  release(key) {
    const entry = this.entries.get(key);
    if (!entry || entry.refs < 1) throw new Error('Unbalanced model cache reference.');
    entry.refs--;
    this.trim();
  }
  trim() {
    for (const [key, entry] of this.entries) {
      if (this.bytes <= this.limit) break;
      if (entry.refs) continue;
      this.entries.delete(key); this.bytes -= entry.bytes;
      entry.geometry.dispose();
    }
  }
  clear() {
    for (const entry of this.entries.values()) entry.geometry.dispose();
    this.entries.clear(); this.bytes = 0;
  }
  stats() { return {entries:this.entries.size, bytes:this.bytes, limit:this.limit, hits:this.hits, misses:this.misses}; }
}
