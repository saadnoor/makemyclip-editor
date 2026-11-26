import { useCallback, useEffect, useRef, useState } from 'react';
import {
  durationOf,
  mediaUrl,
  nextSegment,
  type Segment,
  segmentAt,
  sourceTime,
  timelineTime,
} from './segments.js';

/** Within this many seconds of a clip's out point, hand over to the next clip. */
const END_SLACK = 0.04;

export interface Player {
  /** Attach to the two stacked <video> elements. */
  videoRefs: [React.RefObject<HTMLVideoElement | null>, React.RefObject<HTMLVideoElement | null>];
  /** Which of the two is on screen (the other preloads the next clip). */
  active: 0 | 1;
  /** True when the playhead is in a gap or past the end: show black. */
  blank: boolean;
  time: number;
  playing: boolean;
  duration: number;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  seek: (t: number) => void;
}

function setSourceTime(el: HTMLVideoElement, t: number): void {
  if (el.readyState >= 1) {
    el.currentTime = t;
  } else {
    el.addEventListener(
      'loadedmetadata',
      () => {
        el.currentTime = t;
      },
      { once: true },
    );
  }
}

/** Point `el` at `seg`, cued to source time `src` (default: the clip's in point). */
function cue(el: HTMLVideoElement, seg: Segment, src = seg.srcIn): void {
  if (el.dataset.mediaId !== seg.mediaId) {
    el.dataset.mediaId = seg.mediaId;
    el.src = mediaUrl(seg.mediaId);
    el.load();
  }
  el.dataset.clipId = seg.clipId;
  el.playbackRate = seg.speed;
  setSourceTime(el, src);
}

/**
 * Plays a cut list of clips back to back with two <video> elements: one on screen,
 * one cued to the next clip so the hand-over has no load gap. The timeline is the
 * clock while a clip plays (read from the video's currentTime); gaps run on the
 * wall clock.
 */
export function usePlayer(segs: Segment[]): Player {
  const a = useRef<HTMLVideoElement | null>(null);
  const b = useRef<HTMLVideoElement | null>(null);
  const [active, setActive] = useState<0 | 1>(0);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [blank, setBlank] = useState(true);

  const segsRef = useRef(segs);
  segsRef.current = segs;
  const activeRef = useRef<0 | 1>(0);
  const timeRef = useRef(0);
  const playingRef = useRef(false);
  const curRef = useRef<Segment | undefined>(undefined);
  const unlocked = useRef(false);
  const raf = useRef(0);
  const lastTick = useRef(0);

  const els = useCallback((): [HTMLVideoElement | null, HTMLVideoElement | null] => {
    const pair: [HTMLVideoElement | null, HTMLVideoElement | null] = [a.current, b.current];
    return activeRef.current === 0 ? pair : [pair[1], pair[0]];
  }, []);

  const swap = useCallback(() => {
    activeRef.current = activeRef.current === 0 ? 1 : 0;
    setActive(activeRef.current);
  }, []);

  const preloadAfter = useCallback(
    (seg: Segment) => {
      const [, idle] = els();
      const nxt = nextSegment(segsRef.current, seg);
      if (idle && nxt && idle.dataset.clipId !== nxt.clipId) cue(idle, nxt);
    },
    [els],
  );

  const enter = useCallback(
    (seg: Segment | undefined, t: number) => {
      curRef.current = seg;
      setBlank(!seg);
      if (!seg) return;
      const [on] = els();
      if (!on) return;
      cue(on, seg, sourceTime(seg, t));
      if (playingRef.current) void on.play().catch(() => undefined);
      preloadAfter(seg);
    },
    [els, preloadAfter],
  );

  const seek = useCallback(
    (t: number) => {
      const clamped = Math.max(0, Math.min(t, durationOf(segsRef.current)));
      timeRef.current = clamped;
      setTime(clamped);
      const seg = segmentAt(segsRef.current, clamped);
      const [on] = els();
      if (playingRef.current && on && seg?.clipId !== curRef.current?.clipId) on.pause();
      enter(seg, clamped);
    },
    [els, enter],
  );

  const stop = useCallback(() => {
    playingRef.current = false;
    setPlaying(false);
    cancelAnimationFrame(raf.current);
    for (const el of [a.current, b.current]) el?.pause();
  }, []);

  const tick = useCallback(
    (now: number) => {
      if (!playingRef.current) return;
      const dt = (now - lastTick.current) / 1000;
      lastTick.current = now;
      const segs = segsRef.current;
      const cur = curRef.current;
      const [on, idle] = els();

      if (cur && on) {
        const src = on.currentTime;
        timeRef.current = timelineTime(cur, Math.max(src, cur.srcIn));
        if (src >= cur.srcOut - END_SLACK || on.ended) {
          const nxt = nextSegment(segs, cur);
          if (!nxt) {
            timeRef.current = cur.end;
            setTime(cur.end);
            stop();
            return;
          }
          on.pause();
          if (nxt.start > cur.end + 1e-3) {
            // A gap: hold black and let the wall clock carry the playhead.
            timeRef.current = cur.end;
            curRef.current = undefined;
            setBlank(true);
          } else if (idle) {
            if (idle.dataset.clipId !== nxt.clipId) cue(idle, nxt);
            idle.playbackRate = nxt.speed;
            void idle.play().catch(() => undefined);
            swap();
            curRef.current = nxt;
            timeRef.current = nxt.start;
            setBlank(false);
            preloadAfter(nxt);
          }
        }
      } else {
        const t = timeRef.current + dt;
        const ahead = segs.find((s) => s.start >= timeRef.current - 1e-3);
        if (!ahead) {
          stop();
          return;
        }
        if (t >= ahead.start) {
          timeRef.current = ahead.start;
          enter(ahead, ahead.start);
        } else {
          timeRef.current = t;
        }
      }
      setTime(timeRef.current);
      raf.current = requestAnimationFrame(tick);
    },
    [els, enter, preloadAfter, stop, swap],
  );

  const play = useCallback(() => {
    // iOS only lets a page start unmuted media from a user gesture, per element:
    // prime both elements inside this tap so the off-screen one can take over later.
    if (!unlocked.current) {
      unlocked.current = true;
      for (const el of [a.current, b.current]) {
        if (el && el !== els()[0] && el.src) {
          void el
            .play()
            .then(() => el.pause())
            .catch(() => undefined);
        }
      }
    }
    if (timeRef.current >= durationOf(segsRef.current) - 0.05) timeRef.current = 0;
    playingRef.current = true;
    setPlaying(true);
    enter(segmentAt(segsRef.current, timeRef.current), timeRef.current);
    lastTick.current = performance.now();
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(tick);
  }, [els, enter, tick]);

  const toggle = useCallback(() => {
    if (playingRef.current) stop();
    else play();
  }, [play, stop]);

  // An edit changes the cut list: re-cue at the same timeline time.
  const segKey = segs.map((s) => `${s.clipId}:${s.start}:${s.srcIn}:${s.srcOut}`).join('|');
  // biome-ignore lint/correctness/useExhaustiveDependencies: segKey is the change signal.
  useEffect(() => {
    seek(timeRef.current);
  }, [segKey, seek]);

  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  return {
    videoRefs: [a, b],
    active,
    blank,
    time,
    playing,
    duration: durationOf(segs),
    play,
    pause: stop,
    toggle,
    seek,
  };
}
