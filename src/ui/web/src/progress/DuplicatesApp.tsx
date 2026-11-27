import { ChevronDown, Copy, FolderOpen } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import './progress.css';

interface Group {
  size: number;
  wasted: number;
  files: { path: string; modified: number }[];
}

interface Duplicates {
  status: { state: string; startedAt?: number; finishedAt?: number | null };
  groups: Group[];
}

const ARCHIVE = '/home/saadnoor/Saadnoors Life/';
const POLL_MS = 15000;

function size(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.round(bytes / 1e3)} KB`;
}

const rel = (p: string) => (p.startsWith(ARCHIVE) ? p.slice(ARCHIVE.length) : p);

/** "2023/January/trip/x.MP4" → "2023 · January" for grouping. */
function bucket(g: Group): string {
  const parts = rel(g.files[0]?.path ?? '').split('/');
  return parts.length > 2 ? `${parts[0]} · ${parts[1]}` : (parts[0] ?? 'Other');
}

function ago(sec?: number | null): string {
  if (!sec) return '';
  const m = Math.round((Date.now() / 1000 - sec) / 60);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

/** Phone view of the archive's duplicate files (read-only). */
export function DuplicatesApp() {
  const [data, setData] = useState<Duplicates | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch('/api/duplicates')
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json() as Promise<Duplicates>;
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

  const groups = data?.groups ?? [];
  const wasted = groups.reduce((s, g) => s + g.wasted, 0);
  const copies = groups.reduce((s, g) => s + g.files.length - 1, 0);
  const buckets = useMemo(() => {
    const map = new Map<string, { wasted: number; items: { g: Group; i: number }[] }>();
    groups.forEach((g, i) => {
      const k = bucket(g);
      const b = map.get(k) ?? { wasted: 0, items: [] };
      b.wasted += g.wasted;
      b.items.push({ g, i });
      map.set(k, b);
    });
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [groups]);

  const st = data?.status;
  const scanning = st?.state === 'scanning';

  return (
    <div className="pg">
      <header className="pg-head">
        <div className="pg-title">
          <Copy size={22} aria-hidden />
          <h1>Duplicates</h1>
          <span
            className={`pg-pill ${scanning ? 'is-live' : st?.state === 'done' ? 'is-done' : ''}`}
          >
            {scanning
              ? 'Scanning'
              : st?.state === 'done'
                ? 'Scanned'
                : st?.state === 'failed'
                  ? 'Failed'
                  : 'Not scanned'}
          </span>
        </div>
        {error ? <p className="pg-error">Can't reach the NAS ({error})</p> : null}
      </header>

      <section className="pg-card pg-overall">
        <div className="pg-big">{size(wasted)}</div>
        <p className="pg-note" style={{ marginTop: 0 }}>
          wasted by duplicate copies
        </p>
        <dl className="pg-stats" style={{ marginTop: 14 }}>
          <div>
            <dt>Sets of identical files</dt>
            <dd>{groups.length.toLocaleString()}</dd>
          </div>
          <div>
            <dt>Extra copies</dt>
            <dd>{copies.toLocaleString()}</dd>
          </div>
        </dl>
        <p className="pg-note">
          {scanning
            ? `Scanning the whole archive… started ${ago(st?.startedAt)}. Results show here when it's done.`
            : st?.finishedAt
              ? `Last scan finished ${ago(st.finishedAt)}. Nothing has been changed — clean up in Czkawka on the Mac (Hard link keeps every folder intact).`
              : 'No scan yet.'}
        </p>
      </section>

      {buckets.map(([name, b]) => (
        <section className="pg-card" key={name}>
          <h2>
            {name} · {size(b.wasted)}
          </h2>
          <ul className="pg-months">
            {b.items.map(({ g, i }) => {
              const first = rel(g.files[0]?.path ?? '');
              const isOpen = open === i;
              return (
                <li key={i} className="pg-month">
                  <button
                    type="button"
                    className="dup-row"
                    onClick={() => setOpen(isOpen ? null : i)}
                    aria-expanded={isOpen}
                  >
                    <span className="dup-name">{first.split('/').pop()}</span>
                    <span className="dup-meta">
                      {g.files.length}× · {size(g.size)}
                    </span>
                    <ChevronDown
                      size={16}
                      className={isOpen ? 'dup-chev is-open' : 'dup-chev'}
                      aria-hidden
                    />
                  </button>
                  {isOpen ? (
                    <ul className="dup-files">
                      {g.files.map((f) => (
                        <li key={f.path}>
                          <FolderOpen size={14} aria-hidden />
                          <span>{rel(f.path).split('/').slice(0, -1).join(' / ')}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
