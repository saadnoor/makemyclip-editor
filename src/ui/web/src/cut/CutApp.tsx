import { usePinch } from '@use-gesture/react';
import {
  ChevronDown,
  ChevronFirst,
  ChevronLast,
  ChevronLeft,
  ChevronRight,
  Expand,
  Pause,
  Play,
  Redo2,
  Scissors,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import {
  type CSSProperties,
  memo,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { withTimeline } from '../lib/timelines.js';
import { applyTimelineVerbs, type Verb } from '../lib/verbs.js';
import type { Composition } from '../types.js';
import { editPoints, type Segment, segmentAt, segmentsOf } from './segments.js';
import { usePlayer } from './usePlayer.js';
import './cut.css';

const MONTH_ID = /^\d{4}-\d{2}$/;
const MIN_PPS = 0.05;
const MAX_PPS = 400;
const POLL_MS = 3000;
/** Shortest clip a trim may leave, in timeline seconds. */
const MIN_CLIP = 0.2;
const RULER_H = 30;

function fmt(t: number): string {
  const s = Math.max(0, t);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

/** Ruler label: seconds when zoomed in (InShot's "4s"), clock time otherwise. */
function tickLabel(t: number, step: number): string {
  if (step < 60 && t < 60) return `${t}s`;
  return fmt(t);
}

/** A tick spacing that leaves ~100px between labels at this zoom. */
function tickStep(pps: number): number {
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  return steps.find((s) => s * pps >= 100) ?? 3600;
}

function monthLabel(id: string): string {
  const [y, m] = id.split('-').map(Number);
  return new Date(y ?? 2000, (m ?? 1) - 1, 1).toLocaleString(undefined, {
    month: 'long',
    year: 'numeric',
  });
}

async function fetchDoc(timeline: string): Promise<Composition> {
  const res = await fetch(withTimeline('/api/timeline', timeline));
  if (!res.ok) throw new Error(`Could not load ${timeline} (HTTP ${res.status})`);
  return ((await res.json()) as { document: Composition }).document;
}

function readStored(key: string, fallback: number): number {
  try {
    return Number(localStorage.getItem(key)) || fallback;
  } catch {
    return fallback;
  }
}

function store(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // Private mode: the setting just isn't remembered.
  }
}

/** A trim in progress: the clip's new source range, before it is saved. */
interface TrimDraft {
  clipId: string;
  srcIn: number;
  srcOut: number;
}

/** The cut list as it would be with `draft` applied, later clips rippled. */
function withDraft(segs: Segment[], draft: TrimDraft | null): Segment[] {
  if (!draft) return segs;
  const target = segs.find((s) => s.clipId === draft.clipId);
  if (!target) return segs;
  const newEnd = target.start + (draft.srcOut - draft.srcIn) / target.speed;
  const shift = newEnd - target.end;
  return segs.map((s) => {
    if (s.clipId === draft.clipId) {
      return { ...s, srcIn: draft.srcIn, srcOut: draft.srcOut, end: newEnd };
    }
    if (s.start >= target.end - 1e-3) return { ...s, start: s.start + shift, end: s.end + shift };
    return s;
  });
}

/**
 * Verbs that save a trim magnetically: the clip's new range, and every later
 * clip moved by the change in length. Moves run in an order that never makes
 * two clips overlap mid-batch.
 */
function trimVerbs(segs: Segment[], draft: TrimDraft): Verb[] {
  const target = segs.find((s) => s.clipId === draft.clipId);
  if (!target) return [];
  const shift = (draft.srcOut - draft.srcIn) / target.speed - (target.end - target.start);
  const later = segs.filter((s) => s.start >= target.end - 1e-3);
  const trim: Verb = {
    verb: 'trim',
    clipId: draft.clipId,
    sourceInSec: draft.srcIn,
    sourceOutSec: draft.srcOut,
  };
  const moves = later.map(
    (s): Verb => ({ verb: 'move', clipId: s.clipId, startSec: s.start + shift }),
  );
  return shift > 0 ? [...moves.reverse(), trim] : [trim, ...moves];
}

/**
 * The Cut screen, InShot style: preview on top, a transport row (play · time ·
 * undo/redo), a filmstrip under a fixed centre playhead, and a tool row. Tap a
 * clip to select it; drag its yellow handles to trim. Every edit is magnetic.
 */
export function CutApp() {
  const [months, setMonths] = useState<string[]>([]);
  const [timeline, setTimeline] = useState<string | null>(() =>
    new URLSearchParams(location.search).get('t'),
  );
  const [doc, setDoc] = useState<Composition | null>(null);
  const [durations, setDurations] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<TrimDraft | null>(null);
  const [tlHeight, setTlHeight] = useState(() => readStored('cut.tlHeight', 170));
  const viewerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch('/api/timelines')
      .then((r) => r.json() as Promise<{ timelines?: { id: string }[] }>)
      .then((json) => {
        const ids = (json.timelines ?? [])
          .map((t) => t.id)
          .filter((id) => MONTH_ID.test(id))
          .sort();
        setMonths(ids);
        setTimeline((cur) => cur ?? ids[0] ?? null);
      })
      .catch(() => setError('Could not list months.'));
  }, []);

  useEffect(() => {
    if (!timeline) return;
    const url = new URL(location.href);
    url.searchParams.set('t', timeline);
    history.replaceState(null, '', url);
    let alive = true;
    const load = () =>
      fetchDoc(timeline)
        .then((d) => {
          if (alive) setDoc((prev) => (prev && prev.rev === d.rev ? prev : d));
        })
        .catch((e: unknown) => alive && setError(String(e)));
    void load();
    fetch('/api/media/durations')
      .then((r) => r.json() as Promise<Record<string, number>>)
      .then((d) => alive && setDurations(d))
      .catch(() => undefined);
    const timer = window.setInterval(load, POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [timeline]);

  const segs = useMemo(() => (doc ? segmentsOf(doc) : []), [doc]);
  const shown = useMemo(() => withDraft(segs, draft), [segs, draft]);
  const player = usePlayer(segs);
  const fps = doc?.fps ?? 25;

  const apply = useCallback(
    async (verbs: Verb[]) => {
      if (!timeline || verbs.length === 0) return;
      setBusy(true);
      setError(null);
      try {
        const { document } = await applyTimelineVerbs(verbs, timeline);
        setDoc(document);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [timeline],
  );

  const step = useCallback(
    async (dir: 'undo' | 'redo') => {
      if (!timeline) return;
      setBusy(true);
      try {
        await fetch(withTimeline(`/api/timeline/${dir}`, timeline), { method: 'POST' });
        setDoc(await fetchDoc(timeline));
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(false);
      }
    },
    [timeline],
  );

  const split = useCallback(() => {
    const seg = segmentAt(segs, player.time);
    if (!seg) return;
    if (player.time - seg.start < 1 / fps || seg.end - player.time < 1 / fps) return;
    void apply([{ verb: 'split', clipId: seg.clipId, atSec: player.time }]);
  }, [apply, fps, player.time, segs]);

  const remove = useCallback(() => {
    const target = segs.find((s) => s.clipId === selected) ?? segmentAt(segs, player.time);
    if (!target) return;
    const gap = target.end - target.start;
    const later = segs.filter((s) => s.start >= target.end - 1e-3);
    setSelected(null);
    void apply([
      { verb: 'remove', clipId: target.clipId },
      ...later.map((s): Verb => ({ verb: 'move', clipId: s.clipId, startSec: s.start - gap })),
    ]);
  }, [apply, player.time, segs, selected]);

  const jumpEdit = useCallback(
    (dir: 1 | -1) => {
      const pts = editPoints(segs);
      const t = player.time;
      const target =
        dir === 1 ? pts.find((p) => p > t + 1e-3) : [...pts].reverse().find((p) => p < t - 1e-3);
      if (target !== undefined) player.seek(target);
    },
    [player, segs],
  );

  const trimStart = useCallback(
    (clipId: string) => {
      const seg = segs.find((s) => s.clipId === clipId);
      if (seg) setDraft({ clipId, srcIn: seg.srcIn, srcOut: seg.srcOut });
    },
    [segs],
  );

  const trimMove = useCallback(
    (clipId: string, edge: 'in' | 'out', deltaSec: number) => {
      const seg = segs.find((s) => s.clipId === clipId);
      if (!seg) return;
      const dsrc = deltaSec * seg.speed;
      const minSrc = MIN_CLIP * seg.speed;
      const maxOut = durations[seg.mediaId] ?? seg.srcOut;
      const next =
        edge === 'in'
          ? {
              clipId,
              srcIn: Math.min(Math.max(0, seg.srcIn + dsrc), seg.srcOut - minSrc),
              srcOut: seg.srcOut,
            }
          : {
              clipId,
              srcIn: seg.srcIn,
              srcOut: Math.max(Math.min(maxOut, seg.srcOut + dsrc), seg.srcIn + minSrc),
            };
      setDraft(next);
      player.peek(seg, edge === 'in' ? next.srcIn : Math.max(next.srcIn, next.srcOut - 1 / fps));
    },
    [durations, fps, player, segs],
  );

  const draftRef = useRef<TrimDraft | null>(null);
  draftRef.current = draft;
  const trimEnd = useCallback(() => {
    const d = draftRef.current;
    if (!d) return;
    const seg = segs.find((s) => s.clipId === d.clipId);
    const changed =
      seg && (Math.abs(seg.srcIn - d.srcIn) > 1e-3 || Math.abs(seg.srcOut - d.srcOut) > 1e-3);
    if (!changed) {
      setDraft(null);
      return;
    }
    // Keep showing the draft until the saved document replaces it.
    void apply(trimVerbs(segs, d)).then(() => setDraft(null));
  }, [apply, segs]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (mod && k === 'z') {
        e.preventDefault();
        void step(e.shiftKey ? 'redo' : 'undo');
      } else if (k === ' ') {
        e.preventDefault();
        player.toggle();
      } else if (k === 'k') player.pause();
      else if (k === 'l') player.play();
      else if (k === 'j') player.seek(player.time - 5);
      else if (k === 'b' || k === 's') split();
      else if (k === 'backspace' || k === 'delete') {
        e.preventDefault();
        remove();
      } else if (k === 'arrowleft') player.seek(player.time - (e.shiftKey ? 1 : 1 / fps));
      else if (k === 'arrowright') player.seek(player.time + (e.shiftKey ? 1 : 1 / fps));
      else if (k === 'arrowup') {
        e.preventDefault();
        jumpEdit(-1);
      } else if (k === 'arrowdown') {
        e.preventDefault();
        jumpEdit(1);
      } else if (k === 'escape') setSelected(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fps, jumpEdit, player, remove, split, step]);

  const fullscreen = () => {
    const box = viewerRef.current;
    const vid = player.videoRefs[player.active].current as
      | (HTMLVideoElement & { webkitEnterFullscreen?: () => void })
      | null;
    if (document.fullscreenElement) void document.exitFullscreen();
    else if (box?.requestFullscreen) void box.requestFullscreen();
    else vid?.webkitEnterFullscreen?.();
  };

  const here = segmentAt(segs, player.time);
  const canSplit =
    !!here && player.time - here.start >= 1 / fps && here.end - player.time >= 1 / fps;
  const canDelete = !!selected || !!here;

  return (
    <div className="cut">
      <header className="cut-top">
        <label className="cut-month">
          <span>{timeline ? monthLabel(timeline) : 'No months'}</span>
          <ChevronDown size={18} strokeWidth={2.5} aria-hidden />
          <select
            aria-label="Month"
            value={timeline ?? ''}
            onChange={(e) => {
              player.pause();
              setDoc(null);
              setSelected(null);
              setTimeline(e.target.value);
            }}
          >
            {months.map((m) => (
              <option key={m} value={m}>
                {monthLabel(m)}
              </option>
            ))}
          </select>
        </label>
        <span className="cut-meta">{segs.length} clips</span>
        <span className={`cut-saving${busy ? ' is-on' : ''}`}>Saving…</span>
        <button type="button" className="cut-next" disabled title="Export comes next">
          Export
          <ChevronRight size={18} strokeWidth={2.5} aria-hidden />
        </button>
      </header>

      {error ? (
        <button type="button" className="cut-toast" onClick={() => setError(null)}>
          <span>{error}</span>
          <X size={16} aria-hidden />
        </button>
      ) : null}

      <div className="cut-stage">
        {/* biome-ignore lint/a11y/noStaticElementInteractions: duplicate of the Play button. */}
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: Space is handled globally. */}
        <div className="cut-viewer" ref={viewerRef} onClick={player.toggle}>
          {player.videoRefs.map((ref, i) => (
            // biome-ignore lint/a11y/useMediaCaption: personal footage has no caption tracks.
            <video
              // biome-ignore lint/suspicious/noArrayIndexKey: exactly two fixed players.
              key={i}
              ref={ref}
              className="cut-video"
              style={{ opacity: !player.blank && player.active === i ? 1 : 0 }}
              playsInline
              preload="auto"
            />
          ))}
          {!doc ? <div className="cut-msg">Loading…</div> : null}
          {doc && segs.length === 0 ? <div className="cut-msg">No clips this month</div> : null}
          <button
            type="button"
            className="cut-icon cut-fs"
            aria-label="Fullscreen"
            onClick={(e) => {
              e.stopPropagation();
              fullscreen();
            }}
          >
            <Expand size={18} />
          </button>
        </div>
      </div>

      <div className="cut-transport">
        <div className="cut-transport-side">
          <button
            type="button"
            className="cut-icon cut-icon-lg"
            aria-label={player.playing ? 'Pause' : 'Play'}
            onClick={player.toggle}
          >
            {player.playing ? (
              <Pause size={26} fill="currentColor" strokeWidth={0} />
            ) : (
              <Play size={26} fill="currentColor" strokeWidth={0} />
            )}
          </button>
          <button
            type="button"
            className="cut-icon"
            aria-label="Previous cut"
            onClick={() => jumpEdit(-1)}
          >
            <ChevronFirst size={22} />
          </button>
          <button
            type="button"
            className="cut-icon"
            aria-label="Next cut"
            onClick={() => jumpEdit(1)}
          >
            <ChevronLast size={22} />
          </button>
        </div>
        <div className="cut-time">
          <span>{fmt(player.time)}</span>
          <span className="cut-time-total">{fmt(player.duration)}</span>
        </div>
        <div className="cut-transport-side cut-transport-end">
          <button
            type="button"
            className="cut-icon"
            aria-label="Undo"
            onClick={() => void step('undo')}
          >
            <Undo2 size={22} />
          </button>
          <button
            type="button"
            className="cut-icon"
            aria-label="Redo"
            onClick={() => void step('redo')}
          >
            <Redo2 size={22} />
          </button>
        </div>
      </div>

      {/* biome-ignore lint/a11y/useSemanticElements: <hr> can't hold a drag handle. */}
      <div
        className="cut-grabber"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Drag to resize the timeline"
        aria-valuenow={tlHeight}
        tabIndex={0}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          const y0 = e.clientY;
          const h0 = tlHeight;
          const move = (ev: PointerEvent) =>
            setTlHeight(Math.min(window.innerHeight * 0.6, Math.max(96, h0 + y0 - ev.clientY)));
          const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            setTlHeight((h) => {
              store('cut.tlHeight', h);
              return h;
            });
          };
          window.addEventListener('pointermove', move);
          window.addEventListener('pointerup', up);
        }}
      >
        <span />
      </div>

      <Timeline
        height={tlHeight}
        segs={shown}
        time={player.time}
        playing={player.playing}
        selected={selected}
        trimming={draft?.clipId ?? null}
        onSelect={setSelected}
        onScrub={(t) => {
          if (player.playing) player.pause();
          player.seek(t);
        }}
        onTrimStart={trimStart}
        onTrimMove={trimMove}
        onTrimEnd={trimEnd}
      />

      <nav className="cut-bar" aria-label="Edit tools">
        {selected ? (
          <button
            type="button"
            className="cut-tool cut-tool-back"
            aria-label="Deselect"
            onClick={() => setSelected(null)}
          >
            <ChevronLeft size={26} strokeWidth={2.5} />
          </button>
        ) : null}
        <button type="button" className="cut-tool" onClick={split} disabled={busy || !canSplit}>
          <Scissors size={24} />
          <span>Split</span>
        </button>
        <button type="button" className="cut-tool" onClick={remove} disabled={busy || !canDelete}>
          <Trash2 size={24} />
          <span>Delete</span>
        </button>
        <p className="cut-bar-hint">
          {selected ? 'Drag the yellow handles to trim' : 'Tap a clip to select · pinch to zoom'}
        </p>
      </nav>
    </div>
  );
}

