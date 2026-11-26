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
      -show_entries stream=width,height:format=duration:format_tags=creation_time \
      -of default=nw=1 "$f" </dev/null 2>/dev/null) || continue
    dur=$(sed -n 's/^duration=//p' <<<"$info" | head -1)
    [[ -z "$dur" || "$dur" == "N/A" ]] && continue
    ct=$(sed -n 's/^TAG:creation_time=//p' <<<"$info" | head -1)
    if [[ -z "$ct" ]]; then
      ct=$(date -u -d "@$(stat -c %Y "$f")" '+%Y-%m-%dT%H:%M:%S')
    fi
    stamp=$(date -u -d "$ct" '+%Y%m%d-%H%M%S' 2>/dev/null || echo 00000000-000000)
    printf '%s\t%s\t%s\n' "$stamp" "$dur" "$f"
  done | sort > "$LIST"

total=$(wc -l < "$LIST")
log "found $total clips in $SRC"
printf 'proxy\tcapture_utc\tduration\toriginal\n' > "$MANIFEST"

# 2. Make proxies (CPU decode; one at a time so the NAS stays responsive).
n=0
while IFS=$'\t' read -r stamp dur f; do
  n=$((n + 1))
  base=$(basename "$f"); base=${base%.*}
  proxy="${stamp}_${base// /_}.mp4"
  printf '%s\t%s\t%s\t%s\n' "$proxy" "$stamp" "$dur" "$f" >> "$MANIFEST"
  if [[ -s "$OUT/$proxy" ]]; then continue; fi
  log "[$n/$total] $proxy"
  nice -n 10 ffmpeg -nostdin -v error -y -i "$f" \
    -map 0:v:0 -map '0:a:0?' \
    -vf "scale=-2:540:flags=bilinear,format=yuv420p" \
    -c:v libx264 -preset veryfast -crf 26 -g 25 -keyint_min 25 -sc_threshold 0 \
    -c:a aac -b:a 128k -ac 2 \
    -movflags +faststart -f mp4 "$OUT/.$proxy.part" &&
    mv "$OUT/.$proxy.part" "$OUT/$proxy" ||
    log "FAILED: $f"
done < "$LIST"

log "done: $MONTH ($total clips) -> $OUT"
