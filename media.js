// Media pipeline: YouTube lookups/downloads (yt-dlp), decoding to raw PCM (ffmpeg),
// and an on-disk library of prepared tracks so replays never re-download.
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

export const SAMPLE_RATE = 48000;
export const CHANNELS = 2;
export const BYTES_PER_FRAME = CHANNELS * 2;
export const CHUNK_SECONDS = 20;
export const CHUNK_BYTES = CHUNK_SECONDS * SAMPLE_RATE * BYTES_PER_FRAME;
export const MAX_SECONDS = 4 * 3600;

const ytdlpBin = (root) => {
  if (process.env.YTDLP) return process.env.YTDLP;
  const local = path.join(root, 'bin', 'yt-dlp');
  return fs.existsSync(local) ? local : 'yt-dlp';
};
// YouTube needs a JS runtime to unlock formats; use the Node running this server.
const YT_COMMON = ['--no-warnings', '--js-runtimes', `node:${process.execPath}`];

export function fmtTime(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(Math.floor(s % 60)).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

// Kill a detached process and everything it spawned (yt-dlp runs ffmpeg children).
export function killTree(proc) {
  if (!proc) return;
  try { process.kill(-proc.pid, 'SIGKILL'); } catch {}
}

function lines(stream, onLine) {
  let buf = '';
  stream.on('data', (d) => {
    buf += d;
    const parts = buf.split('\n');
    buf = parts.pop();
    parts.forEach(onLine);
  });
}

// ---- library ----

export function createLibrary(dir, maxBytes, getProtectedIds) {
  fs.mkdirSync(dir, { recursive: true });
  const indexFile = path.join(dir, 'library.json');
  const pcmPath = (id) => path.join(dir, `${id}.pcm`);
  const entries = new Map();
  try {
    for (const e of JSON.parse(fs.readFileSync(indexFile, 'utf8'))) {
      if (fs.existsSync(pcmPath(e.id))) entries.set(e.id, e);
    }
  } catch {}
  // Older versions kept a single current.json; adopt that track.
  const legacy = path.join(dir, 'current.json');
  try {
    const t = JSON.parse(fs.readFileSync(legacy, 'utf8'));
    if (fs.existsSync(pcmPath(t.id)) && !entries.has(t.id)) {
      entries.set(t.id, { ...t, source: 'upload', bytes: fs.statSync(pcmPath(t.id)).size, lastUsed: Date.now() });
    }
  } catch {}
  fs.rmSync(legacy, { force: true });
  for (const f of fs.readdirSync(dir)) {
    if (f === 'library.json') continue;
    if (!f.endsWith('.pcm') || !entries.has(f.slice(0, -4))) fs.rmSync(path.join(dir, f), { force: true });
  }

  const save = () => fs.writeFileSync(indexFile, JSON.stringify([...entries.values()]));
  save();

  function evict() {
    const keep = getProtectedIds();
    let total = [...entries.values()].reduce((n, e) => n + (e.bytes || 0), 0);
    const oldestFirst = [...entries.values()].sort((a, b) => a.lastUsed - b.lastUsed);
    for (const e of oldestFirst) {
      if (total <= maxBytes) break;
      if (keep.has(e.id)) continue;
      entries.delete(e.id);
      fs.rm(pcmPath(e.id), () => {});
      total -= e.bytes || 0;
    }
  }

  return {
    pcmPath,
    get: (id) => entries.get(id),
    has: (id) => entries.has(id),
    list: () => [...entries.values()].sort((a, b) => b.lastUsed - a.lastUsed),
    add(entry) {
      entries.set(entry.id, { ...entry, lastUsed: Date.now() });
      evict();
      save();
    },
    touch(id) {
      const e = entries.get(id);
      if (e) {
        e.lastUsed = Date.now();
        save();
      }
    },
  };
}

// ---- ffmpeg: any audio/video file -> raw 48 kHz stereo s16le PCM ----

export function preparePcm(srcFile, outFile, { onProgress, onProc } = {}) {
  return new Promise((resolve, reject) => {
    const tmp = `${outFile}.tmp`;
    const proc = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-i', srcFile, '-vn', '-ac', String(CHANNELS), '-ar', String(SAMPLE_RATE),
      '-t', String(MAX_SECONDS), '-f', 's16le', '-progress', 'pipe:1', tmp,
    ], { detached: true });
    onProc?.(proc);
    let err = '';
    let lastReport = 0;
    lines(proc.stdout, (line) => {
      const m = line.match(/^out_time_us=(\d+)/);
      if (m && Date.now() - lastReport > 1000) {
        lastReport = Date.now();
        onProgress?.(Number(m[1]) / 1e6);
      }
    });
    proc.stderr.on('data', (d) => { err = String(d).trim().split('\n').pop(); });
    proc.on('error', () => reject(new Error('ffmpeg is not installed on the desktop')));
    proc.on('close', (code) => {
      fs.rm(srcFile, () => {});
      const bytes = fs.existsSync(tmp) ? fs.statSync(tmp).size : 0;
      const frames = Math.floor(bytes / BYTES_PER_FRAME);
      if (code !== 0 || !frames) {
        fs.rm(tmp, () => {});
        return reject(new Error(`Could not read that audio${err ? `: ${err}` : ''}`));
      }
      fs.renameSync(tmp, outFile);
      resolve({
        duration: frames / SAMPLE_RATE,
        chunks: Math.ceil(frames / (CHUNK_SECONDS * SAMPLE_RATE)),
        bytes,
      });
    });
  });
}