function Timeline({
  height,
  segs,
  time,
  playing,
  selected,
  trimming,
  onSelect,
  onScrub,
  onTrimStart,
  onTrimMove,
  onTrimEnd,
}: {
  height: number;
  segs: Segment[];
  time: number;
  playing: boolean;
  selected: string | null;
  trimming: string | null;
  onSelect: (id: string | null) => void;
  onScrub: (t: number) => void;
  onTrimStart: (clipId: string) => void;
  onTrimMove: (clipId: string, edge: 'in' | 'out', deltaSec: number) => void;
  onTrimEnd: () => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const total = segs.reduce((m, s) => Math.max(m, s.end), 0);
  const [pps, setPps] = useState<number | null>(null);
  const programmatic = useRef(false);
  const touching = useRef(false);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (pps === null && total > 0) setPps(readStored('cut.pps', Math.max(MIN_PPS, width / 120)));
  }, [pps, total, width]);
  const zoom = pps ?? 1;
  const setZoom = useCallback((z: number) => {
    const v = Math.min(MAX_PPS, Math.max(MIN_PPS, z));
    setPps(v);
    store('cut.pps', v);
  }, []);
  const pad = width / 2;
  const laneHeight = Math.max(36, Math.min(72, height - RULER_H - 24));

  // Keep the playhead under the fixed centre line (not while a trim holds it still).
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || touching.current || trimming) return;
    const target = time * zoom;
    if (Math.abs(el.scrollLeft - target) > 0.5) {
      programmatic.current = true;
      el.scrollLeft = target;
    }
  }, [time, zoom, trimming]);

  usePinch(({ offset: [scale] }) => setZoom(scale), {
    target: scroller,
    scaleBounds: { min: MIN_PPS, max: MAX_PPS },
    from: () => [zoom, 0],
    eventOptions: { passive: false },
    pinchOnWheel: true,
  });

  const onScroll = () => {
    const el = scroller.current;
    if (!el || trimming) return;
    if (programmatic.current) {
      programmatic.current = false;
      return;
    }
    if (playing && !touching.current) return;
    onScrub(el.scrollLeft / zoom);
  };

  const tick = tickStep(zoom);
  const ticks: number[] = [];
  for (let t = 0; t <= total + tick; t += tick) ticks.push(t);

  const release = () => {
    window.setTimeout(() => {
      touching.current = false;
    }, 500);
  };

  return (
    <div className="cut-tl" style={{ height }}>
      <div
        className={`cut-scroll${trimming ? ' is-trimming' : ''}`}
        ref={scroller}
        onScroll={onScroll}
        onPointerDown={() => {
          touching.current = true;
        }}
        onPointerUp={release}
        onPointerCancel={release}
        onTouchStart={() => {
          touching.current = true;
        }}
        onTouchEnd={release}
        onWheel={() => {
          touching.current = true;
          release();
        }}
      >
        <div className="cut-inner" style={{ width: total * zoom + width }}>
          <div className="cut-ruler" style={{ height: RULER_H }}>
            {ticks.map((t) => (
              <span key={t} className="cut-tick" style={{ left: pad + t * zoom }}>
                {tickLabel(t, tick)}
              </span>
            ))}
            {ticks.map((t) => (
              <span
                key={`m${t}`}
                className="cut-tick-mid"
                style={{ left: pad + (t + tick / 2) * zoom }}
              />
            ))}
          </div>
          <div className="cut-lane" style={{ height: laneHeight }}>
            {segs.map((s) => (
              <ClipBlock
                key={s.clipId}
                seg={s}
                left={pad + s.start * zoom}
                width={(s.end - s.start) * zoom}
                laneHeight={laneHeight}
                zoom={zoom}
                selected={s.clipId === selected}
                onSelect={onSelect}
                onTrimStart={onTrimStart}
                onTrimMove={onTrimMove}
                onTrimEnd={onTrimEnd}
              />
            ))}
          </div>
        </div>
      </div>
      <div className="cut-playhead" />
    </div>
  );
}

