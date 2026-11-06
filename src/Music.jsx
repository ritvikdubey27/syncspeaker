import React, { useState } from 'react';

export const thumb = (videoId) => (videoId ? `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg` : null);

export const fmtDuration = (s) => {
  if (!isFinite(s) || s == null) return '';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(Math.floor(s % 60)).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};

const looksLikeUrl = (s) => /^https?:\/\//i.test(s) || /(^|\.)youtu(\.be|be\.com)\//i.test(s);

function Row({ videoId, title, sub, children }) {
  return (
    <li className="row-item">
      {videoId ? <img className="thumb" src={thumb(videoId)} alt="" loading="lazy" /> : <div className="thumb blank">♪</div>}
      <div className="row-text">
        <div className="row-title">{title}</div>
        {sub && <div className="muted small">{sub}</div>}
      </div>
      <div className="row-actions">{children}</div>
    </li>
  );
}

// Host only: search YouTube / paste links / replay from the library / upload files.
export function MusicPicker({ send, hostKey, serverStatus, onFile, upload }) {
  const [text, setText] = useState('');
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const [added, setAdded] = useState(() => new Set());
  const [library, setLibrary] = useState(null);

  const api = (url) => fetch(url, { headers: { 'X-Host-Key': hostKey } }).then((r) => r.json());

  const onSubmit = async (e) => {
    e.preventDefault();
    const q = text.trim();
    if (!q) return;
    setError('');
    if (looksLikeUrl(q)) {
      send({ type: 'add-url', url: q.startsWith('http') ? q : `https://${q}`, mode: 'end' });
      setText('');
      setResults(null);
      return;
    }
    setSearching(true);
    try {
      const data = await api(`/api/search?q=${encodeURIComponent(q)}`);
      if (data.error) setError(data.error);
      setResults(data.results || []);
    } catch {
      setError('Could not reach the desktop');
    } finally {
      setSearching(false);
    }
  };

  const add = (item, mode) => {
    send({ type: 'queue-add', items: [item], mode });
    setAdded((s) => new Set(s).add(item.videoId));
  };

  const addLibrary = (id, mode) => {
    send({ type: 'library-add', id, mode });
    setAdded((s) => new Set(s).add(id));
  };

  const loadLibrary = (e) => {
    if (e.currentTarget.open) api('/api/library').then((d) => setLibrary(d.items || [])).catch(() => setLibrary([]));
  };

  return (
    <section className="card">
      <h3>Add music</h3>
      <form className="yt" onSubmit={onSubmit}>
        <input
          type="search"
          enterKeyHint="search"
          placeholder="Search YouTube or paste a link / playlist"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button type="submit" disabled={!text.trim() || searching}>
          {searching ? '…' : looksLikeUrl(text.trim()) ? 'Add' : 'Search'}
        </button>
      </form>
      {serverStatus && <div className="muted small">{serverStatus}</div>}
      {error && <p className="err small">{error}</p>}

      {results && (
        <ul className="list">
          {results.length === 0 && <li className="muted small">No results.</li>}
          {results.map((r) => (
            <Row
              key={r.videoId}
              videoId={r.videoId}
              title={r.title}
              sub={[r.channel, r.live ? 'LIVE' : fmtDuration(r.duration)].filter(Boolean).join(' · ')}
            >
              {r.live ? (
                <span className="muted small">can't sync live</span>
              ) : added.has(r.videoId) ? (
                <span className="ok small">Added ✓</span>
              ) : (
                <>
                  <button className="icon" title="Play now" onClick={() => add(r, 'now')}>▶</button>
                  <button className="icon" title="Add to queue" onClick={() => add(r, 'end')}>＋</button>
                </>
              )}
            </Row>
          ))}
        </ul>
      )}

      <details className="library" onToggle={loadLibrary}>
        <summary>Recently played (instant, no download)</summary>
        {library === null ? (
          <p className="muted small">Loading…</p>
        ) : library.length === 0 ? (
          <p className="muted small">Songs you play will appear here.</p>
        ) : (
          <ul className="list">
            {library.map((e) => (
              <Row key={e.id} videoId={e.videoId} title={e.name} sub={fmtDuration(e.duration)}>
                {added.has(e.id) ? (
                  <span className="ok small">Added ✓</span>
                ) : (
                  <>
                    <button className="icon" title="Play now" onClick={() => addLibrary(e.id, 'now')}>▶</button>
                    <button className="icon" title="Add to queue" onClick={() => addLibrary(e.id, 'end')}>＋</button>
                  </>
                )}
              </Row>
            ))}
          </ul>
        )}
      </details>

      <label className="file">
        {upload != null ? `Uploading… ${Math.round(upload * 100)}%` : 'Or add an audio file from this device'}
        <input type="file" accept="audio/*" onChange={onFile} disabled={upload != null} />
      </label>
    </section>
  );
}

// Everyone sees what's coming up; only the host can change it.
export function Queue({ state, isHost, send }) {
  const queue = state?.queue || [];
  if (!isHost && !queue.length) return null;
  const statusText = (q) =>
    q.status === 'ready' ? 'Ready' : q.status === 'error' ? `Failed: ${q.error}` : q.progress || 'Waiting to download';

  return (
    <section className="card">
      <div className="queue-head">
        <h3>Up next {queue.length > 0 && <span className="muted">({queue.length})</span>}</h3>
        {isHost && (
          <label className="toggle">
            <input type="checkbox" checked={!!state?.autoplay} onChange={(e) => send({ type: 'autoplay', on: e.target.checked })} />
            Autoplay similar
          </label>
        )}
      </div>
      {queue.length === 0 ? (
        <p className="muted small">
          Queue is empty. Search or paste links above; songs play one after another automatically.
        </p>
      ) : (
        <ul className="list">
          {queue.map((q, i) => (
            <Row
              key={q.qid}
              videoId={q.videoId}
              title={q.title}
              sub={[q.auto && 'Autoplay', fmtDuration(q.duration), statusText(q)].filter(Boolean).join(' · ')}
            >
              {isHost && (
                <>
                  {i > 0 && <button className="icon" title="Play next" onClick={() => send({ type: 'queue-next', qid: q.qid })}>⤒</button>}
                  <button className="icon" title="Remove" onClick={() => send({ type: 'queue-remove', qid: q.qid })}>✕</button>
                </>
              )}
            </Row>
          ))}
        </ul>
      )}
      {isHost && queue.length > 1 && (
        <button className="link" onClick={() => send({ type: 'queue-clear' })}>Clear queue</button>
      )}
    </section>
  );
}
