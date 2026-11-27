#!/usr/bin/env bash
# Prepare one month of footage for editing on proxies.
#
#   prepare-month.sh "<source month folder>" <YYYY-MM>
#
# Finds every video under the source folder (skipping Final Cut libraries,
# caches and macOS junk), orders them by capture time, and writes a 540p
# scrub-friendly proxy for each into $MAKEMYCLIP_WORKSPACE/<YYYY-MM>/.
# Proxies are named <capture time>_<original name>.mp4 so they sort in
# shooting order. manifest.tsv maps each proxy back to its original, which
# the final 4K conform reads. Re-running skips proxies that already exist.
#
# Uses the Intel GPU (QSV) for 4:2:0 H.264/HEVC sources when /dev/dri is
# usable (see run-prepare-month.sh, which runs this inside the Jellyfin image
# for its QSV-enabled FFmpeg) and falls back to the CPU otherwise — Sony's
# H.264 4:2:2 10-bit has no hardware decoder on Intel.
set -euo pipefail

SRC=${1:?source month folder}
MONTH=${2:?YYYY-MM}
WS=${MAKEMYCLIP_WORKSPACE:?set MAKEMYCLIP_WORKSPACE}
OUT="$WS/$MONTH"
mkdir -p "$OUT"
MANIFEST="$OUT/manifest.tsv"
LIST=$(mktemp)
trap 'rm -f "$LIST"' EXIT

log() { printf '%s %s\n' "$(date '+%F %T')" "$*"; }

# 1. Find candidate videos.
find "$SRC" \
  \( -name '*.fcpbundle' -o -name '*.fcpcache' -o -name '.*' -o -name 'Render Files' \
     -o -name 'Transcoded Media' -o -name 'Proxy Media' \) -prune -o \
  -type f \( -iname '*.mp4' -o -iname '*.mov' -o -iname '*.mts' -o -iname '*.m4v' \) -print0 |
  while IFS= read -r -d '' f; do
    # Skip files ffprobe can't read (broken FCP aliases, partial copies).
    info=$(ffprobe -v error -select_streams v:0 \
      -show_entries stream=codec_name,pix_fmt:format=duration:format_tags=creation_time \
      -of default=nw=1 "$f" </dev/null 2>/dev/null) || continue
    dur=$(sed -n 's/^duration=//p' <<<"$info" | head -1)
    [[ -z "$dur" || "$dur" == "N/A" ]] && continue
    ct=$(sed -n 's/^TAG:creation_time=//p' <<<"$info" | head -1)
    if [[ -z "$ct" ]]; then
      ct=$(date -u -d "@$(stat -c %Y "$f")" '+%Y-%m-%dT%H:%M:%S')
    fi
    stamp=$(date -u -d "$ct" '+%Y%m%d-%H%M%S' 2>/dev/null || echo 00000000-000000)
    codec=$(sed -n 's/^codec_name=//p' <<<"$info" | head -1)
    pix=$(sed -n 's/^pix_fmt=//p' <<<"$info" | head -1)
    printf '%s\t%s\t%s\t%s\t%s\n' "$stamp" "$dur" "$codec" "$pix" "$f"
  done | sort > "$LIST"

total=$(wc -l < "$LIST")
log "found $total clips in $SRC"
printf 'proxy\tcapture_utc\tduration\toriginal\n' > "$MANIFEST"

# 2. Make proxies, one at a time so the NAS stays responsive.
HAS_QSV=0
[[ -r /dev/dri/renderD128 && -w /dev/dri/renderD128 ]] && HAS_QSV=1
log "GPU (QSV): $([[ $HAS_QSV == 1 ]] && echo yes || echo no)"

can_qsv() { # codec pix_fmt
  [[ $HAS_QSV == 1 ]] || return 1
  case "$1:$2" in
    hevc:yuv420p | hevc:yuvj420p | hevc:yuv420p10le | h264:yuv420p | h264:yuvj420p) return 0 ;;
    *) return 1 ;;
  esac
}

