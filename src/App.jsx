import React, { useEffect, useRef, useState, useCallback } from 'react';
import { createClock } from './clock.js';
import { playChirp, startRecorder, detectChirps } from './autosync.js';
import { ChunkPlayer } from './player.js';
import { MusicPicker, Queue, thumb } from './Music.jsx';
import { Devices } from './Devices.jsx';

const deviceLabel = () => {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad|Macintosh/.test(ua) && navigator.maxTouchPoints > 1) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Macintosh/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  return 'Computer';
};

const fmt = (s) => {
  if (!isFinite(s) || s < 0) s = 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(Math.floor(s % 60)).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};

// Per-device delay correction range (ms). Bluetooth is ~100–600 ms, AirPlay ~2 s.
const MIN_NUDGE = -300;
const MAX_NUDGE = 3000;

const loadNumber = (key, fallback) => {
  try {
    const v = Number(localStorage.getItem(key));
    return isFinite(v) && localStorage.getItem(key) !== null ? v : fallback;
  } catch {
    return fallback;
  }
};
const saveNumber = (key, v) => {
  try { localStorage.setItem(key, String(v)); } catch {}
};

// A host link (/?host=<key>) makes this device the master; remember it and tidy the URL.
const hostKey = (() => {
  const fromUrl = new URLSearchParams(location.search).get('host');
  if (fromUrl) history.replaceState(null, '', '/');
  try {
    if (fromUrl) localStorage.setItem('ss-host-key', fromUrl);
    return fromUrl || localStorage.getItem('ss-host-key') || '';
  } catch {
    return fromUrl || '';
  }
})();

