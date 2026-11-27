/**
 * Plan the 4K conform of a timeline cut on proxies.
 *
 *   tsx scripts/conform.ts <timeline>
 *
 * Writes $MAKEMYCLIP_WORKSPACE/<timeline>/render/plan.sh, which run-conform.sh
 * executes (inside an FFmpeg with the right hardware, e.g. the Jellyfin image on
 * the NAS). The timeline is cut into intervals at every clip and title boundary
 * on every track; each interval is rendered ONCE from the original files — main
 * clip scaled to the canvas, the topmost layer clip over it, titles drawn with
 * the workspace's fonts — and the pieces are joined with `-c copy`. A piece's
 * file name is a hash of everything that shapes it, so re-running after an edit
 * re-renders only the intervals that changed.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execa } from 'execa';
import { resolveFfmpeg } from '../src/ffmpeg/run.js';
import type { Clip, Composition, MediaClip, TextClip } from '../src/timeline/composition.js';
import { readComposition } from '../src/timeline/document-store.js';
import { buildMediaRefs } from '../src/timeline/media-registry.js';
import type { MediaId } from '../src/timeline/schema.js';
import { getWorkspace } from '../src/workspace.js';

interface FontFace {
  family: string;
  weight: number;
  italic: boolean;
  file: string;
}

interface Placed<T extends Clip> {
  clip: T;
  start: number;
  end: number;
}

const DEFAULT_FONT = 'EB Garamond';

function speedOf(clip: Clip): number {
  return clip.effects.reduce((f, e) => (e.type === 'speed' ? f * e.factor : f), 1);
}

function place<T extends Clip>(clip: T): Placed<T> {
  const len =
    clip.kind === 'media'
      ? (clip.sourceOutSec - clip.sourceInSec) / speedOf(clip)
      : (clip as TextClip).durationSec;
  return { clip, start: clip.startSec, end: clip.startSec + len };
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const num = (n: number) => n.toFixed(4);

/** The face closest to the wanted weight and slant, within a family. */
function pickFont(faces: FontFace[], family: string, weight: number, italic: boolean): FontFace {
  const pool = faces.filter((f) => f.family === family);
  const same = pool.filter((f) => f.italic === italic);
  const from = same.length ? same : pool.length ? pool : faces;
  const best = [...from].sort(
    (a, b) => Math.abs(a.weight - weight) - Math.abs(b.weight - weight),
  )[0];
  if (!best) throw new Error('No fonts in .fonts/fonts.json.');
  return best;
}

function drawtextFor(
  t: TextClip,
  comp: Composition,
  faces: FontFace[],
  fontsDir: string,
  textFile: string,
): string {
  const st = t.style;
  const face = pickFont(faces, st.fontFamily ?? DEFAULT_FONT, st.fontWeight ?? 400, !!st.italic);
  const margin = Math.round(comp.width * 0.04);
  let x: string;
  let y: string;
  if (t.transform && (t.transform.x !== 0.5 || t.transform.y !== 0.5 || st.anchor === 'center')) {
    x = `${num(t.transform.x)}*w-text_w/2`;
    y = `${num(t.transform.y)}*h-text_h/2`;
  } else {
    const a = st.anchor;
    x = a.endsWith('left')
      ? `${margin}`
      : a.endsWith('right')
        ? `w-text_w-${margin}`
        : '(w-text_w)/2';
    y = a.startsWith('top')
      ? `${margin}`
      : a.startsWith('bottom')
        ? `h-text_h-${margin}`
        : '(h-text_h)/2';
  }
  const parts = [
    `fontfile=${join(fontsDir, face.file)}`,
    `textfile=${textFile}`,
    'expansion=none',
    `fontsize=${st.fontSize}`,
    `fontcolor=${st.color}`,
    `x=${x}`,
    `y=${y}`,
  ];
  if (st.background)
    parts.push(
      'box=1',
      `boxcolor=${st.background}@0.6`,
      `boxborderw=${Math.round(st.fontSize * 0.3)}`,
    );
  return `drawtext=${parts.join(':')}`;
}

interface SourceInfo {
  codec: string;
  pixFmt: string;
  width: number;
  height: number;
}