/**
 * Load strip images a few at a time. The browser allows only ~6 connections to
 * the NAS; if hundreds of strips queue up, the video stream waits behind them.
 */
const STRIP_SLOTS = 2;
const STRIP_FRAMES = 12;
let stripsInFlight = 0;
const stripQueue: (() => void)[] = [];
/** Loaded strips → aspect ratio (width / height) of one frame in them. */
const loadedStrips = new Map<string, number>();

function loadStrip(url: string): Promise<void> {
  if (loadedStrips.has(url)) return Promise.resolve();
  return new Promise((done) => {
    const start = () => {
      stripsInFlight++;
      const img = new Image();
      img.onload = img.onerror = () => {
        stripsInFlight--;
        const aspect =
          img.naturalHeight > 0 ? img.naturalWidth / STRIP_FRAMES / img.naturalHeight : 16 / 9;
        loadedStrips.set(url, aspect);
        stripQueue.shift()?.();
        done();
      };
      img.src = url;
    };
    if (stripsInFlight < STRIP_SLOTS) start();
    else stripQueue.push(start);
  });
}

function useStrip(mediaId: string): { url: string; aspect: number } | null {
  const url = `/api/media/strip?mediaId=${encodeURIComponent(mediaId)}`;
  const [aspect, setAspect] = useState(() => loadedStrips.get(url) ?? null);
  useEffect(() => {
    let alive = true;
    void loadStrip(url).then(() => alive && setAspect(loadedStrips.get(url) ?? 16 / 9));
    return () => {
      alive = false;
    };
  }, [url]);
  return aspect === null ? null : { url, aspect };
}

