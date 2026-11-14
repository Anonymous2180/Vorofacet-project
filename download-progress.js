// Transfer estimates exclude bytes read from our persistent browser cache.
export class DownloadProgress {
  constructor(total, now = performance.now()) {
    this.total = total;
    this.networkBytes = 0;
    this.cachedBytes = 0;
    this.started = now;
    this.lastByteAt = now;
    this.samples = [{time:now, bytes:0}];
  }
  add(bytes, cached = false, now = performance.now()) {
    if (cached) this.cachedBytes += bytes;
    else {
      this.networkBytes += bytes;
      this.lastByteAt = now;
    }
  }
  snapshot(now = performance.now()) {
    this.samples.push({time:now, bytes:this.networkBytes});
    while (this.samples.length > 2 && this.samples[1].time <= now - 5000) this.samples.shift();
    const first = this.samples[0], elapsed = (now - first.time) / 1000;
    const remaining = Math.max(0, this.total - this.networkBytes - this.cachedBytes);
    const stalled = remaining > 0 && now - this.lastByteAt >= 6000;
    const estimating = now - this.started < 750 || !this.networkBytes;
    const speed = !stalled && elapsed > 0 ? Math.max(0, (this.networkBytes - first.bytes) / elapsed) : 0;
    const seconds = !estimating && !stalled && speed > 0 ? remaining / speed : null;
    return {total:this.total, networkBytes:this.networkBytes, cachedBytes:this.cachedBytes,
      received:Math.min(this.total, this.networkBytes+this.cachedBytes), remaining, speed, seconds, stalled, estimating};
  }
}
export function formatSpeed(bytes) {
  return bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + ' MB/s' : Math.round(bytes / 1024) + ' KB/s';
}
export function formatRemaining(seconds) {
  const value = Math.max(1, Math.ceil(seconds));
  if (value < 60) return value + 's';
  if (value < 3600) return Math.floor(value / 60) + 'm ' + value % 60 + 's';
  return Math.floor(value / 3600) + 'h ' + Math.ceil(value % 3600 / 60) + 'm';
}
