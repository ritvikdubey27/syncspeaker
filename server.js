// SyncSpeaker server: serves the React app, prepares audio, runs the play queue,
// and keeps every connected device on a shared clock so they play together.
import express from 'express';
import multer from 'multer';
import QRCode from 'qrcode';
import { WebSocketServer } from 'ws';
import http from 'http';
import https from 'https';
import os from 'os';
import fs from 'fs';
import { spawnSync } from 'child_process';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  SAMPLE_RATE, CHANNELS, BYTES_PER_FRAME, CHUNK_SECONDS, CHUNK_BYTES,
  fmtTime, killTree, createLibrary, preparePcm, createYouTube, extractVideoId,
} from './media.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8080;
const HTTPS_PORT = Number(process.env.HTTPS_PORT) || 8443;
const START_DELAY_MS = 1500; // lead time so every device can schedule the start
const LIBRARY_BYTES = (Number(process.env.LIBRARY_GB) || 6) * 1024 ** 3;
const AUTOPLAY_ADD = 3; // songs added from the YouTube mix when the queue runs dry
const AUTOPLAY_MAX_SECONDS = 15 * 60; // skip hour-long mixes when autoplaying
const RESYNC_EVERY_MS = 4 * 60 * 1000; // at most one between-song re-sync per this interval

// Monotonic server clock in ms (immune to wall-clock adjustments).
const now = () => Number(process.hrtime.bigint()) / 1e6;

const state = {
  track: null,      // { id, name, duration, chunkSeconds, chunks, videoId }
  playing: false,
  startAt: 0,       // server time at which `position` is heard
  position: 0,      // seconds into the track at startAt (or paused position)
  ended: true,      // nothing playing: the next ready queue item starts automatically
  test: false,      // sync-test beeps on every device
  queue: [],        // [{ qid, title, videoId, libraryId, duration, status, progress, error, auto }]
  autoplay: true,   // keep going with similar songs when the queue is empty
  resyncBetween: true, // re-measure every speaker acoustically in the gap between songs
};

const currentPosition = () =>
  state.playing ? Math.max(0, state.position + (now() - state.startAt) / 1000) : state.position;

// ---- network identity, host key, HTTPS ----

function lanIPs() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}
const lanAddresses = () => lanIPs().map((ip) => `http://${ip}:${PORT}`);

// Host key: whoever opens /?host=<key> (or uses the desktop itself) is the master.
const KEY_FILE = path.join(__dirname, '.hostkey');
const HOST_KEY = (() => {
  if (fs.existsSync(KEY_FILE)) return fs.readFileSync(KEY_FILE, 'utf8').trim();
  const key = crypto.randomBytes(9).toString('base64url');
  fs.writeFileSync(KEY_FILE, key, { mode: 0o600 });
  return key;
})();
const isLoopback = (addr) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(addr);
const isHostReq = (req) => isLoopback(req.socket.remoteAddress) || req.get('x-host-key') === HOST_KEY;

// Self-signed certificate for the HTTPS host port: browsers only allow microphone
// access (used by auto-sync) on secure pages. Regenerated when the LAN IPs change.
function loadOrCreateCert() {
  const dir = path.join(__dirname, 'certs');
  const keyFile = path.join(dir, 'key.pem');
  const certFile = path.join(dir, 'cert.pem');
  const sanFile = path.join(dir, 'san.txt');
  const san = ['DNS:localhost', 'IP:127.0.0.1', ...lanIPs().map((ip) => `IP:${ip}`)].join(',');
  const current = fs.existsSync(sanFile) && fs.readFileSync(sanFile, 'utf8');
  if (current !== san || !fs.existsSync(keyFile) || !fs.existsSync(certFile)) {
    fs.mkdirSync(dir, { recursive: true });
    const r = spawnSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '825',
      '-keyout', keyFile, '-out', certFile,
      '-subj', '/CN=SyncSpeaker', '-addext', `subjectAltName=${san}`,
    ]);
    if (r.status !== 0) {
      console.warn('Could not create HTTPS certificate (is openssl installed?); auto-sync will be unavailable.');
      return null;
    }
    fs.writeFileSync(sanFile, san);
  }
  return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
}