const infoCache = new Map<string, SourceInfo>();

/** Codec, pixel format and size from the container header (no decode). */
async function sourceInfo(path: string): Promise<SourceInfo> {
  const hit = infoCache.get(path);
  if (hit) return hit;
  const { stderr } = await execa(resolveFfmpeg().path, ['-hide_banner', '-i', path], {
    reject: false,
    env: { ...process.env, LC_ALL: 'C' },
  });
  const line = stderr.split('\n').find((l) => /Stream #\d+:\d+.*Video:/.test(l)) ?? '';
  const codec = line.match(/Video:\s+([a-z0-9_]+)/i)?.[1] ?? '';
  const pixFmt = line.match(/,\s*((?:yuvj?|nv|p0)\w+?)(?:\(|,)/)?.[1] ?? '';
  const dims = line.match(/(\d{2,5})x(\d{2,5})/);
  const info = { codec, pixFmt, width: Number(dims?.[1] ?? 0), height: Number(dims?.[2] ?? 0) };
  if (!info.width) throw new Error(`Could not read the video stream of ${path}.`);
  infoCache.set(path, info);
  return info;
}

/** What Intel QSV on this NAS can decode. */
function gpuDecodable({ codec, pixFmt }: SourceInfo): boolean {
  const p = pixFmt.replace(/\(.*/, '');
  if (codec === 'hevc') return ['yuv420p', 'yuvj420p', 'yuv420p10le'].includes(p);
  if (codec === 'h264') return ['yuv420p', 'yuvj420p'].includes(p);
  return false;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const timeline = args[0];
  if (!timeline) throw new Error('Usage: conform.ts <timeline>');

  const ws = getWorkspace();
  const comp = await readComposition(timeline);
  const refs = await buildMediaRefs();
  const fontsDir = join(ws, '.fonts');
  const faces = (
    JSON.parse(await readFile(join(fontsDir, 'fonts.json'), 'utf8')) as { faces: FontFace[] }
  ).faces;

  // proxy file name → original, from every prepared month (a cut may borrow
  // clips from other months).
  const originals = new Map<string, string>();
  for (const entry of await readdir(ws, { withFileTypes: true })) {
    const path = join(ws, entry.name, 'manifest.tsv');
    if (!entry.isDirectory() || !existsSync(path)) continue;
    for (const line of (await readFile(path, 'utf8')).split('\n').slice(1)) {
      const [proxy, , , original] = line.split('\t');
      if (proxy && original) originals.set(proxy, original);
    }
  }
  const originalOf = (id: MediaId): string => {
    const ref = refs.get(id);
    if (!ref) throw new Error(`No media record for ${id}.`);
    const name = ref.path.split('/').pop() ?? '';
    // Media that isn't a proxy (imported directly) renders from itself.
    return originals.get(name) ?? ref.path;
  };
  const hasAudio = (id: MediaId) => refs.get(id)?.audio != null;

  const videoTracks = comp.tracks.filter((t) => t.kind === 'video');
  const mainTrack = videoTracks[0];
  if (!mainTrack) throw new Error('The timeline has no video track.');
  const mediaOf = (clips: Clip[]) =>
    clips.filter((c): c is MediaClip => c.kind === 'media').map(place);
  const main = mediaOf(mainTrack.clips).sort((a, b) => a.start - b.start);
  // Upper tracks first, so the topmost layer wins where layers overlap.
  const layers = videoTracks
    .slice(1)
    .reverse()
    .flatMap((t) => mediaOf(t.clips));
  const texts = videoTracks.flatMap((t) =>
    t.clips.filter((c): c is TextClip => c.kind === 'text').map(place),
  );
  for (const p of [...main, ...layers]) {
    if (Math.abs(speedOf(p.clip) - 1) > 1e-6) {
      throw new Error(
        `Clip ${p.clip.id} has a speed change; the conform doesn't support speed yet.`,
      );
    }
  }

  const fps = comp.fps;
  const W = comp.width;
  const H = comp.height;
  const frame = (t: number) => Math.round(t * fps);
  const total = Math.max(0, ...[...main, ...layers, ...texts].map((p) => p.end));
  const cuts = new Set<number>([0, frame(total)]);
  for (const p of [...main, ...layers, ...texts]) {
    cuts.add(Math.max(0, frame(p.start)));
    cuts.add(Math.min(frame(total), frame(p.end)));
  }
  const edges = [...cuts].sort((a, b) => a - b);

  const outDir = join(ws, timeline, 'render');
  const segDir = join(outDir, 'segments');
  const textDir = join(outDir, 'text');
  await mkdir(segDir, { recursive: true });
  await mkdir(textDir, { recursive: true });

  const lines: string[] = [
    '#!/usr/bin/env bash',
    `# Generated by conform.ts for timeline ${timeline}. Needs VENC (encoder args) and FFMPEG.`,
    'set -euo pipefail',
    ': "${FFMPEG:=ffmpeg}"',
    ': "${VENC:=-c:v libx265 -preset medium -crf 18 -pix_fmt yuv420p10le -tag:v hvc1}"',
    `cd ${q(segDir)}`,
    'n=0',
  ];
  const list: string[] = [];
  let count = 0;

  for (let i = 0; i < edges.length - 1; i++) {
    const f0 = edges[i] as number;
    const f1 = edges[i + 1] as number;
    const frames = f1 - f0;
    if (frames <= 0) continue;
    const a = f0 / fps;
    const dur = frames / fps;
    const mid = (f0 + f1) / 2 / fps;
    const at = <T extends Clip>(ps: Placed<T>[]) => ps.find((p) => mid >= p.start && mid < p.end);
    const m = at(main);
    const l = at(layers);
    const ts = texts.filter((p) => mid >= p.start && mid < p.end);

    const inputs: string[] = [];
    const graph: string[] = [];
    const composing = !!l || ts.length > 0;
    const sixteenNine = (info: SourceInfo) => Math.abs(info.width / info.height - W / H) < 0.01;
    const qsvIn = (path: string, src: number) =>
      `-hwaccel qsv -hwaccel_output_format qsv -ss ${num(src)} -t ${num(dur + 0.5)} -i ${q(path)}`;
    const cpuIn = (path: string, src: number) =>
      `-ss ${num(src)} -t ${num(dur + 0.5)} -i ${q(path)}`;
    let gpuOnly = false;
    if (m) {
      const path = originalOf(m.clip.mediaId);
      const info = await sourceInfo(path);
      const src = m.clip.sourceInSec + (a - m.start);
      if (gpuDecodable(info) && sixteenNine(info)) {
        inputs.push(qsvIn(path, src));
        if (composing) {
          graph.push(
            `[0:v]vpp_qsv=w=${W}:h=${H}:format=p010:framerate=${fps},hwdownload,format=p010le,format=yuv420p10le[base]`,
          );
        } else {
          // Decode, scale and encode all stay on the GPU.
          graph.push(`[0:v]vpp_qsv=w=${W}:h=${H}:format=p010:framerate=${fps}[base]`);
          gpuOnly = true;
        }
      } else if (gpuDecodable(info)) {
        // Another shape: GPU decode + scale to fit, pad on the CPU.
        const fitW = Math.min(W, Math.round((H * (info.width / info.height)) / 2) * 2);
        const fitH = Math.min(H, Math.round(W / (info.width / info.height) / 2) * 2);
        inputs.push(qsvIn(path, src));
        graph.push(
          `[0:v]vpp_qsv=w=${fitW}:h=${fitH}:format=p010:framerate=${fps},hwdownload,format=p010le,format=yuv420p10le,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black,setsar=1[base]`,
        );
      } else {
        // No hardware decoder (e.g. Sony H.264 4:2:2 10-bit): all on the CPU.
        inputs.push(cpuIn(path, src));
        graph.push(
          `[0:v]scale=${W}:${H}:force_original_aspect_ratio=decrease:flags=bicubic,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=${fps},format=yuv420p10le[base]`,
        );
      }
    } else {
      graph.push(`color=black:s=${W}x${H}:r=${fps}:d=${num(dur)},format=yuv420p10le[base]`);
    }
    let v = 'base';
    if (l) {
      const idx = inputs.length;
      const path = originalOf(l.clip.mediaId);
      const info = await sourceInfo(path);
      const src = l.clip.sourceInSec + (a - l.start);
      const tf = l.clip.transform;
      const scale = tf?.scale ?? 1;
      const lw = scale < 0.999 ? Math.round((W * scale) / 2) * 2 : W;
      const lh = scale < 0.999 ? Math.round((H * scale) / 2) * 2 : H;
      if (gpuDecodable(info) && sixteenNine(info)) {
        inputs.push(qsvIn(path, src));
        graph.push(
          `[${idx}:v]vpp_qsv=w=${lw}:h=${lh}:format=p010:framerate=${fps},hwdownload,format=p010le,format=yuv420p10le[lay]`,
        );
      } else {
        inputs.push(cpuIn(path, src));
        graph.push(
          `[${idx}:v]scale=${lw}:${lh}:force_original_aspect_ratio=increase:flags=bicubic,crop=${lw}:${lh},setsar=1,fps=${fps},format=yuv420p10le[lay]`,
        );
      }
      const x = scale < 0.999 ? `${num(tf?.x ?? 0.5)}*W-w/2` : '0';
      const y = scale < 0.999 ? `${num(tf?.y ?? 0.5)}*H-h/2` : '0';
      graph.push(`[${v}][lay]overlay=x=${x}:y=${y}:eof_action=repeat[v1]`);
      v = 'v1';
    }
    if (ts.length) {
      const draws: string[] = [];
      for (const t of ts) {
        const tf = join(textDir, `${t.clip.id}.txt`);
        await writeFile(tf, t.clip.text);
        draws.push(drawtextFor(t.clip, comp, faces, fontsDir, tf));
      }
      graph.push(`[${v}]${draws.join(',')}[v2]`);
      v = 'v2';
    }
    graph.push(
      gpuOnly
        ? `[${v}]trim=end_frame=${frames},setpts=PTS-STARTPTS[vout]`
        : `[${v}]trim=end_frame=${frames},setpts=PTS-STARTPTS,format=p010le[vout]`,
    );
    if (m && hasAudio(m.clip.mediaId)) {
      graph.push(
        `[0:a]aresample=48000,aformat=channel_layouts=stereo,apad,atrim=0:${num(dur)},asetpts=PTS-STARTPTS[aout]`,
      );
    } else {
      graph.push(`anullsrc=r=48000:cl=stereo,atrim=0:${num(dur)}[aout]`);
    }

    const spec = JSON.stringify({
      inputs,
      graph,
      frames,
      W,
      H,
      fps,
      texts: ts.map((t) => t.clip.text),
    });
    const name = `seg-${createHash('sha1').update(spec).digest('hex').slice(0, 16)}.mp4`;
    list.push(`file '${name}'`);
    count++;
    lines.push(
      `n=$((n+1)); if [ ! -s ${name} ]; then echo "[$n/${'$TOTAL'}] ${num(a)}s +${num(dur)}s"; $FFMPEG -nostdin -v error -y ${inputs.join(' ')} -filter_complex ${q(graph.join(';'))} -map '[vout]' -map '[aout]' $VENC -r ${fps} -c:a aac -b:a 192k -ar 48000 -f mp4 ${name}.part || { echo "FAILED at ${num(a)}s" >&2; exit 1; }; mv ${name}.part ${name}; fi`,
    );
  }

  const output = join(outDir, `${timeline}-4k.mp4`);
  lines.splice(7, 0, `TOTAL=${count}`);
  lines.push(
    `$FFMPEG -nostdin -v error -y -f concat -safe 0 -i concat.txt -c copy -movflags +faststart -f mp4 ${q(`${output}.part`)} && mv ${q(`${output}.part`)} ${q(output)}`,
    `echo "done: ${output}"`,
  );
  await writeFile(join(segDir, 'concat.txt'), `${list.join('\n')}\n`);
  await writeFile(join(outDir, 'plan.sh'), `${lines.join('\n')}\n`, { mode: 0o755 });
  process.stdout.write(
    `${JSON.stringify({ plan: join(outDir, 'plan.sh'), segments: count, durationSec: total, output })}\n`,
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