/**
 * A clip on the timeline: whole frames at their true shape, as many as fit,
 * each cropped to its slot. Selected, it gets InShot's yellow frame with
 * chevron handles on each end to drag-trim.
 */
const ClipBlock = memo(function ClipBlock({
  seg,
  left,
  width,
  laneHeight,
  zoom,
  selected,
  onSelect,
  onTrimStart,
  onTrimMove,
  onTrimEnd,
}: {
  seg: Segment;
  left: number;
  width: number;
  laneHeight: number;
  zoom: number;
  selected: boolean;
  onSelect: (id: string | null) => void;
  onTrimStart: (clipId: string) => void;
  onTrimMove: (clipId: string, edge: 'in' | 'out', deltaSec: number) => void;
  onTrimEnd: () => void;
}) {
  const strip = useStrip(seg.mediaId);
  const w = Math.max(2, width - 2);
  const frameW = laneHeight * (strip?.aspect ?? 16 / 9);
  const slots = Math.max(1, Math.min(STRIP_FRAMES, Math.round(w / frameW)));
  const slotW = w / slots;
  const tiles: { key: number; style: CSSProperties }[] = [];
  if (strip && w > 4) {
    for (let i = 0; i < slots; i++) {
      const frame = Math.min(STRIP_FRAMES - 1, Math.floor(((i + 0.5) / slots) * STRIP_FRAMES));
      tiles.push({
        key: i,
        style: {
          width: slotW,
          backgroundImage: `url("${strip.url}")`,
          backgroundSize: `${frameW * STRIP_FRAMES}px ${laneHeight}px`,
          backgroundPositionX: -(frame * frameW) + (slotW - frameW) / 2,
        },
      });
    }
  }

  const handle = (edge: 'in' | 'out') => (e: ReactPointerEvent<HTMLSpanElement>) => {
    e.stopPropagation();
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    onTrimStart(seg.clipId);
    const move = (ev: PointerEvent) => onTrimMove(seg.clipId, edge, (ev.clientX - x0) / zoom);
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      onTrimEnd();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };

  const dur = seg.end - seg.start;
  return (
    <div className={`cut-clip${selected ? ' is-selected' : ''}`} style={{ left, width: w }}>
      <button
        type="button"
        className="cut-clip-body"
        aria-label={`Clip, ${dur.toFixed(1)} seconds`}
        aria-pressed={selected}
        onClick={(e) => {
          e.stopPropagation();
          onSelect(selected ? null : seg.clipId);
        }}
      >
        {tiles.map((t) => (
          <span key={t.key} className="cut-frame" style={t.style} />
        ))}
      </button>
      {selected ? (
        <>
          <span className="cut-handle cut-handle-in" onPointerDown={handle('in')}>
            <ChevronLeft size={18} strokeWidth={3} aria-hidden />
          </span>
          <span className="cut-handle cut-handle-out" onPointerDown={handle('out')}>
            <ChevronRight size={18} strokeWidth={3} aria-hidden />
          </span>
          <span className="cut-clip-dur">{dur.toFixed(1)}s</span>
        </>
      ) : null}
    </div>
  );
});