function hostUrl() {
  const [ip] = lanIPs();
  if (!ip) return null;
  return fs.existsSync(path.join(__dirname, 'certs', 'cert.pem'))
    ? `https://${ip}:${HTTPS_PORT}/?host=${HOST_KEY}`
    : `http://${ip}:${PORT}/?host=${HOST_KEY}`;
}

// ---- library & YouTube ----

const TRACKS_DIR = path.join(__dirname, 'tracks');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
fs.rmSync(UPLOADS_DIR, { recursive: true, force: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Songs that must not be evicted: the one playing and everything queued.
const protectedIds = () =>
  new Set([state.track?.id, ...state.queue.map((q) => q.libraryId)].filter(Boolean));
const library = createLibrary(TRACKS_DIR, LIBRARY_BYTES, protectedIds);
const yt = createYouTube(__dirname, UPLOADS_DIR);

const trackFromEntry = (e) => ({
  id: e.id,
  name: e.name,
  duration: e.duration,
  chunkSeconds: CHUNK_SECONDS,
  chunks: e.chunks,
  videoId: e.videoId || null,
});

// Show the most recent song again after a restart (paused).
const [lastPlayed] = library.list();
if (lastPlayed) state.track = trackFromEntry(lastPlayed);

let lastStatus = '';
function setStatus(text) {
  lastStatus = text;
  broadcast({ type: 'status', text });
}

// ---- queue ----

let nextQid = 1;
let fetching = null; // { item, proc, cancelled }: one download at a time
let autoplayBusy = false;
const recentVideos = []; // avoid autoplay repeating songs

function addItems(items, mode = 'end') {
  const queued = new Set(state.queue.map((q) => q.videoId).filter(Boolean));
  const fresh = items
    .filter((it) => !it.videoId || !queued.has(it.videoId))
    .map((it) => ({
      qid: nextQid++,
      title: it.title || 'Loading…',
      videoId: it.videoId || null,
      libraryId: it.libraryId || null,
      duration: it.duration ?? null,
      status: 'waiting',
      progress: '',
      error: '',
      auto: !!it.auto,
    }));
  if (!fresh.length) return 0;
  if (mode === 'end') state.queue.push(...fresh);
  else state.queue.unshift(...fresh);
  if (mode === 'now') skip();
  pump();
  maybeAdvance();
  broadcastState();
  return fresh.length;
}

// Mark items whose audio is already in the library as ready.
function resolveFromLibrary(item) {
  const id = item.libraryId || (item.videoId && `yt-${item.videoId}`);
  if (id && library.has(id)) {
    const e = library.get(id);
    Object.assign(item, { libraryId: id, status: 'ready', progress: '', duration: e.duration });
    if (!item.title || item.title === 'Loading…') item.title = e.name;
  }
}

// Download + prepare queued songs one at a time, in order, ahead of when they play.
function pump() {
  for (const it of state.queue) if (it.status === 'waiting') resolveFromLibrary(it);
  if (fetching) return;
  const item = state.queue.find((q) => q.status === 'waiting' && q.videoId);
  if (!item) return;
  const job = { item, proc: null, cancelled: false };
  fetching = job;
  item.status = 'fetching';
  item.progress = 'Starting download…';
  broadcastState();

  (async () => {
    const dl = await yt.download(item.videoId, {
      onProc: (p) => { job.proc = p; },
      onTitle: (t) => { item.title = t; broadcastSoon(); },
      onProgress: (pct) => { item.progress = `Downloading ${pct}%`; broadcastSoon(); },
    });
    if (job.cancelled) return;
    item.progress = 'Preparing…';
    broadcastState();
    const id = `yt-${item.videoId}`;
    const info = await preparePcm(dl.file, library.pcmPath(id), {
      onProc: (p) => { job.proc = p; },
      onProgress: (s) => { item.progress = `Preparing… ${fmtTime(s)}`; broadcastSoon(); },
    });
    library.add({ id, name: dl.title || item.title, videoId: item.videoId, source: 'yt', ...info });
    Object.assign(item, { status: 'ready', libraryId: id, progress: '', duration: info.duration });
  })()
    .catch((e) => {
      if (!job.cancelled) Object.assign(item, { status: 'error', error: e.message, progress: '' });
    })
    .finally(() => {
      fetching = null;
      maybeAdvance();
      pump();
      broadcastState();
    });
}

function removeItem(qid) {
  const i = state.queue.findIndex((q) => q.qid === qid);
  if (i < 0) return;
  const [item] = state.queue.splice(i, 1);
  if (fetching?.item === item) {
    fetching.cancelled = true;
    killTree(fetching.proc);
  }
}

function loadAndPlay(entry) {
  state.track = trackFromEntry(entry);
  state.ended = false;
  state.test = false;
  library.touch(entry.id);
  if (entry.videoId) {
    recentVideos.push(entry.videoId);
    if (recentVideos.length > 50) recentVideos.shift();
  }
  startPlayback(0);
  fillAutoplay();
}

// When nothing is playing, start the next ready song (skipping failed ones).
function maybeAdvance() {
  if (!state.ended || autosync) return;
  while (state.queue[0]?.status === 'error') state.queue.shift();
  const next = state.queue[0];
  if (next?.status === 'ready') {
    state.queue.shift();
    const entry = library.get(next.libraryId);
    // Bluetooth delays drift over time: re-measure every speaker in the gap first.
    const listener = micListener();
    if (state.resyncBetween && listener && state.track && now() - lastResync > RESYNC_EVERY_MS) {
      startAutosync(listener, { auto: true, gap: 500, pending: entry });
      return;
    }
    loadAndPlay(entry);
    broadcastState();
  } else if (!next) {
    fillAutoplay();
  }
}

function skip() {
  state.playing = false;
  state.position = 0;
  state.ended = true;
  maybeAdvance();
}

// Queue a few songs from YouTube's mix for the current song when we're running dry.
function fillAutoplay() {
  const seed = state.track?.videoId || recentVideos[recentVideos.length - 1];
  if (!state.autoplay || autoplayBusy || !seed || state.queue.some((q) => q.status !== 'error')) return;
  autoplayBusy = true;
  yt.mix(seed)
    .then((items) => {
      if (state.queue.length) return;
      const recent = new Set(recentVideos);
      const picks = items
        .filter((it) => !it.live && it.duration <= AUTOPLAY_MAX_SECONDS && !recent.has(it.videoId))
        .slice(0, AUTOPLAY_ADD)
        .map((it) => ({ ...it, auto: true }));
      addItems(picks, 'end');
    })
    .catch(() => {})
    .finally(() => { autoplayBusy = false; });
}

async function addUrl(raw, mode) {
  let url;
  try { url = new URL(String(raw || '').trim()); } catch { return setStatus('That is not a valid link'); }
  const YT_HOSTS = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'];
  if (!/^https?:$/.test(url.protocol) || !YT_HOSTS.includes(url.hostname)) {
    return setStatus('Paste a YouTube link (youtube.com or youtu.be)');
  }
  const videoId = extractVideoId(url);
  const list = url.searchParams.get('list');
  if (list && (!videoId || url.pathname === '/playlist')) {
    setStatus('Reading playlist…');
    try {
      const items = (await yt.playlist(url.href)).filter((it) => !it.live);
      const n = addItems(items, mode);
      setStatus(n ? `Added ${n} song${n === 1 ? '' : 's'} from the playlist` : 'Those songs are already queued');
    } catch (e) {
      setStatus(`Could not read that playlist: ${e.message}`);
    }
    return;
  }
  if (!videoId) return setStatus("Couldn't find a video in that link");
  addItems([{ videoId }], mode);
  setStatus('');
}

// ---- HTTP ----

const app = express();
app.use(express.static(path.join(__dirname, 'dist')));

const requireHost = (req, res, next) =>
  isHostReq(req) ? next() : res.status(403).json({ error: 'Only the host can do that' });

app.get('/api/info', async (req, res) => {
  const urls = lanAddresses();
  const qr = urls[0] ? await QRCode.toDataURL(urls[0], { margin: 1, width: 240 }) : null;
  const info = { urls, qr };
  // The host link is only revealed on the desktop itself.
  if (isLoopback(req.socket.remoteAddress) && hostUrl()) {
    info.hostUrl = hostUrl();
    info.hostQr = await QRCode.toDataURL(info.hostUrl, { margin: 1, width: 240 });
  }
  res.json(info);
});

function wavHeader(dataLen) {
  const b = Buffer.alloc(44);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + dataLen, 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(CHANNELS, 22);
  b.writeUInt32LE(SAMPLE_RATE, 24);
  b.writeUInt32LE(SAMPLE_RATE * BYTES_PER_FRAME, 28);
  b.writeUInt16LE(BYTES_PER_FRAME, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(dataLen, 40);
  return b;
}

// Devices fetch the track in short WAV chunks (see src/player.js).
app.get('/api/chunk/:id/:k', (req, res) => {
  const { id } = req.params;
  const k = Number(req.params.k);
  if (!/^[\w-]+$/.test(id) || !Number.isInteger(k) || k < 0) return res.sendStatus(400);
  fs.stat(library.pcmPath(id), (err, st) => {
    if (err) return res.sendStatus(404);
    const start = k * CHUNK_BYTES;
    if (start >= st.size) return res.sendStatus(404);
    let len = Math.min(CHUNK_BYTES, st.size - start);
    len -= len % BYTES_PER_FRAME;
    res.set({
      'Content-Type': 'audio/wav',
      'Content-Length': String(44 + len),
      'Cache-Control': 'public, max-age=86400, immutable',
    });
    res.write(wavHeader(len));
    fs.createReadStream(library.pcmPath(id), { start, end: start + len - 1 }).pipe(res);
  });
});

app.get('/api/search', requireHost, async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 200);
  if (!q) return res.json({ results: [] });
  try {
    res.json({ results: await yt.search(q) });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get('/api/library', requireHost, (_req, res) => {
  res.json({
    items: library.list().slice(0, 200).map((e) => ({
      id: e.id, name: e.name, duration: e.duration, videoId: e.videoId || null,
    })),
  });
});

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`),
  }),
  limits: { fileSize: 1024 * 1024 * 1024 },
});

app.post('/api/upload', requireHost, upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file' });
  res.json({ ok: true });
  const id = `up-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const name = req.file.originalname.replace(/\.[^.]+$/, '') || 'Uploaded audio';
  setStatus(`Preparing ${name}…`);
  try {
    const info = await preparePcm(req.file.path, library.pcmPath(id), {
      onProgress: (s) => setStatus(`Preparing ${name}… ${fmtTime(s)}`),
    });
    library.add({ id, name, source: 'upload', ...info });
    setStatus('');
    addItems([{ libraryId: id, title: name }], 'end');
  } catch (e) {
    setStatus(e.message);
  }
});

// ---- WebSocket: clock sync, playback control, queue control ----

const server = http.createServer(app);
const servers = [server];
const tls = loadOrCreateCert();
const httpsServer = tls && https.createServer(tls, app);
if (httpsServer) servers.push(httpsServer);

const wss = new WebSocketServer({ noServer: true });
for (const s of servers) {
  s.on('upgrade', (req, socket, head) => {
    if (new URL(req.url, 'http://x').pathname !== '/ws') return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}
function broadcast(msg) {
  for (const c of wss.clients) send(c, msg);
}
function broadcastState() {
  broadcast({ type: 'state', state, clients: wss.clients.size });
}
// Coalesce rapid progress updates into at most ~1 broadcast per 700 ms.
let broadcastTimer = null;
function broadcastSoon() {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    broadcastState();
  }, 700);
}

function startPlayback(position) {
  const dur = state.track?.duration;
  if (dur && position >= dur - 0.25) position = 0;
  state.position = Math.max(0, position);
  state.startAt = now() + START_DELAY_MS;
  state.playing = true;
  state.ended = false;
}

// Only the host may control playback; everyone else is a speaker.
const HOST_ONLY = new Set([
  'play', 'pause', 'seek', 'test', 'autosync', 'autosync-result',
  'add-url', 'queue-add', 'queue-remove', 'queue-next', 'queue-clear', 'skip', 'autoplay', 'library-add',
  'mic-ready', 'resync-between',
]);

// Acoustic auto-sync: each joined device chirps in its own slot while the host listens.
const AUTOSYNC_LEAD_MS = 2500;
const AUTOSYNC_GAP_MS = 1500; // manual runs: wide slots so even very late speakers are found
let autosync = null; // { slots, wasPlaying, pending, timer }
let lastResync = -Infinity;
let nextClientId = 1;

// A host that has granted mic access and can listen for an automatic re-sync.
const micListener = () =>
  [...wss.clients].find((c) => c.isHost && c.micReady && c.joined && c.readyState === c.OPEN) || null;

function startAutosync(listener, { auto = false, gap = AUTOSYNC_GAP_MS, pending = null } = {}) {
  const slots = [...wss.clients]
    .filter((c) => c.joined && c.readyState === c.OPEN)
    .map((c) => ({ id: c.id, label: c.label, nudge: c.nudge ?? 0 }));
  const T0 = now() + AUTOSYNC_LEAD_MS;
  autosync = { slots, wasPlaying: state.playing, pending };
  // If the listener never answers (closed the app, mic failed), don't hang the party.
  autosync.timer = setTimeout(() => finishAutosync([]), AUTOSYNC_LEAD_MS + slots.length * gap + 8000);
  if (state.playing) {
    state.position = currentPosition();
    state.playing = false;
  }
  state.test = false;
  broadcastState();
  broadcast({ type: 'autosync', T0, gap, slots, listener: listener.id, auto });
}

function finishAutosync(corrections) {
  if (!autosync) return;
  const { wasPlaying, pending, timer } = autosync;
  clearTimeout(timer);
  autosync = null;
  lastResync = now();
  const byId = new Map([...wss.clients].map((c) => [c.id, c]));
  for (const { id, delta } of corrections || []) {
    const c = byId.get(id);
    if (c && typeof delta === 'number' && isFinite(delta)) send(c, { type: 'nudge-adjust', delta });
  }
  if (pending) loadAndPlay(pending);
  else if (wasPlaying && state.track) startPlayback(state.position);
  broadcastState();
}

// Hosts get a live view of every device's sync health every 2 s.
setInterval(() => {
  const hosts = [...wss.clients].filter((c) => c.isHost);
  if (!hosts.length) return;
  const devices = [...wss.clients].map((c) => ({
    id: c.id,
    label: c.label,
    isHost: c.isHost,
    joined: !!c.joined,
    micReady: !!c.micReady,
    diag: c.diag && Date.now() - c.diagAt < 10000 ? c.diag : null,
  }));
  for (const h of hosts) send(h, { type: 'devices', devices });
}, 2000);

const MODES = new Set(['end', 'next', 'now']);
const cleanItems = (items) =>
  (Array.isArray(items) ? items : [])
    .filter((it) => it && /^[\w-]{11}$/.test(it.videoId || ''))
    .slice(0, 200)
    .map((it) => ({
      videoId: it.videoId,
      title: String(it.title || '').slice(0, 200),
      duration: Number.isFinite(it.duration) ? it.duration : null,
    }));

wss.on('connection', (ws, req) => {
  const key = new URL(req.url, 'http://x').searchParams.get('key');
  ws.isHost = isLoopback(req.socket.remoteAddress) || key === HOST_KEY;
  ws.id = nextClientId++;
  ws.label = 'Device';
  send(ws, { type: 'hello', isHost: ws.isHost, id: ws.id });
  if (lastStatus) send(ws, { type: 'status', text: lastStatus });
  send(ws, { type: 'state', state, clients: wss.clients.size });
  broadcast({ type: 'clients', clients: wss.clients.size });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (HOST_ONLY.has(msg.type) && !ws.isHost) return;
    const mode = MODES.has(msg.mode) ? msg.mode : 'end';
    switch (msg.type) {
      case 'ping': // clock sync sample
        send(ws, { type: 'pong', t0: msg.t0, ts: now() });
        return;
      case 'play':
        if (!state.track) return maybeAdvance();
        state.test = false;
        startPlayback(typeof msg.position === 'number' ? msg.position : currentPosition());
        break;
      case 'pause':
        if (!state.playing) return;
        state.position = currentPosition();
        state.playing = false;
        break;
      case 'seek':
        if (!state.track) return;
        if (state.playing) startPlayback(msg.position);
        else state.position = Math.max(0, msg.position);
        break;
      case 'test':
        state.test = !!msg.on;
        if (state.test && state.playing) {
          state.position = currentPosition();
          state.playing = false;
        }
        break;
      case 'skip':
        skip();
        break;
      case 'add-url':
        addUrl(msg.url, mode);
        return;
      case 'queue-add':
        addItems(cleanItems(msg.items), mode);
        return;
      case 'library-add':
        if (!library.has(msg.id)) return;
        addItems([{ libraryId: msg.id, title: library.get(msg.id).name }], mode);
        return;
      case 'queue-remove':
        removeItem(msg.qid);
        maybeAdvance();
        pump();
        break;
      case 'queue-next': {
        const i = state.queue.findIndex((q) => q.qid === msg.qid);
        if (i > 0) state.queue.unshift(...state.queue.splice(i, 1));
        break;
      }
      case 'queue-clear':
        for (const q of [...state.queue]) removeItem(q.qid);
        break;
      case 'autoplay':
        state.autoplay = !!msg.on;
        if (state.autoplay) fillAutoplay();
        break;
      case 'joined':
        ws.joined = true;
        ws.label = String(msg.label || 'Device').slice(0, 40);
        return;
      case 'autosync':
        if (!autosync) startAutosync(ws);
        return;
      case 'mic-ready':
        ws.micReady = !!msg.on;
        return;
      case 'resync-between':
        state.resyncBetween = !!msg.on;
        break;
      case 'nudge':
        if (Number.isFinite(msg.value)) ws.nudge = msg.value;
        return;
      case 'diag':
        if (msg.d && typeof msg.d === 'object') {
          ws.diag = msg.d;
          ws.diagAt = Date.now();
        }
        return;
      case 'autosync-result':
        finishAutosync(msg.corrections);
        return;
      default:
        return;
    }
    broadcastState();
  });

  ws.on('close', () => broadcast({ type: 'clients', clients: wss.clients.size }));
});

// When a song finishes, move on to the next one in the queue.
setInterval(() => {
  const dur = state.track?.duration;
  if (state.playing && dur && currentPosition() >= dur) {
    state.playing = false;
    state.position = 0;
    state.ended = true;
    maybeAdvance();
    broadcastState();
  }
}, 250);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`SyncSpeaker running on port ${PORT}`);
  console.log('Speakers: open one of these on every phone (same Wi-Fi):');
  for (const u of lanAddresses()) console.log('  ' + u);
  const host = hostUrl();
  if (host) console.log(`Host (master) link, keep private:\n  ${host}`);
});
httpsServer?.listen(HTTPS_PORT, '0.0.0.0', () => {
  console.log(`Secure host port ${HTTPS_PORT} ready (needed for the host's microphone auto-sync)`);
});
