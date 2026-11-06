import React from 'react';

// Grade each source of lag separately, so it's clear whether a device is off
// because of Wi-Fi, its own audio path / Bluetooth, or because it's struggling.
function wifiGrade(d) {
  if (!d.synced) return { text: 'syncing…', cls: 'muted' };
  if (d.jitter <= 3 && d.rtt <= 80) return { text: `good (±${d.jitter} ms)`, cls: 'ok' };
  if (d.jitter <= 8) return { text: `fair (±${d.jitter} ms)`, cls: 'warn' };
  return { text: `poor (±${d.jitter} ms)`, cls: 'err' };
}

function issues(d) {
  const out = [];
  if (d.hidden) out.push('screen off / app in background: audio may stop');
  if (d.audio && d.audio !== 'running') out.push(`audio ${d.audio}: open the app on this phone`);
  if (d.buffering) out.push('buffering: weak Wi-Fi signal');
  if (Math.abs(d.driftMs) > 15) out.push(`drifting ${d.driftMs > 0 ? 'behind' : 'ahead'} ${Math.abs(d.driftMs)} ms (correcting)`);
  if (d.jitter > 8) out.push('unstable Wi-Fi: move closer to the router or use 5 GHz');
  return out;
}

export function Devices({ devices, myId, resyncBetween, onToggleResync, micReady }) {
  if (!devices?.length) return null;
  const joined = devices.filter((x) => x.joined && x.diag);
  return (
    <section className="card">
      <div className="queue-head">
        <h3>Devices <span className="muted">({joined.length} playing)</span></h3>
        <label className="toggle">
          <input type="checkbox" checked={!!resyncBetween} onChange={(e) => onToggleResync(e.target.checked)} />
          Re-sync between songs
        </label>
      </div>
      {resyncBetween && !micReady && (
        <p className="muted small">
          Run 🎯 Auto-sync once from the secure host link to allow the mic; after that, speakers are re-measured
          automatically between songs (Bluetooth drift included).
        </p>
      )}
      <ul className="devices">
        {devices.map((x) => {
          const d = x.diag;
          if (!x.joined || !d) {
            return (
              <li key={x.id}>
                <div className="dev-name">{x.label}{x.id === myId ? ' (this phone)' : ''}</div>
                <div className="muted small">connected, hasn't tapped Join yet</div>
              </li>
            );
          }
          const wifi = wifiGrade(d);
          const problems = issues(d);
          return (
            <li key={x.id}>
              <div className="dev-name">
                {x.isHost && '★ '}{x.label}{x.id === myId ? ' (this phone)' : ''}
              </div>
              <div className="dev-grid small">
                <span className="muted">Wi-Fi</span>
                <span className={wifi.cls}>{wifi.text}{d.synced ? `, ${d.rtt} ms ping` : ''}</span>
                <span className="muted">Speaker delay</span>
                <span>
                  {d.outLatency} ms phone{d.nudge ? ` + ${d.nudge} ms correction` : ''}
                  {d.nudge >= 100 ? ' (Bluetooth)' : ''}
                </span>
              </div>
              {problems.map((p) => <div key={p} className="warn small">⚠ {p}</div>)}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