// ---- yt-dlp ----

export function createYouTube(root, tmpDir) {
  const bin = ytdlpBin(root);

  // Metadata only (search results, playlist/mix contents): fast, no download.
  function json(args, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      const proc = spawn(bin, [...YT_COMMON, '-J', '--flat-playlist', ...args], { detached: true });
      let out = '';
      let err = '';
      const timer = setTimeout(() => killTree(proc), timeoutMs);
      proc.stdout.on('data', (d) => { out += d; });
      proc.stderr.on('data', (d) => { err = String(d).trim().split('\n').pop(); });
      proc.on('error', (e) => {
        clearTimeout(timer);
        reject(new Error(e.code === 'ENOENT' ? 'yt-dlp is not installed on the desktop' : e.message));
      });
      proc.on('close', () => {
        clearTimeout(timer);
        try { resolve(JSON.parse(out)); } catch { reject(new Error(err || 'YouTube lookup failed')); }
      });
    });
  }

  const toItems = (entries = []) =>
    entries
      .filter((e) => e && /^[\w-]{11}$/.test(e.id || ''))
      .map((e) => ({
        videoId: e.id,
        title: e.title || 'YouTube video',
        duration: e.duration ?? null,
        channel: e.channel || e.uploader || '',
        live: e.live_status === 'is_live' || e.live_status === 'is_upcoming' || e.duration == null,
      }));

  return {
    search: async (q) => toItems((await json([`ytsearch12:${q}`])).entries),
    playlist: async (url) => toItems((await json(['--playlist-end', '200', url])).entries),
    mix: async (videoId) =>
      toItems((await json(['--playlist-end', '15', `https://www.youtube.com/watch?v=${videoId}&list=RD${videoId}`])).entries),

    // Download one video's best audio. Resolves { file, title }.
    download(videoId, { onProgress, onTitle, onProc } = {}) {
      return new Promise((resolve, reject) => {
        const base = `${videoId}-${Date.now()}`;
        const proc = spawn(bin, [
          ...YT_COMMON,
          '--no-playlist', '--newline', '--no-simulate', '--progress',
          // Live streams never finish downloading; refuse them (and absurdly long videos).
          '--match-filter', `!is_live & live_status!=is_upcoming & duration<=${MAX_SECONDS}`,
          '-f', 'bestaudio/best',
          '--print', 'before_dl:TITLE:%(title)s',
          '--print', 'after_move:FILE:%(filepath)s',
          '-o', path.join(tmpDir, `${base}.%(ext)s`),
          `https://www.youtube.com/watch?v=${videoId}`,
        ], { detached: true });
        onProc?.(proc);
        let title = null;
        let file = null;
        let lastErr = '';
        lines(proc.stdout, (line) => {
          const pct = line.match(/\[download\]\s+([\d.]+)%/);
          if (pct) onProgress?.(Math.round(+pct[1]));
          else if (line.startsWith('TITLE:')) {
            title = line.slice(6).trim() || null;
            if (title) onTitle?.(title);
          } else if (line.startsWith('FILE:')) file = line.slice(5).trim();
        });
        proc.stderr.on('data', (d) => { lastErr = String(d).trim().split('\n').pop(); });
        proc.on('error', (e) =>
          reject(new Error(e.code === 'ENOENT' ? 'yt-dlp is not installed on the desktop' : e.message)));
        proc.on('close', (code) => {
          const cleanup = () => {
            for (const f of fs.readdirSync(tmpDir)) if (f.startsWith(base)) fs.rm(path.join(tmpDir, f), () => {});
          };
          // A clean exit without a file means the match filter skipped it.
          if (code === 0 && !file) {
            cleanup();
            return reject(new Error('Live stream or longer than 4 hours'));
          }
          if (code !== 0 || !file || !fs.existsSync(file)) {
            cleanup();
            return reject(new Error(lastErr.replace(/^ERROR:\s*/, '') || 'Download failed'));
          }
          resolve({ file, title });
        });
      });
    },
  };
}

export function extractVideoId(url) {
  let id = null;
  if (url.hostname === 'youtu.be') id = url.pathname.slice(1).split('/')[0];
  else if (url.searchParams.get('v')) id = url.searchParams.get('v');
  else {
    const m = url.pathname.match(/^\/(?:shorts|live|embed)\/([\w-]{11})/);
    if (m) id = m[1];
  }
  return id && /^[\w-]{11}$/.test(id) ? id : null;
}
