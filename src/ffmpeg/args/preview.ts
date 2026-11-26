export interface PreviewFrameArgs {
  input: string;
  output: string;
  /** Timecode (in seconds) to extract the frame from. */
  atSec: number;
}

export function buildPreviewFrameArgs({ input, output, atSec }: PreviewFrameArgs): string[] {
  // `-ss` BEFORE `-i` is the fast (input-seek) form — ffmpeg seeks to the
  // nearest keyframe before reading any packets. Accuracy is keyframe-level
  // (sub-second to a few seconds depending on the source), but for a preview
  // thumbnail that's fine and ~100x faster than the accurate output-seek form.
  //
  // -q:v 2 is high-quality JPEG (range 1-31, lower is better; 2 is a
  // common sweet-spot used by many tools).
  // -an skips audio decoding — irrelevant for a still frame.
  return ['-y', '-ss', String(atSec), '-i', input, '-vframes', '1', '-q:v', '2', '-an', output];
}

export interface ThumbnailArgs {
  input: string;
  output: string;
  /** Source timecode (seconds) to grab the thumbnail from. */
  atSec: number;
  /** Target height in px; width follows the source aspect (even, for yuv420p). */
  height: number;
}

/**
 * A small, scaled still for the timeline filmstrip. Same fast input-seek as the
 * preview frame, but scaled down (`-2` keeps the aspect with an even width) and
 * a slightly cheaper JPEG — these are tiny and there are many per clip.
 */
export function buildThumbnailArgs({ input, output, atSec, height }: ThumbnailArgs): string[] {
  return [
    '-y',
    '-ss',
    String(atSec),
    '-i',
    input,
    '-vframes',
    '1',
    '-vf',
    `scale=-2:${height}`,
    '-q:v',
    '4',
    '-an',
    output,
  ];
}

export interface FilmstripArgs {
  input: string;
  output: string;
  durationSec: number;
  frames: number;
  height: number;
}

/**
 * One JPEG of `frames` stills spread evenly across the source, side by side: a
 * clip's whole filmstrip in a single small file. Decodes keyframes only, which
 * is plenty for a strip and many times faster than a full decode.
 */
export function buildFilmstripArgs({
  input,
  output,
  durationSec,
  frames,
  height,
}: FilmstripArgs): string[] {
  const rate = frames / Math.max(durationSec, 0.1);
  return [
    '-y',
    '-skip_frame',
    'nokey',
    '-i',
    input,
    '-vf',
    `fps=${rate.toFixed(6)},scale=-2:${height},tile=${frames}x1`,
    '-frames:v',
    '1',
    '-q:v',
    '5',
    '-an',
    output,
  ];
}
