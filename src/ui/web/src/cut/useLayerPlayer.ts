import { type RefObject, useEffect, useRef, useState } from 'react';
import { mediaUrl, type Segment, segmentAt, sourceTime } from './segments.js';

/** Re-seek a playing layer only when it drifts this far from the main clock. */
const DRIFT = 0.25;

/**
 * Plays the layer clip (if any) at the main player's time on a muted <video>
 * stacked over the picture: a B-roll cutaway while the main track's sound runs
 * on. The main player is the clock; this follows it.
 */
export function useLayerPlayer(
  layers: Segment[],
  time: number,
  playing: boolean,
): { ref: RefObject<HTMLVideoElement | null>; visible: boolean } {
  const ref = useRef<HTMLVideoElement | null>(null);
  const seg = segmentAt(layers, time);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!seg) {
      if (!el.paused) el.pause();
      return;
    }
    if (el.dataset.mediaId !== seg.mediaId) {
      el.dataset.mediaId = seg.mediaId;
      setReady(false);
      el.src = mediaUrl(seg.mediaId);
      el.load();
    }
    const target = sourceTime(seg, time);
    el.playbackRate = seg.speed;
    const seekIfNeeded = (tolerance: number) => {
      if (Math.abs(el.currentTime - target) > tolerance) el.currentTime = target;
    };
    if (el.readyState >= 1) {
      seekIfNeeded(playing ? DRIFT : 0.04);
    } else {
      el.addEventListener('loadedmetadata', () => seekIfNeeded(0), { once: true });
    }
    if (playing && el.paused) void el.play().catch(() => undefined);
    if (!playing && !el.paused) el.pause();
  }, [seg, time, playing]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onReady = () => setReady(true);
    el.addEventListener('seeked', onReady);
    el.addEventListener('playing', onReady);
    return () => {
      el.removeEventListener('seeked', onReady);
      el.removeEventListener('playing', onReady);
    };
  }, []);

  return { ref, visible: !!seg && ready };
}
