import { usePinch } from '@use-gesture/react';
import {
  type CSSProperties,
  memo,
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

function fmt(t: number): string {
  const s = Math.max(0, t);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/** A tick spacing that leaves ~120px between labels at this zoom. */
function tickStep(pps: number): number {
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  return steps.find((s) => s * pps >= 120) ?? 3600;
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

/**
 * The Cut screen: watch a month and cut it, Final Cut for iPad style. A fixed
 * playhead in the middle with the timeline scrolling under it, pinch to zoom,
 * tap a clip to select it, Blade and Delete. Delete is magnetic: later clips
 * slide left to close the gap.
 */
export function CutApp() {
  const [months, setMonths] = useState<string[]>([]);
  const [timeline, setTimeline] = useState<string | null>(() =>
    new URLSearchParams(location.search).get('t'),
  );
  const [doc, setDoc] = useState<Composition | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [tlHeight, setTlHeight] = useState<number>(() => {
    try {
      return Number(localStorage.getItem('cut.tlHeight')) || 170;
    } catch {
      return 170;
    }
  });
  const viewerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch('/api/timelines')
      .then((r) => r.json() as Promise<{ timelines?: { id: string }[] } | { id: string }[]>)
      .then((json) => {
        const list = Array.isArray(json) ? json : (json.timelines ?? []);
        const ids = list
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
          // Keep the same object while nothing changed, so nothing re-renders.
          if (alive) setDoc((prev) => (prev && prev.rev === d.rev ? prev : d));
        })
        .catch((e: unknown) => alive && setError(String(e)));
    void load();
    const timer = window.setInterval(load, POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [timeline]);

  const segs = useMemo(() => (doc ? segmentsOf(doc) : []), [doc]);
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

  const history_ = useCallback(
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

  const blade = useCallback(() => {
    const seg = segmentAt(segs, player.time);
    if (!seg) return;
    // A cut within a frame of an edge would leave a sliver clip.
    if (player.time - seg.start < 1 / fps || seg.end - player.time < 1 / fps) return;
    void apply([{ verb: 'split', clipId: seg.clipId, atSec: player.time }]);
  }, [apply, fps, player.time, segs]);

  const remove = useCallback(() => {
    const target =
      segs.find((s) => s.clipId === selected) ?? segmentAt(segs, player.time) ?? undefined;
    if (!target) return;
    const gap = target.end - target.start;
    const later = segs.filter((s) => s.start >= target.end - 1e-3);
    const verbs: Verb[] = [
      { verb: 'remove', clipId: target.clipId },
      ...later.map((s): Verb => ({ verb: 'move', clipId: s.clipId, startSec: s.start - gap })),
    ];
    setSelected(null);
    void apply(verbs);
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

  // Keyboard, for the Mac (and an iPad keyboard).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
      const mod = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (mod && k === 'z') {
        e.preventDefault();
        void history_(e.shiftKey ? 'redo' : 'undo');
      } else if (k === ' ' || k === 'k') {
        e.preventDefault();
        if (k === 'k') player.pause();
        else player.toggle();
      } else if (k === 'l') player.play();
      else if (k === 'j') player.seek(player.time - 5);
      else if (k === 'b') blade();
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
  }, [blade, fps, history_, jumpEdit, player, remove]);

  const cur = segmentAt(segs, player.time);

  return (
    <div className="cut">
      <header className="cut-top">
        <select
          className="cut-month"
          value={timeline ?? ''}
          onChange={(e) => {
            player.pause();
            setDoc(null);
            setSelected(null);
            setTimeline(e.target.value);
          }}
        >
          {months.length === 0 ? <option value="">No months yet</option> : null}
          {months.map((m) => (
            <option key={m} value={m}>
              {monthLabel(m)}
            </option>
          ))}
        </select>
        <span className="cut-clock">
          {fmt(player.time)} <span className="cut-dim">/ {fmt(player.duration)}</span>
        </span>
        <span className="cut-dim cut-count">{segs.length} clips</span>
        {busy ? <span className="cut-dim">Saving…</span> : null}
        {error ? (
          <button type="button" className="cut-error" onClick={() => setError(null)}>
            {error} ✕
          </button>
        ) : null}
      </header>

      {/* Tapping the picture toggles playback; the Play button is the accessible control. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: duplicate of the Play button. */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: Space is handled globally. */}
      <div className="cut-viewer" ref={viewerRef} onClick={player.toggle}>
        <button
          type="button"
          className="cut-fs"
          title="Fullscreen"
          onClick={(e) => {
            e.stopPropagation();
            const box = viewerRef.current;
            const vid = player.videoRefs[player.active].current as
              | (HTMLVideoElement & { webkitEnterFullscreen?: () => void })
              | null;
            if (document.fullscreenElement) void document.exitFullscreen();
            else if (box?.requestFullscreen) void box.requestFullscreen();
            else vid?.webkitEnterFullscreen?.();
          }}
        >
          ⛶
        </button>
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
        {doc && segs.length === 0 ? <div className="cut-msg">This month has no clips.</div> : null}
        {cur ? <div className="cut-clipname">{cur.clipId}</div> : null}
      </div>

      <div className="cut-tools">
        <button type="button" onClick={() => void history_('undo')} title="Undo (⌘Z)">
          ↶
        </button>
        <button type="button" onClick={() => void history_('redo')} title="Redo (⇧⌘Z)">
          ↷
        </button>
        <span className="cut-spacer" />
        <button type="button" onClick={() => jumpEdit(-1)} title="Previous edit (↑)">
          ⏮
        </button>
        <button
          type="button"
          onClick={() => player.seek(player.time - 1 / fps)}
          title="Back 1 frame (←)"
        >
          ◀︎
        </button>
        <button
          type="button"
          className="cut-play"
          onClick={player.toggle}
          title="Play/Pause (Space)"
        >
          {player.playing ? '❚❚' : '▶︎'}
        </button>
        <button
          type="button"
          onClick={() => player.seek(player.time + 1 / fps)}
          title="Forward 1 frame (→)"
        >
          ▶︎
        </button>
        <button type="button" onClick={() => jumpEdit(1)} title="Next edit (↓)">
          ⏭
        </button>
        <span className="cut-spacer" />
        <button
          type="button"
          className="cut-blade"
          onClick={blade}
          disabled={busy}
          title="Blade at playhead (B)"
        >
          ✂︎ Blade
        </button>
        <button
          type="button"
          className="cut-delete"
          onClick={remove}
          disabled={busy}
          title="Delete (⌫)"
        >
          🗑 Delete
        </button>
      </div>

      {/* biome-ignore lint/a11y/useSemanticElements: <hr> can't hold a drag handle. */}
      <div
        className="cut-split"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Drag to resize the timeline"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          const startY = e.clientY;
          const startH = tlHeight;
          const move = (ev: PointerEvent) => {
            const h = Math.min(
              window.innerHeight - 160,
              Math.max(90, startH + startY - ev.clientY),
            );
            setTlHeight(h);
          };
          const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            setTlHeight((h) => {
              try {
                localStorage.setItem('cut.tlHeight', String(h));
              } catch {
                // Private mode: the size just isn't remembered.
              }
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
        segs={segs}
        time={player.time}
        playing={player.playing}
        selected={selected}
        onSelect={setSelected}
        onScrub={(t) => {
          if (player.playing) player.pause();
          player.seek(t);
        }}
      />
    </div>
  );
}

function Timeline({
  height,
  segs,
  time,
  playing,
  selected,
  onSelect,
  onScrub,
}: {
  height: number;
  segs: Segment[];
  time: number;
  playing: boolean;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onScrub: (t: number) => void;
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

  // Start where clips are readable: about 3 minutes across the screen.
  useEffect(() => {
    if (pps === null && total > 0) setPps(Math.max(MIN_PPS, width / 180));
  }, [pps, total, width]);
  const zoom = pps ?? 1;
  const pad = width / 2;
  // Lane height in px: the timeline minus the ruler (34) and the lane's top margin (4).
  const laneHeight = Math.max(20, height - 46);

  // Keep the playhead under the fixed centre line.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || touching.current) return;
    const target = time * zoom;
    if (Math.abs(el.scrollLeft - target) > 0.5) {
      programmatic.current = true;
      el.scrollLeft = target;
    }
  }, [time, zoom]);

  usePinch(
    ({ offset: [scale] }) => {
      setPps(Math.min(MAX_PPS, Math.max(MIN_PPS, scale)));
    },
    {
      target: scroller,
      scaleBounds: { min: MIN_PPS, max: MAX_PPS },
      from: () => [zoom, 0],
      eventOptions: { passive: false },
      pinchOnWheel: true,
    },
  );

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    if (programmatic.current) {
      programmatic.current = false;
      return;
    }
    if (playing && !touching.current) return;
    onScrub(el.scrollLeft / zoom);
  };

  const step = tickStep(zoom);
  const ticks: number[] = [];
  for (let t = 0; t <= total + step; t += step) ticks.push(t);

  return (
    <div className="cut-tl" style={{ height }}>
      <div className="cut-zoom">
        <input
          type="range"
          className="cut-zoom-slider"
          aria-label="Timeline zoom"
          min={Math.log(MIN_PPS)}
          max={Math.log(MAX_PPS)}
          step={0.01}
          value={Math.log(zoom)}
          onChange={(e) => setPps(Math.exp(Number(e.target.value)))}
        />
        <button type="button" onClick={() => setPps(Math.max(MIN_PPS, zoom / 2))} title="Zoom out">
          −
        </button>
        <button
          type="button"
          onClick={() => setPps(Math.max(MIN_PPS, (width * 0.9) / Math.max(total, 1)))}
          title="Fit"
        >
          ⤢
        </button>
        <button type="button" onClick={() => setPps(Math.min(MAX_PPS, zoom * 2))} title="Zoom in">
          +
        </button>
      </div>
      <div
        className="cut-scroll"
        ref={scroller}
        onScroll={onScroll}
        onPointerDown={() => {
          touching.current = true;
        }}
        onPointerUp={() => {
          touching.current = false;
        }}
        onPointerCancel={() => {
          touching.current = false;
        }}
        onWheel={() => {
          touching.current = true;
          window.setTimeout(() => {
            touching.current = false;
          }, 150);
        }}
        onTouchStart={() => {
          touching.current = true;
        }}
        onTouchEnd={() => {
          // Momentum scrolling keeps going after the finger lifts.
          window.setTimeout(() => {
            touching.current = false;
          }, 600);
        }}
      >
        <div className="cut-inner" style={{ width: total * zoom + width }}>
          <div className="cut-ruler">
            {ticks.map((t) => (
              <span key={t} className="cut-tick" style={{ left: pad + t * zoom }}>
                {fmt(t)}
              </span>
            ))}
          </div>
          <div className="cut-lane">
            {segs.map((s) => (
              <ClipBlock
                key={s.clipId}
                seg={s}
                left={pad + s.start * zoom}
                width={(s.end - s.start) * zoom}
                laneHeight={laneHeight}
                selected={s.clipId === selected}
                onSelect={onSelect}
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
let stripsInFlight = 0;
const stripQueue: (() => void)[] = [];
/** Loaded strips → aspect ratio (width / height) of one frame in them. */
const loadedStrips = new Map<string, number>();
const STRIP_FRAMES = 12;

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
 * A clip on the timeline, Final Cut style: whole frames at their true shape,
 * as many as fit side by side, each cropped to its slot rather than squashed.
 * A narrow clip shows one frame from its middle.
 */
const ClipBlock = memo(function ClipBlock({
  seg,
  left,
  width,
  laneHeight,
  selected,
  onSelect,
}: {
  seg: Segment;
  left: number;
  width: number;
  laneHeight: number;
  selected: boolean;
  onSelect: (id: string | null) => void;
}) {
  const strip = useStrip(seg.mediaId);
  const w = Math.max(2, width - 1);
  const frameW = laneHeight * (strip?.aspect ?? 16 / 9);
  const slots = Math.max(1, Math.min(STRIP_FRAMES, Math.round(w / frameW)));
  const slotW = w / slots;
  const tiles: { key: number; style: CSSProperties }[] = [];
  if (strip && w > 4) {
    for (let i = 0; i < slots; i++) {
      const frame = Math.min(
        STRIP_FRAMES - 1,
        Math.floor(((i + 0.5) / slots) * STRIP_FRAMES),
      );
      tiles.push({
        key: i,
        style: {
          width: slotW,
          backgroundImage: `url("${strip.url}")`,
          backgroundSize: `${frameW * STRIP_FRAMES}px ${laneHeight}px`,
          // Centre the chosen frame in its slot; the slot crops the rest.
          backgroundPositionX: -(frame * frameW) + (slotW - frameW) / 2,
        },
      });
    }
  }
  return (
    <button
      type="button"
      className={`cut-clip${selected ? ' is-selected' : ''}`}
      style={{ left, width: w }}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(selected ? null : seg.clipId);
      }}
    >
      {tiles.map((t) => (
        <span key={t.key} className="cut-frame" style={t.style} />
      ))}
    </button>
  );
});
