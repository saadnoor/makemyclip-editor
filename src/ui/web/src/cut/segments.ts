import type { Composition, MediaClip, Track } from '../types.js';

/** One media clip as the player sees it: where it sits on the timeline and in its source. */
export interface Segment {
  clipId: string;
  mediaId: string;
  start: number;
  end: number;
  srcIn: number;
  srcOut: number;
  speed: number;
}

function speedOf(clip: MediaClip): number {
  let f = 1;
  for (const e of clip.effects ?? []) {
    const fx = e as { type?: string; factor?: number };
    if (fx.type === 'speed' && typeof fx.factor === 'number') f *= fx.factor;
  }
  return f;
}

/** The track the Cut screen edits: the first video track. */
export function mainTrack(comp: Composition): Track | undefined {
  return comp.tracks.find((t) => t.kind === 'video');
}

export function segmentsOf(comp: Composition): Segment[] {
  const track = mainTrack(comp);
  if (!track) return [];
  return track.clips
    .filter((c): c is MediaClip => c.kind === 'media')
    .map((c) => {
      const speed = speedOf(c);
      return {
        clipId: c.id,
        mediaId: c.mediaId,
        start: c.startSec,
        end: c.startSec + (c.sourceOutSec - c.sourceInSec) / speed,
        srcIn: c.sourceInSec,
        srcOut: c.sourceOutSec,
        speed,
      };
    })
    .sort((a, b) => a.start - b.start);
}

export function durationOf(segs: Segment[]): number {
  return segs.reduce((m, s) => Math.max(m, s.end), 0);
}

/** The segment playing at timeline time `t` (end-exclusive), if any. */
export function segmentAt(segs: Segment[], t: number): Segment | undefined {
  return segs.find((s) => t >= s.start && t < s.end);
}

export function nextSegment(segs: Segment[], after: Segment): Segment | undefined {
  return segs.find((s) => s.start >= after.end - 1e-3);
}

/** Source time inside `seg` for timeline time `t`. */
export function sourceTime(seg: Segment, t: number): number {
  return seg.srcIn + (t - seg.start) * seg.speed;
}

/** Timeline time for source time `src` inside `seg`. */
export function timelineTime(seg: Segment, src: number): number {
  return seg.start + (src - seg.srcIn) / seg.speed;
}

/** Every clip boundary, for jumping edit to edit. */
export function editPoints(segs: Segment[]): number[] {
  const pts = new Set<number>([0]);
  for (const s of segs) {
    pts.add(s.start);
    pts.add(s.end);
  }
  return [...pts].sort((a, b) => a - b);
}

export function mediaUrl(mediaId: string): string {
  return `/api/media/stream?mediaId=${encodeURIComponent(mediaId)}`;
}