export default function App() {
  const [isHost, setIsHost] = useState(false);
  const [joined, setJoined] = useState(false);
  const [conn, setConn] = useState('connecting');
  const [state, setState] = useState(null);
  const [clients, setClients] = useState(0);
  const [info, setInfo] = useState(null);
  const [syncStats, setSyncStats] = useState(null);
  const [nudge, setNudge] = useState(() => loadNumber('ss-nudge', 0));
  const [volume, setVolume] = useState(() => loadNumber('ss-volume', 1));
  const [pos, setPos] = useState(0);
  const [upload, setUpload] = useState(null);
  const [scrub, setScrub] = useState(null);
  const [serverStatus, setServerStatus] = useState('');

  const [buffering, setBuffering] = useState(false);

  const wsRef = useRef(null);
  const clockRef = useRef(null);
  const ctxRef = useRef(null);
  const gainRef = useRef(null);
  const playerRef = useRef(null);
  const stateRef = useRef(null);
  const nudgeRef = useRef(nudge);
  const volumeRef = useRef(volume);
  const lastBeepRef = useRef(0);
  const myIdRef = useRef(null);
  const joinedRef = useRef(false);
  const recorderRef = useRef(null);
  const autosyncHandlerRef = useRef(null);
  const nudgeAdjustRef = useRef(null);
  const [auto, setAuto] = useState(null); // host: { phase, text, results }
  const [slotInfo, setSlotInfo] = useState(null); // this device's chirp slot during auto-sync
  const [autoNote, setAutoNote] = useState('');
  const [devices, setDevices] = useState([]); // host: live diagnostics from every device
  const calibRef = useRef(null); // { heard: [perfTime...], taps: [perfTime...] }
  const [calib, setCalib] = useState(null); // { phase: 'run'|'done'|'error', taps, total, result }

  const send = useCallback((msg) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  // AudioContext time at which a sample must be scheduled to be *heard* at server time T.
  // getOutputTimestamp pairs the audio clock with performance.now() and accounts for
  // output latency; fall back to currentTime + reported latency where unsupported.
  const serverToCtxTime = (T) => {
    const ctx = ctxRef.current;
    const { offset } = clockRef.current.stats();
    const ts = ctx.getOutputTimestamp?.();
    if (ts && ts.contextTime > 0 && ts.performanceTime > 0) {
      return ts.contextTime + (T - offset - ts.performanceTime) / 1000;
    }
    const outputLatency = ctx.outputLatency || ctx.baseLatency || 0;
    return ctx.currentTime + (T - clockRef.current.serverNow()) / 1000 - outputLatency;
  };

  // WebSocket connection with auto-reconnect + clock sync.
  useEffect(() => {
    let closed = false;
    let resyncTimer;
    const clock = createClock((t0) => send({ type: 'ping', t0 }));
    clockRef.current = clock;

    const resync = async () => {
      const wasSynced = clock.stats().synced;
      await (wasSynced ? clock.sync(6, 50) : clock.sync(20, 60));
      setSyncStats(clock.stats());
      // Later resyncs are absorbed smoothly by the player's drift correction.
      if (!wasSynced) playerRef.current?.reset();
    };

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const keyParam = hostKey ? `?key=${encodeURIComponent(hostKey)}` : '';
      const ws = new WebSocket(`${proto}://${location.host}/ws${keyParam}`);
      wsRef.current = ws;
      ws.onopen = () => {
        setConn('connected');
        resync();
        clearInterval(resyncTimer);
        resyncTimer = setInterval(resync, 5000);
      };
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'pong') clock.onPong(msg);
        else if (msg.type === 'hello') {
          myIdRef.current = msg.id;
          setIsHost(msg.isHost);
          if (joinedRef.current) {
            send({ type: 'joined', label: deviceLabel() });
            send({ type: 'nudge', value: nudgeRef.current });
          }
        } else if (msg.type === 'autosync') autosyncHandlerRef.current?.(msg);
        else if (msg.type === 'nudge-adjust') nudgeAdjustRef.current?.(msg.delta);
        else if (msg.type === 'clients') setClients(msg.clients);
        else if (msg.type === 'devices') setDevices(msg.devices);
        else if (msg.type === 'status') {
          setServerStatus(msg.text);
        } else if (msg.type === 'state') {
          stateRef.current = msg.state;
          setState(msg.state);
          setClients(msg.clients);
          playerRef.current?.setState(msg.state);
        }
      };
      ws.onclose = () => {
        setConn('reconnecting');
        clearInterval(resyncTimer);
        if (!closed) setTimeout(connect, 1500);
      };
    };
    connect();
    fetch('/api/info').then((r) => r.json()).then(setInfo).catch(() => {});

    return () => {
      closed = true;
      clearInterval(resyncTimer);
      wsRef.current?.close();
    };
  }, [send]);

  // Resume audio when the page comes back to the foreground.
  useEffect(() => {
    const onVis = async () => {
      if (document.visibilityState !== 'visible' || !ctxRef.current) return;
      try { await ctxRef.current.resume(); } catch {}
      playerRef.current?.reset();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  // Sync test: every device beeps on each whole server second, so lag is easy to hear.
  const testing = !!state?.test;
  useEffect(() => {
    if (!joined || !testing) return;
    lastBeepRef.current = 0;
    const id = setInterval(() => {
      const ctx = ctxRef.current;
      if (!ctx || !clockRef.current.stats().synced) return;
      const nowS = clockRef.current.serverNow();
      for (let T = Math.ceil(nowS / 1000) * 1000; T < nowS + 1000; T += 1000) {
        if (T <= lastBeepRef.current) continue;
        const when = serverToCtxTime(T - nudgeRef.current);
        if (when < ctx.currentTime + 0.02) continue;
        lastBeepRef.current = T;
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.frequency.value = (T / 1000) % 4 === 0 ? 1760 : 880;
        g.gain.setValueAtTime(0.6, when);
        g.gain.exponentialRampToValueAtTime(0.001, when + 0.06);
        osc.connect(g).connect(gainRef.current);
        osc.start(when);
        osc.stop(when + 0.07);
      }
    }, 200);
    return () => clearInterval(id);
  }, [joined, testing]);

  // Progress display.
  useEffect(() => {
    const id = setInterval(() => {
      const s = stateRef.current;
      if (!s) return;
      const p = s.playing ? s.position + (clockRef.current.serverNow() - s.startAt) / 1000 : s.position;
      setPos(Math.max(0, p));
    }, 250);
    return () => clearInterval(id);
  }, []);

  const join = async () => {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    // Match the server's 48 kHz chunks so they never need resampling (fallback: device default).
    let ctx;
    try {
      ctx = new Ctx({ latencyHint: 'playback', sampleRate: 48000 });
    } catch {
      ctx = new Ctx({ latencyHint: 'playback' });
    }
    // iOS: play through the ringer/silent switch.
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}
    // Unlock audio output on iOS/Android with a silent buffer inside the tap.
    const unlock = ctx.createBufferSource();
    unlock.buffer = ctx.createBuffer(1, 1, 22050);
    unlock.connect(ctx.destination);
    unlock.start(0);
    await ctx.resume();
    const gain = ctx.createGain();
    gain.gain.value = volume;
    gain.connect(ctx.destination);
    ctxRef.current = ctx;
    gainRef.current = gain;
    playerRef.current = new ChunkPlayer({
      ctx,
      output: gain,
      serverToCtxTime,
      getNudge: () => nudgeRef.current,
      isSynced: () => clockRef.current.stats().synced,
      onBuffering: setBuffering,
    });
    playerRef.current.setState(stateRef.current);
    setJoined(true);
    joinedRef.current = true;
    send({ type: 'joined', label: deviceLabel() });
    send({ type: 'nudge', value: nudgeRef.current });
  };

  const onNudge = (v) => {
    setNudge(v);
    nudgeRef.current = v;
    saveNumber('ss-nudge', v);
    send({ type: 'nudge', value: v }); // the host's auto-sync needs every device's current value
    playerRef.current?.reset();
  };

  // performance.now() time at which a sample scheduled at AudioContext time c is heard,
  // as far as the browser knows (Bluetooth delay is what it *doesn't* know).
  const ctxToPerf = (c) => {
    const ctx = ctxRef.current;
    const ts = ctx.getOutputTimestamp?.();
    if (ts && ts.contextTime > 0 && ts.performanceTime > 0) {
      return ts.performanceTime + (c - ts.contextTime) * 1000;
    }
    return performance.now() + (c - ctx.currentTime + (ctx.outputLatency || ctx.baseLatency || 0)) * 1000;
  };

  // Tap-along calibration: beeps at known times, the user taps on what they hear,
  // and the median gap is this device's extra (Bluetooth) delay.
  const CAL_BEEPS = 10;
  const CAL_GAP = 1.0;
  const startCalibration = () => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    gainRef.current.gain.value = 0; // silence the music while calibrating
    const t0 = ctx.currentTime + 1.0;
    const heard = [];
    for (let i = 0; i < CAL_BEEPS; i++) {
      const c = t0 + i * CAL_GAP;
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.frequency.value = 1320;
      g.gain.setValueAtTime(0.7, c);
      g.gain.exponentialRampToValueAtTime(0.001, c + 0.08);
      osc.connect(g).connect(ctx.destination);
      osc.start(c);
      osc.stop(c + 0.09);
      heard.push(ctxToPerf(c));
    }
    calibRef.current = { heard, taps: [] };
    setCalib({ phase: 'run', taps: 0, total: CAL_BEEPS });
    setTimeout(finishCalibration, (1.0 + CAL_BEEPS * CAL_GAP + 1.0) * 1000);
  };

  const onCalibTap = () => {
    const c = calibRef.current;
    if (!c) return;
    c.taps.push(performance.now());
    setCalib((s) => s && { ...s, taps: c.taps.length });
  };

  const finishCalibration = () => {
    const c = calibRef.current;
    calibRef.current = null;
    if (gainRef.current) gainRef.current.gain.value = volumeRef.current;
    if (!c) return;
    // Pair each tap with the latest beep it could be reacting to (taps may land slightly early).
    const delays = c.taps
      .map((t) => {
        const h = c.heard.filter((x) => x <= t + 150).pop();
        return h === undefined ? null : t - h;
      })
      .filter((d) => d !== null && d > -150 && d < CAL_GAP * 1000 - 150);
    const usable = delays.slice(2); // the first taps are usually late while finding the beat
    if (usable.length < 4) {
      setCalib({ phase: 'error' });
      return;
    }
    usable.sort((a, b) => a - b);
    const median = usable[usable.length >> 1];
    const result = Math.max(MIN_NUDGE, Math.min(MAX_NUDGE, Math.round(median / 5) * 5));
    onNudge(result);
    setCalib({ phase: 'done', result });
  };

  // ---- Acoustic auto-sync ----

  const micSupported = () => window.isSecureContext && !!navigator.mediaDevices?.getUserMedia;

  // Host: get mic permission, then ask the server to make every speaker chirp in turn.
  // After one successful run the server can also re-sync automatically between songs.
  const runAutoSync = async () => {
    if (!micSupported()) {
      setAuto({ phase: 'error', text: 'Auto-sync needs the microphone, which only works on the secure host link (https://…:8443). Scan the host QR on the desktop again.' });
      return;
    }
    setAuto({ phase: 'mic', text: 'Allow microphone access…' });
    try {
      recorderRef.current = await startRecorder(ctxRef.current);
    } catch {
      setAuto({ phase: 'error', text: 'Microphone access was blocked. Allow it in the browser settings and try again.' });
      return;
    }
    send({ type: 'mic-ready', on: true });
    setAuto({ phase: 'listening', text: 'Starting… keep the room quiet.' });
    send({ type: 'autosync' });
  };

  // Every device: chirp in our slot. The chosen listener (the host) records and analyses.
  autosyncHandlerRef.current = async (msg) => {
    const ctx = ctxRef.current;
    const clock = clockRef.current;
    if (!ctx || !clock.stats().synced) return;
    const slotEnd = msg.T0 + msg.slots.length * msg.gap;
    const i = msg.slots.findIndex((s) => s.id === myIdRef.current);
    if (i >= 0) {
      playChirp(ctx, serverToCtxTime(msg.T0 + i * msg.gap - nudgeRef.current));
      setSlotInfo({ n: i + 1, total: msg.slots.length, auto: msg.auto });
      setTimeout(() => setSlotInfo(null), slotEnd + 1500 - clock.serverNow());
    }
    if (msg.listener !== myIdRef.current) return;

    const fail = (text) => {
      setAuto({ phase: 'error', text });
      send({ type: 'autosync-result', corrections: [] });
    };
    let rec = recorderRef.current;
    recorderRef.current = null;
    if (!rec) {
      try {
        rec = await startRecorder(ctx);
      } catch {
        send({ type: 'mic-ready', on: false });
        return fail('Automatic re-sync could not use the microphone. Tap Auto-sync to allow it again.');
      }
    }
    const sr = ctx.sampleRate;
    const c0 = ctx.currentTime;
    const s0 = clock.serverNow();
    const expectedFrames = msg.slots.map((_, k) => Math.round((c0 + (msg.T0 + k * msg.gap - s0) / 1000) * sr));
    setAuto({
      phase: 'listening',
      text: `${msg.auto ? 'Re-syncing between songs' : 'Listening'}: ${msg.slots.length} speaker${msg.slots.length === 1 ? '' : 's'}… keep quiet.`,
    });

    setTimeout(() => {
      const recording = rec.stop();
      ctx.resume().catch(() => {});
      if (!recording) return fail('The microphone recorded nothing. Try again.');
      setAuto({ phase: 'analysing', text: 'Measuring each speaker…' });
      setTimeout(() => {
        const found = detectChirps(recording, expectedFrames, sr, msg.gap / 1000)
          .map((d, k) => ({ ...d, ...msg.slots[k], n: k + 1 }));
        const heard = found.filter((f) => f.ok);
        if (!heard.length) {
          return fail("Couldn't hear any speaker. Turn the volumes up, hold this phone in the middle of the room, and try again.");
        }
        // Each device's total correction should become (its current correction + how late
        // it was heard). Shift everyone together so the smallest total is 0: relative sync
        // is unchanged, but corrections can't creep upward run after run into the limit.
        const nudgeOf = (id) =>
          id === myIdRef.current ? nudgeRef.current : msg.slots.find((x) => x.id === id)?.nudge ?? 0;
        const ref = Math.min(...heard.map((f) => nudgeOf(f.id) + f.residualMs));
        const corrections = heard
          .map((f) => ({ id: f.id, delta: Math.round(f.residualMs - ref) }))
          .filter((c) => Math.abs(c.delta) >= 3);
        send({ type: 'autosync-result', corrections });
        setAuto({
          phase: 'done',
          auto: msg.auto,
          at: Date.now(),
          results: found.map((f) => ({
            key: f.id,
            label: `#${f.n} ${f.label}${f.id === myIdRef.current ? ' (this phone)' : ''}`,
            ok: f.ok,
            delta: f.ok ? Math.round(f.residualMs + nudgeOf(f.id) - ref) : null,
          })),
        });
      }, 50);
    }, Math.max(0, slotEnd + 800 - clock.serverNow()));
  };

  // Every device: report how its sync is doing, so the host can see where lag comes from.
  useEffect(() => {
    if (!joined) return;
    const id = setInterval(() => {
      const ctx = ctxRef.current;
      const c = clockRef.current?.stats();
      if (!ctx || !c) return;
      const p = playerRef.current;
      send({
        type: 'diag',
        d: {
          rtt: Math.round(c.rtt),
          jitter: Math.round(c.jitter * 10) / 10,
          skewPpm: Math.round(c.skewPpm),
          synced: c.synced,
          outLatency: Math.round((ctx.outputLatency || ctx.baseLatency || 0) * 1000),
          nudge: nudgeRef.current,
          driftMs: p ? Math.round(p.err * 1000) : 0,
          buffering: !!p?.buffering,
          audio: ctx.state,
          sampleRate: ctx.sampleRate,
          hidden: document.visibilityState !== 'visible',
        },
      });
    }, 3000);
    return () => clearInterval(id);
  }, [joined, send]);

  // Every device: apply the correction the host measured for us.
  nudgeAdjustRef.current = (delta) => {
    const v = Math.max(MIN_NUDGE, Math.min(MAX_NUDGE, Math.round(nudgeRef.current + delta)));
    onNudge(v);
    setAutoNote(`Auto-sync adjusted this speaker by ${delta > 0 ? '+' : ''}${delta} ms (now ${v} ms).`);
  };

  const onVolume = (v) => {
    setVolume(v);
    volumeRef.current = v;
    saveNumber('ss-volume', v);
    if (gainRef.current && !calibRef.current) gainRef.current.gain.value = v;
  };

  const onFile = (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const fd = new FormData();
    fd.append('audio', file);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.setRequestHeader('X-Host-Key', hostKey);
    xhr.upload.onprogress = (ev) => ev.lengthComputable && setUpload(ev.loaded / ev.total);
    xhr.onload = xhr.onerror = () => setUpload(null);
    setUpload(0);
    xhr.send(fd);
  };

  const duration = state?.track?.duration || 0;
  const shownPos = scrub ?? Math.min(pos, duration || pos);
  const ready = !buffering;

  if (!joined) {
    return (
      <div className="join">
        <div className="logo">◉ SyncSpeaker</div>
        <p>Turn every phone into one big speaker.</p>
        <button className="big" onClick={join}>Tap to join the party</button>
        <p className="muted small">
          {conn === 'connected' ? `${clients} device${clients === 1 ? '' : 's'} connected` : 'Connecting…'}
        </p>
      </div>
    );
  }

  return (
    <div className="app">
      {calib?.phase === 'run' && (
        <div className="calib-overlay" onPointerDown={onCalibTap}>
          <p>Connect this phone to the Bluetooth speaker.</p>
          <p className="muted">Tap anywhere exactly when you <b>hear</b> each beep from the speaker.</p>
          <div className="tap-circle">TAP</div>
          <p className="muted small">{calib.taps} taps</p>
        </div>
      )}
      <header>
        <div className="logo">◉ SyncSpeaker</div>
        <div className="badges">
          <div className={`pill role ${isHost ? 'host' : ''}`}>{isHost ? '★ Host' : 'Speaker'}</div>
          <div className={`pill ${conn}`}>
            {conn === 'connected' ? `${clients} device${clients === 1 ? '' : 's'}` : conn}
          </div>
        </div>
      </header>

      <section className="card">
        <div className="now">
          {state?.track?.videoId && <img className="now-thumb" src={thumb(state.track.videoId)} alt="" />}
          <div className="track">
            {state?.track?.name || (isHost ? 'Nothing playing yet. Search for a song below.' : 'Waiting for the host to pick a song…')}
          </div>
        </div>
        {state?.ended && state?.queue?.length > 0 && (
          <div className="muted small">Next song is still downloading, it will start automatically…</div>
        )}
        {state?.playing && buffering && <div className="muted small">Buffering…</div>}
        {!isHost && serverStatus && <div className="muted small">{serverStatus}</div>}
        {slotInfo && (
          <div className="slot-banner">
            {slotInfo.auto ? 'Re-syncing between songs' : 'Auto-sync'}: this is speaker <b>#{slotInfo.n}</b> of{' '}
            {slotInfo.total}. Stay quiet for a few seconds.
          </div>
        )}
        {autoNote && !slotInfo && <div className="ok small">{autoNote}</div>}

        <input
          type="range"
          className="seek"
          min={0}
          max={duration || 1}
          step={0.1}
          value={shownPos}
          disabled={!state?.track || !isHost}
          onChange={(e) => setScrub(Number(e.target.value))}
          onPointerUp={() => {
            if (scrub != null) send({ type: 'seek', position: scrub });
            setScrub(null);
          }}
          onKeyUp={() => {
            if (scrub != null) send({ type: 'seek', position: scrub });
            setScrub(null);
          }}
        />
        <div className="times muted small">
          <span>{fmt(shownPos)}</span>
          <span>{fmt(duration)}</span>
        </div>

        {isHost ? (
          <div className="controls">
            <button disabled={!state?.track} onClick={() => send({ type: 'seek', position: Math.max(0, pos - 10) })}>
              −10s
            </button>
            <button
              className="play"
              disabled={!state?.track}
              onClick={() => send({ type: state?.playing ? 'pause' : 'play' })}
            >
              {state?.playing ? '❚❚' : '▶'}
            </button>
            <button disabled={!state?.track} onClick={() => send({ type: 'seek', position: pos + 10 })}>
              +10s
            </button>
            <button disabled={!state?.queue?.length} title="Next song" onClick={() => send({ type: 'skip' })}>
              ⏭
            </button>
          </div>
        ) : (
          <div className="speaker-status center">
            {state?.playing ? (ready ? '🔊 Playing in sync' : 'Loading the song…') : state?.track ? '⏸ Paused by host' : ''}
          </div>
        )}
      </section>

      {isHost && (
        <MusicPicker send={send} hostKey={hostKey} serverStatus={serverStatus} onFile={onFile} upload={upload} />
      )}

      <Queue state={state} isHost={isHost} send={send} />

      {isHost && (
      <section className="card">
        <button className={testing ? 'testing' : ''} onClick={() => send({ type: 'test', on: !testing })}>
          {testing ? 'Stop sync test' : 'Sync test (beeps on all devices)'}
        </button>
      </section>
      )}

      {isHost && (
        <section className="card">
          <h3>Sync all speakers</h3>
          <p className="muted small">
            Hold this phone where people will listen. Every speaker chirps once, this phone's microphone hears
            them, and each one is corrected automatically, Bluetooth delay included.
          </p>
          <button
            className="autosync"
            onClick={runAutoSync}
            disabled={['mic', 'listening', 'analysing'].includes(auto?.phase)}
          >
            {['mic', 'listening', 'analysing'].includes(auto?.phase) ? auto.text : '🎯 Auto-sync all speakers'}
          </button>
          {auto?.phase === 'error' && <p className="err small">{auto.text}</p>}
          {auto?.phase === 'done' && (
            <>
              <ul className="results">
                {auto.results.map((r) => (
                  <li key={r.key}>
                    <span>{r.label}</span>
                    <span className={r.ok ? 'ok' : 'err'}>
                      {r.ok ? (r.delta === 0 ? 'no delay needed' : `${r.delta} ms correction`) : 'not heard'}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="muted small">
                {auto.auto ? 'Re-synced automatically between songs.' : 'Corrections applied. Run it again once more to fine-tune.'}
              </p>
            </>
          )}
        </section>
      )}

      {isHost && (
        <Devices
          devices={devices}
          myId={myIdRef.current}
          micReady={devices.some((x) => x.micReady)}
          resyncBetween={state?.resyncBetween}
          onToggleResync={(on) => send({ type: 'resync-between', on })}
        />
      )}

      {testing && (
        <p className="muted small center">
          Sync test running: every device beeps once a second. Adjust each device's delay until the beeps sound like one.
        </p>
      )}

      <section className="card">
        <h3>This device</h3>
        <label className="row">
          <span>Volume</span>
          <input type="range" min={0} max={1} step={0.01} value={volume} onChange={(e) => onVolume(Number(e.target.value))} />
        </label>
        <label className="row">
          <span>Speaker delay fix</span>
          <input type="range" min={MIN_NUDGE} max={MAX_NUDGE} step={5} value={nudge} onChange={(e) => onNudge(Number(e.target.value))} />
          <span className="val">{nudge} ms</span>
        </label>
        <div className="fine">
          <button onClick={() => onNudge(Math.max(MIN_NUDGE, nudge - 10))}>−10 ms</button>
          <button onClick={() => onNudge(0)}>Reset</button>
          <button onClick={() => onNudge(Math.min(MAX_NUDGE, nudge + 10))}>+10 ms</button>
        </div>
        <button className="calibrate" onClick={startCalibration} disabled={calib?.phase === 'run'}>
          Calibrate Bluetooth delay (tap along)
        </button>
        {calib?.phase === 'done' && (
          <p className="ok small">Measured {calib.result} ms and applied it. Use ±10 ms to fine-tune.</p>
        )}
        {calib?.phase === 'error' && (
          <p className="muted small">Not enough taps were heard. Try again and tap on every beep.</p>
        )}
        <p className="muted small">
          If this device sounds <b>behind</b> the others (common with Bluetooth speakers), slide right.
          If it sounds <b>ahead</b>, slide left.
        </p>
        <div className="muted small">
          Clock sync: {syncStats?.synced ? `±${(syncStats.rtt / 2).toFixed(0)} ms (rtt ${syncStats.rtt.toFixed(0)} ms)` : 'syncing…'}
          {ctxRef.current && ` · output latency ${(((ctxRef.current.outputLatency || ctxRef.current.baseLatency || 0)) * 1000).toFixed(0)} ms`}
        </div>
      </section>

      {info?.urls?.length > 0 && (
        <section className="card invite">
          <h3>Add more speakers</h3>
          {info.qr && <img src={info.qr} alt="QR code to join" />}
          <div>
            <p className="muted small">On the same Wi-Fi, scan or open:</p>
            {info.urls.map((u) => <div key={u} className="url">{u}</div>)}
          </div>
        </section>
      )}

      {info?.hostQr && (
        <section className="card invite host-invite">
          <h3>Make your phone the host</h3>
          <img src={info.hostQr} alt="QR code for host access" />
          <div>
            <p className="muted small">
              Scan with <b>your</b> phone to control the music from it. Keep this one private: anyone with it can
              control playback.
            </p>
            <div className="url">{info.hostUrl}</div>
          </div>
        </section>
      )}
    </div>
  );
}