proxy_qsv() { # in out
  ffmpeg -nostdin -v error -y -init_hw_device qsv=hw:/dev/dri/renderD128 \
    -hwaccel qsv -hwaccel_output_format qsv -i "$1" \
    -map 0:v:0 -map '0:a:0?' \
    -vf "scale_qsv=w=-1:h=540:format=nv12" \
    -c:v h264_qsv -global_quality 26 -g 25 \
    -c:a aac -b:a 128k -ac 2 \
    -movflags +faststart -f mp4 "$2"
}

proxy_cpu() { # in out
  nice -n 10 ffmpeg -nostdin -v error -y -skip_loop_filter all -i "$1" \
    -map 0:v:0 -map '0:a:0?' \
    -vf "scale=-2:540:flags=fast_bilinear,format=yuv420p" \
    -c:v libx264 -preset veryfast -crf 26 -g 25 -keyint_min 25 -sc_threshold 0 \
    -c:a aac -b:a 128k -ac 2 \
    -movflags +faststart -f mp4 "$2"
}

# The manifest lists every clip up front, so the 4K conform and the Mac worker
# can read it while proxies are still being made.
rm -f "$OUT/cpu-pending.tsv" "$OUT/queue.tsv"
while IFS=$'\t' read -r stamp dur codec pix f; do
  base=$(basename "$f"); base=${base%.*}
  proxy="${stamp}_${base// /_}.mp4"
  printf '%s\t%s\t%s\t%s\n' "$proxy" "$stamp" "$dur" "$f" >> "$MANIFEST"
  # Clips only a CPU can decode are shared with the Mac worker (mac-proxy-worker.sh).
  can_qsv "$codec" "$pix" || printf '%s\t%s\n' "$proxy" "$f" >> "$OUT/cpu-pending.tsv"
  # Every clip, for the Mac worker to help with in parallel: proxy, original, gpu|cpu.
  kind=cpu; can_qsv "$codec" "$pix" && kind=gpu
  printf '%s\t%s\t%s\n' "$proxy" "$f" "$kind" >> "$OUT/queue.tsv"
done < "$LIST"

# SCAN_ONLY=1: just list the month (manifest + queues) so helpers can start on it.
if [[ "${SCAN_ONLY:-}" == 1 ]]; then
  log "scanned $MONTH: $total clips"
  exit 0
fi

# A clip is claimed by creating .claims/<proxy> (mkdir is atomic). A claim older
# than CLAIM_TTL minutes is from a worker that died, and is taken over.
CLAIMS="$OUT/.claims"
CLAIM_TTL=${CLAIM_TTL:-180}
mkdir -p "$CLAIMS"
claim() {
  find "$CLAIMS" -maxdepth 1 -mindepth 1 -name "$1" -mmin +"$CLAIM_TTL" -exec rm -rf {} + 2>/dev/null
  mkdir "$CLAIMS/$1" 2>/dev/null
}

make_proxy() { # n proxy codec pix original
  local n=$1 proxy=$2 codec=$3 pix=$4 f=$5 how part="$OUT/.$2.nas.part"
  if can_qsv "$codec" "$pix" && proxy_qsv "$f" "$part"; then
    how=gpu
  elif proxy_cpu "$f" "$part"; then
    how=cpu
  else
    log "[$n/$total] FAILED: $f"
    rm -f "$part"
    return
  fi
  mv "$part" "$OUT/$proxy"
  log "[$n/$total] $how $codec/$pix $proxy"
}

# GPU-friendly clips first; the slow CPU ones last, so the Mac worker has time
# to take some of them.
for pass in gpu cpu; do
  n=0
  while IFS=$'\t' read -r stamp _dur codec pix f; do
    n=$((n + 1))
    if can_qsv "$codec" "$pix"; then [[ $pass == gpu ]] || continue; else [[ $pass == cpu ]] || continue; fi
    base=$(basename "$f"); base=${base%.*}
    proxy="${stamp}_${base// /_}.mp4"
    [[ -s "$OUT/$proxy" ]] && continue
    claim "$proxy" || continue
    make_proxy "$n" "$proxy" "$codec" "$pix" "$f"
  done < "$LIST"
done

log "done: $MONTH ($total clips) -> $OUT"
