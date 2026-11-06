// Acoustic auto-sync: every speaker plays the same chirp in its own time slot,
// the host records them with its microphone and measures when each one was
// actually heard. Because every device is measured by the same mic, unknown
// constant delays (mic input latency, clock mapping) cancel out and only the
// relative error between speakers remains, which is exactly what we correct.

export const CHIRP_SECONDS = 0.08;
export const SEARCH_BEFORE = 0.15; // seconds before the expected slot time
export const SEARCH_AFTER = 1.35;  // seconds after (covers slow Bluetooth speakers; capped by the slot gap)

// 2 → 8 kHz linear sweep with a Hann window: sharp correlation peak, survives phone speakers.
export function makeChirp(sampleRate) {
  const n = Math.round(CHIRP_SECONDS * sampleRate);
  const out = new Float32Array(n);
  const f0 = 2000;
  const f1 = 8000;
  const T = n / sampleRate;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const phase = 2 * Math.PI * (f0 * t + ((f1 - f0) * t * t) / (2 * T));
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    out[i] = w * Math.sin(phase);
  }
  return out;
}

export function playChirp(ctx, when) {
  const data = makeChirp(ctx.sampleRate);
  const buf = ctx.createBuffer(1, data.length, ctx.sampleRate);
  buf.copyToChannel(data, 0);
  const src = ctx.createBufferSource();
  const g = ctx.createGain();
  g.gain.value = 0.9;
  src.buffer = buf;
  src.connect(g).connect(ctx.destination);
  src.start(Math.max(when, ctx.currentTime + 0.01));
}

// ---- microphone recorder (AudioWorklet, frame-accurate) ----

const WORKLET = `
class SSRecorder extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(4096); this.n = 0; this.start = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      if (this.n === 0) this.start = currentFrame;
      this.buf.set(ch, this.n);
      this.n += ch.length;
      if (this.n + 128 > this.buf.length) {
        this.port.postMessage({ frame: this.start, data: this.buf.slice(0, this.n) });
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor('ss-recorder', SSRecorder);
`;

const loadedContexts = new WeakSet();

export async function startRecorder(ctx) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  if (!loadedContexts.has(ctx)) {
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    loadedContexts.add(ctx);
  }
  const chunks = [];
  const mic = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'ss-recorder');
  const sink = ctx.createGain();
  sink.gain.value = 0; // keep the graph pulled without playing the mic back
  node.port.onmessage = (e) => chunks.push(e.data);
  mic.connect(node).connect(sink).connect(ctx.destination);

  return {
    stop() {
      mic.disconnect();
      node.disconnect();
      sink.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      if (!chunks.length) return null;
      const first = chunks[0].frame;
      const last = chunks[chunks.length - 1];
      const samples = new Float32Array(last.frame + last.data.length - first);
      for (const c of chunks) samples.set(c.data, c.frame - first);
      return { firstFrame: first, samples };
    },
  };
}

// ---- matched filter ----

function fft(re, im, inverse) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

// |cross-correlation| of signal with template for every lag in [0, signal.length - template.length].
function xcorrAbs(signal, template) {
  let n = 1;
  while (n < signal.length + template.length) n <<= 1;
  const sr = new Float64Array(n), si = new Float64Array(n);
  const tr = new Float64Array(n), ti = new Float64Array(n);
  sr.set(signal);
  tr.set(template);
  fft(sr, si, false);
  fft(tr, ti, false);
  for (let i = 0; i < n; i++) {
    // S * conj(T)
    const r = sr[i] * tr[i] + si[i] * ti[i];
    const im = si[i] * tr[i] - sr[i] * ti[i];
    sr[i] = r;
    si[i] = im;
  }
  fft(sr, si, true);
  const lags = signal.length - template.length + 1;
  const out = new Float32Array(lags);
  for (let i = 0; i < lags; i++) out[i] = Math.abs(sr[i]);
  return out;
}

// For each slot, find when its chirp arrived relative to when it should have.
// expectedFrames[i] = recorder frame at which slot i's chirp is due.
// Returns [{ ok, residualMs }] in slot order.
// gapSeconds = spacing between slots; the search window must stay inside one slot.
export function detectChirps(recording, expectedFrames, sampleRate, gapSeconds = 1) {
  const { firstFrame, samples } = recording;
  const template = makeChirp(sampleRate);
  const before = Math.round(SEARCH_BEFORE * sampleRate);
  const after = Math.round(Math.min(SEARCH_AFTER, gapSeconds - SEARCH_BEFORE) * sampleRate);
  const refine = Math.round(0.004 * sampleRate);

  return expectedFrames.map((expected) => {
    const e = expected - firstFrame;
    const start = e - before;
    const end = e + after + template.length;
    if (start < 0 || end > samples.length) return { ok: false };
    const corr = xcorrAbs(samples.subarray(start, end), template);

    let peak = 0;
    for (let i = 0; i < corr.length; i++) if (corr[i] > peak) peak = corr[i];
    const sorted = Float32Array.from(corr).sort();
    const noise = sorted[sorted.length >> 1] || 1e-9;
    if (peak < 8 * noise) return { ok: false };

    // Earliest strong arrival = direct sound (later peaks can be room echoes).
    let idx = corr.findIndex((v) => v >= 0.5 * peak);
    let best = idx;
    for (let i = idx; i < Math.min(corr.length, idx + refine); i++) if (corr[i] > corr[best]) best = i;
    return { ok: true, residualMs: ((start + best - e) / sampleRate) * 1000, snr: peak / noise };
  });
}
