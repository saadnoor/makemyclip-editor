import { Cpu, Film, Laptop, Server } from 'lucide-react';
import { useEffect, useState } from 'react';
import './progress.css';

interface MonthProgress {
  month: string;
  folder: string;
  total: number;
  done: number;
  cpuTotal: number;
  cpuDone: number;
  bytes: number;
  working: { who: 'nas' | 'mac'; clip: string }[];
  imported: boolean;
}

interface Progress {
  months: MonthProgress[];
  clipsPerHour: number;
  running: boolean;
  finished: boolean;
  log: string[];
  at: number;
}

const POLL_MS = 5000;

function monthName(id: string): string {
  const [y, m] = id.split('-').map(Number);
  return new Date(y ?? 2000, (m ?? 1) - 1, 1).toLocaleString(undefined, {
    month: 'long',
    year: 'numeric',
  });
}

function gb(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
}

function duration(hours: number): string {
  if (!Number.isFinite(hours) || hours <= 0) return '—';
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`;
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return m ? `${h} h ${m} min` : `${h} h`;
}

function status(m: MonthProgress): { label: string; tone: 'done' | 'active' | 'waiting' } {
  if (m.total > 0 && m.done >= m.total) {
    return { label: m.imported ? 'Ready to edit' : 'Proxies done', tone: 'done' };
  }
  if (m.working.length > 0 || (m.total > 0 && m.done > 0))
    return { label: 'Working', tone: 'active' };
  return { label: 'Waiting', tone: 'waiting' };
}

/** A phone-sized live view of the overnight proxy run. */
export function ProgressApp() {
  const [data, setData] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch('/api/progress')
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json() as Promise<Progress>;
        })
        .then((d) => {
          if (!alive) return;
          setData(d);
          setError(null);
        })
        .catch((e: unknown) => alive && setError(String(e)));
    void load();
    const t = window.setInterval(load, POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, []);

  const months = data?.months ?? [];
  const total = months.reduce((s, m) => s + m.total, 0);
  const done = months.reduce((s, m) => s + Math.min(m.done, m.total), 0);
  const ready = months.filter((m) => m.total > 0 && m.done >= m.total).length;
  const known = months.filter((m) => m.total > 0).length;

  const working = months.flatMap((m) => m.working.map((w) => ({ ...w, month: m.month })));
  const macBusy = working.some((w) => w.who === 'mac');
  // Months not scanned yet have no clip count; assume they're like the average so far.
  const avg = known ? total / known : 0;
  const unknownClips = (months.length - known) * avg;
  // Unscanned months count as average-sized, so % covers the whole plan.
  const expected = total + unknownClips;
  const pct = expected ? Math.min(100, Math.floor((done / expected) * 100)) : 0;
  const eta = data?.clipsPerHour ? (total - done + unknownClips) / data.clipsPerHour : Number.NaN;
  const sizeSoFar = months.reduce((s, m) => s + m.bytes, 0);

  return (
    <div className="pg">
      <header className="pg-head">
        <div className="pg-title">
          <Film size={22} aria-hidden />
          <h1>Proxies</h1>
          <span
            className={`pg-pill ${data?.finished ? 'is-done' : data?.running ? 'is-live' : ''}`}
          >
            {data?.finished ? 'Finished' : data?.running ? 'Running' : 'Idle'}
          </span>
        </div>
        {error ? <p className="pg-error">Can't reach the NAS ({error})</p> : null}
      </header>

      <section className="pg-card pg-overall">
        <div className="pg-big">{pct}%</div>
        <div className="pg-bar">
          <span style={{ width: `${pct}%` }} />
        </div>
        <dl className="pg-stats">
          <div>
            <dt>Months ready</dt>
            <dd>
              {ready} / {months.length}
            </dd>
          </div>
          <div>
            <dt>Clips</dt>
            <dd>
              {done.toLocaleString()} / {total.toLocaleString()}
              {known < months.length ? '+' : ''}
            </dd>
          </div>
          <div>
            <dt>Speed</dt>
            <dd>{data?.clipsPerHour ? `${data.clipsPerHour}/h` : '—'}</dd>
          </div>
          <div>
            <dt>Time left</dt>
            <dd>{data?.finished ? 'Done' : duration(eta)}</dd>
          </div>
        </dl>
        <p className="pg-note">Proxies so far: {gb(sizeSoFar)}</p>
      </section>

      <section className="pg-card">
        <h2>Right now</h2>
        <div className="pg-workers">
          <div className={`pg-worker ${working.some((w) => w.who === 'nas') ? 'is-on' : ''}`}>
            <Server size={18} aria-hidden />
            <span>NAS</span>
            <small>
              {working
                .filter((w) => w.who === 'nas')
                .map((w) => w.clip.replace(/^\d{8}-\d{6}_/, ''))
                .join(', ') || (data?.running ? 'between clips' : 'idle')}
            </small>
          </div>
          <div className={`pg-worker ${macBusy ? 'is-on' : ''}`}>
            <Laptop size={18} aria-hidden />
            <span>Mac</span>
            <small>
              {working
                .filter((w) => w.who === 'mac')
                .map((w) => w.clip.replace(/^\d{8}-\d{6}_/, ''))
                .join(', ') || 'waiting for Sony clips'}
            </small>
          </div>
        </div>
      </section>

      <section className="pg-card">
        <h2>Months</h2>
        <ul className="pg-months">
          {months.map((m) => {
            const s = status(m);
            const p = m.total ? Math.round((Math.min(m.done, m.total) / m.total) * 100) : 0;
            return (
              <li key={m.month} className={`pg-month is-${s.tone}`}>
                <div className="pg-month-row">
                  <span className="pg-month-name">{monthName(m.month)}</span>
                  <span className="pg-month-status">{s.label}</span>
                </div>
                <div className="pg-bar pg-bar-sm">
                  <span style={{ width: `${p}%` }} />
                </div>
                <div className="pg-month-row pg-month-meta">
                  <span>{m.total ? `${m.done} / ${m.total} clips` : 'not scanned yet'}</span>
                  {m.cpuTotal ? (
                    <span>
                      <Cpu size={12} aria-hidden /> Sony {m.cpuDone}/{m.cpuTotal}
                    </span>
                  ) : null}
                  {s.tone === 'done' && m.imported ? (
                    <a href={`/cut?t=${m.month}`}>Edit →</a>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="pg-card">
        <h2>Log</h2>
        <pre className="pg-log">{(data?.log ?? []).join('\n') || '—'}</pre>
      </section>
    </div>
  );
}
