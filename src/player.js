// Chunked, sample-accurate playback of the shared timeline.
//
// The track is fetched as consecutive WAV chunks. Each chunk is scheduled to
// start exactly when the previous one ends, so playback is gapless, and only a
// few chunks are kept in memory, so hour-long tracks are fine on phones.
// Drift against the shared clock is corrected by giving the *next* chunk a tiny
// playback-rate adjustment (≤0.3%, inaudible) instead of jumping.

const LOOKAHEAD_CHUNKS = 2;
const SCHEDULE_AHEAD = 2.0; // seconds before a chunk ends that the next one is scheduled
const MAX_RATE_DELTA = 0.003;
const HARD_RESYNC = 0.25; // seconds of error that triggers a restart instead of a nudge

export class ChunkPlayer {
  constructor({ ctx, output, serverToCtxTime, getNudge, isSynced, onBuffering }) {
    Object.assign(this, { ctx, output, serverToCtxTime, getNudge, isSynced, onBuffering });
    this.track = null;
    this.state = null;
    this.buffers = new Map(); // chunk index -> AudioBuffer
    this.loading = new Map(); // chunk index -> Promise
    this.failedAt = new Map();
    this.segments = []; // scheduled sources: { k, src, ctxStart, ctxEnd, trackStart, rate }
    this.errHist = [];
    this.err = 0;
    this.buffering = false;
    this.timer = setInterval(() => this.tick(), 200);
  }

  destroy() {
    clearInterval(this.timer);
    this.stopAll();
  }

  setState(state) {
    const key = state ? `${state.track?.id}|${state.playing}|${state.startAt}|${state.position}` : '';
    this.state = state;
    if (key === this.key) return; // nothing that affects playback changed
    this.key = key;
    const track = state?.track || null;
    if (track?.id !== this.track?.id) {
      this.stopAll();
      this.buffers.clear();
      this.loading.clear();
      this.failedAt.clear();
      this.track = track;
    }
    this.stopAll();
    this.tick();
  }

  // Re-align from scratch (after a delay change, returning from background, …).
  reset() {
    this.stopAll();
    this.tick();
  }

  stopAll() {
    for (const seg of this.segments) {
      try { seg.src.stop(); } catch {}
      seg.src.disconnect();
    }
    this.segments = [];
    this.errHist = [];
    this.err = 0;
  }

  setBuffering(b) {
    if (b !== this.buffering) {
      this.buffering = b;
      this.onBuffering?.(b);
    }
  }

  // Returns the decoded chunk if ready; otherwise starts loading it and returns null.
  load(k) {
    const t = this.track;
    if (!t || k < 0 || k >= t.chunks) return null;
    if (this.buffers.has(k)) return this.buffers.get(k);
    if (this.loading.has(k) || Date.now() - (this.failedAt.get(k) || 0) < 2000) return null;
    const p = fetch(`/api/chunk/${encodeURIComponent(t.id)}/${k}`)
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.arrayBuffer();
      })
      .then((data) => new Promise((res, rej) => this.ctx.decodeAudioData(data, res, rej)))
      .then((buf) => {
        if (this.track === t) this.buffers.set(k, buf);
      })
      .catch(() => this.failedAt.set(k, Date.now()))
      .finally(() => {
        if (this.track === t) this.loading.delete(k);
        this.tick();
      });
    this.loading.set(k, p);
    return null;
  }

  startSegment(k, buf, when, offset, rate) {
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    src.connect(this.output);
    src.start(when, offset);
    this.segments.push({
      k, src, rate,
      ctxStart: when,
      ctxEnd: when + (buf.duration - offset) / rate,
      trackStart: k * this.track.chunkSeconds + offset,
    });
  }

  tick() {
    const s = this.state;
    const t = this.track;
    const ctx = this.ctx;
    if (!s || !t || !s.playing || ctx.state !== 'running' || !this.isSynced()) {
      if (this.segments.length) this.stopAll();
      this.setBuffering(false);
      return;
    }
    const C = t.chunkSeconds;
    const now = ctx.currentTime;
    // Context time at which the shared `position` is heard; the timeline runs 1:1 from there.
    const base = this.serverToCtxTime(s.startAt - this.getNudge());
    const expectedAt = (time) => s.position + (time - base);

    this.segments = this.segments.filter((seg) => seg.ctxEnd > now - 0.05);

    if (!this.segments.length) {
      // (Re)start: join the shared timeline wherever it is now.
      const t0 = Math.max(now + 0.15, base);
      const p0 = expectedAt(t0);
      if (p0 >= t.duration) return this.setBuffering(false);
      const k = Math.floor(p0 / C);
      for (let i = 0; i <= LOOKAHEAD_CHUNKS; i++) this.load(k + i);
      const buf = this.load(k);
      if (!buf) return this.setBuffering(true);
      this.setBuffering(false);
      this.startSegment(k, buf, t0, p0 - k * C, 1);
      return;
    }

    // Measure drift on the segment that is playing right now.
    const cur = this.segments.find((seg) => seg.ctxStart <= now && now < seg.ctxEnd);
    if (cur) {
      const actual = cur.trackStart + (now - cur.ctxStart) * cur.rate;
      this.errHist.push(expectedAt(now) - actual);
      if (this.errHist.length > 7) this.errHist.shift();
      const sorted = [...this.errHist].sort((a, b) => a - b);
      this.err = sorted[sorted.length >> 1];
      if (this.errHist.length >= 3 && Math.abs(this.err) > HARD_RESYNC) {
        this.stopAll();
        return this.tick();
      }
    }

    // Queue the next chunk back-to-back, with a small rate tweak to absorb drift.
    const last = this.segments[this.segments.length - 1];
    const next = last.k + 1;
    for (let i = 0; i <= LOOKAHEAD_CHUNKS; i++) this.load(last.k + i);
    if (next < t.chunks && last.ctxEnd - now < SCHEDULE_AHEAD) {
      const buf = this.load(next);
      if (buf) {
        const rate = Math.abs(this.err) < 0.004 ? 1 : 1 + Math.max(-MAX_RATE_DELTA, Math.min(MAX_RATE_DELTA, this.err / C));
        this.startSegment(next, buf, last.ctxEnd, 0, rate);
      }
      this.setBuffering(!buf && last.ctxEnd - now < 0.5);
    }

    // Keep memory small: only the playing chunk, one behind, and the lookahead.
    const playing = (cur || last).k;
    for (const k of this.buffers.keys()) {
      if (k < playing - 1 || k > playing + LOOKAHEAD_CHUNKS + 1) this.buffers.delete(k);
    }
  }
}
