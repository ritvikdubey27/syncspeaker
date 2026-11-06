// NTP-style clock sync over the WebSocket.
//
// Rather than a fresh guess every few seconds (which wobbles with Wi-Fi jitter),
// we keep two minutes of ping samples, use only the fastest round trips (the
// least delayed by Wi-Fi power saving and queuing), and fit a line through them
// so we also track how fast this device's clock drifts against the server's.

const WINDOW_MS = 120000;
const MAX_SAMPLES = 400;
const MAX_SKEW = 2e-4; // 200 ppm: anything beyond is noise, not a real clock

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
};

export function createClock(sendPing) {
  let samples = []; // { t: local midpoint, rtt, offset }
  let est = { a: 0, b: 0, tRef: 0 };
  let rtt = 0;
  let jitter = 0;
  let synced = false;
  const pending = new Set();

  function onPong({ t0, ts }) {
    if (!pending.delete(t0)) return;
    const t1 = performance.now();
    samples.push({ t: (t0 + t1) / 2, rtt: t1 - t0, offset: ts - (t0 + t1) / 2 });
    if (samples.length > MAX_SAMPLES) samples.shift();
  }

  function recompute() {
    const now = performance.now();
    samples = samples.filter((s) => now - s.t < WINDOW_MS);
    if (samples.length < 3) return;
    const best = [...samples]
      .sort((a, b) => a.rtt - b.rtt)
      .slice(0, Math.max(3, Math.ceil(samples.length * 0.25)));
    rtt = best[0].rtt;

    let a = median(best.map((s) => s.offset));
    let b = 0;
    const tRef = now;
    const ts = best.map((s) => s.t);
    if (best.length >= 6 && Math.max(...ts) - Math.min(...ts) > 20000) {
      // Least-squares line: offset = a + b * (t - tRef)
      const xs = best.map((s) => s.t - tRef);
      const ys = best.map((s) => s.offset);
      const mx = xs.reduce((n, x) => n + x, 0) / xs.length;
      const my = ys.reduce((n, y) => n + y, 0) / ys.length;
      let sxx = 0;
      let sxy = 0;
      for (let i = 0; i < xs.length; i++) {
        sxx += (xs[i] - mx) ** 2;
        sxy += (xs[i] - mx) * (ys[i] - my);
      }
      b = sxx > 0 ? Math.max(-MAX_SKEW, Math.min(MAX_SKEW, sxy / sxx)) : 0;
      a = my - b * mx;
    }
    jitter = median(best.map((s) => Math.abs(s.offset - (a + b * (s.t - tRef)))));
    est = { a, b, tRef };
    synced = true;
  }

  // Send a burst of pings and fold the replies into the estimate.
  async function sync(count = 6, gap = 50) {
    for (let i = 0; i < count; i++) {
      const t0 = performance.now();
      pending.add(t0);
      sendPing(t0);
      await sleep(gap);
    }
    await sleep(400);
    pending.clear();
    recompute();
  }

  const offsetAt = (t) => est.a + est.b * (t - est.tRef);

  return {
    onPong,
    sync,
    serverNow: () => {
      const t = performance.now();
      return t + offsetAt(t);
    },
    // offset: current estimate; rtt: best round trip; jitter: typical error of the estimate (ms)
    stats: () => ({ offset: offsetAt(performance.now()), rtt, jitter, skewPpm: est.b * 1e6, synced }),
  };
}
