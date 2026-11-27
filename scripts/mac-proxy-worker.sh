#!/usr/bin/env bash
# Help the NAS make proxies for clips only a CPU can decode (Sony H.264 4:2:2
# 10-bit), using a Mac's faster CPU — but only while the Mac is plugged in,
# on the home network, and mostly idle. Meant to run from launchd every few
# minutes (see mac-proxy-worker.plist); each run works until there's nothing
# left or the Mac gets busy.
#
# Coordination with prepare-month.sh on the NAS: each month folder has a
# cpu-pending.tsv (proxy, original path); a clip is taken by atomically
# creating .claims/<proxy> on the NAS, so the two never do the same clip.
set -uo pipefail
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin

NAS=${PROXY_NAS:-saadnoor@192.168.8.214}
WS=${PROXY_WS:-/home/saadnoor/editor-workspace}
MIN_IDLE=${PROXY_MIN_IDLE:-60}   # % CPU idle required before each clip
CLAIM_TTL=${CLAIM_TTL:-180}      # minutes before an abandoned claim is retaken
TMP_ROOT="$HOME/Library/Caches/mac-proxy-worker"

log() { printf '%s %s\n' "$(date '+%F %T')" "$*"; }
nas() { ssh -o BatchMode=yes -o ConnectTimeout=5 "$NAS" "$@" < /dev/null; }
# Same, but stdin is passed through (for uploading a file).
nas_put() { ssh -o BatchMode=yes -o ConnectTimeout=5 "$NAS" "$@"; }

on_ac_power() { pmset -g batt | head -1 | grep -q "AC Power"; }

cpu_idle() { # percent idle over a 2-second sample
  top -l 2 -n 0 -s 2 | awk '/CPU usage/ {v=$7} END {sub("%","",v); print int(v)}'
}

ready() {
  if ! on_ac_power; then log "on battery, stopping"; return 1; fi
  local idle; idle=$(cpu_idle)
  if (( idle < MIN_IDLE )); then log "busy (${idle}% idle < ${MIN_IDLE}%), stopping"; return 1; fi
  return 0
}

if ! nas true 2>/dev/null; then log "NAS not reachable"; exit 0; fi
ready || exit 0
mkdir -p "$TMP_ROOT"

# Every clip still without a proxy: "<kind>\t<month dir>\t<proxy>\t<original>".
# Months scanned before queue.tsv existed fall back to cpu-pending.tsv.
pending() {
  nas "for d in $WS/*/; do d=\${d%/};
    if [ -f \"\$d/queue.tsv\" ]; then
      while IFS=\$'\t' read -r p o k; do [ -s \"\$d/\$p\" ] || printf '%s\t%s\t%s\t%s\n' \"\$k\" \"\$d\" \"\$p\" \"\$o\"; done < \"\$d/queue.tsv\"
    elif [ -f \"\$d/cpu-pending.tsv\" ]; then
      while IFS=\$'\t' read -r p o; do [ -s \"\$d/\$p\" ] || printf 'cpu\t%s\t%s\t%s\n' \"\$d\" \"\$p\" \"\$o\"; done < \"\$d/cpu-pending.tsv\"
    fi; done"
}

# Order: CPU-only clips first (the Mac is ~4x the NAS on those), then the rest
# from the latest month backwards — the NAS works forwards, so they meet in the
# middle instead of fighting over the same clips.
order() {
  awk -F'\t' '$1=="cpu"' <<<"$1"
  awk -F'\t' '$1=="gpu"' <<<"$1" | tail -r
}

done_count=0
while ready; do
  todo=$(pending)
  [[ -z "$todo" ]] && break
  log "$(wc -l <<<"$todo" | tr -d ' ') clips waiting ($(grep -c '^cpu' <<<"$todo") CPU-only)"
  # Work through a batch, then re-read the queues (new months get scanned).
  batch=$(order "$todo" | head -20)
  progressed=0
  while IFS=$'\t' read -r kind dir proxy orig; do
    ready || break 2
    q_dir=$(printf '%q' "$dir"); q_proxy=$(printf '%q' "$proxy"); q_orig=$(printf '%q' "$orig")
    # Claim it unless it's done or taken (a stale claim is cleared first).
    nas "[ -s $q_dir/$q_proxy ] && exit 1; mkdir -p $q_dir/.claims; find $q_dir/.claims -maxdepth 1 -mindepth 1 -name $q_proxy -mmin +$CLAIM_TTL -exec rm -rf {} + 2>/dev/null; mkdir $q_dir/.claims/$q_proxy 2>/dev/null" || continue

    tmp=$(mktemp -d "$TMP_ROOT/job.XXXX")
    start=$(date +%s)
    if ! nas "cat $q_orig" > "$tmp/src"; then
      log "FAILED copy: $orig"; rm -rf "$tmp"; nas "rmdir $q_dir/.claims/$q_proxy"; continue
    fi
    # Apple's media engine decodes H.264/HEVC 4:2:0; Sony 4:2:2 decodes on the CPU.
    if [[ "$kind" == gpu ]]; then dec=(-hwaccel videotoolbox); else dec=(-skip_loop_filter all); fi
    if nice -n 15 ffmpeg -nostdin -v error -y "${dec[@]}" -i "$tmp/src" \
        -map 0:v:0 -map '0:a:0?' \
        -vf "scale=-2:540:flags=fast_bilinear,format=yuv420p" \
        -c:v h264_videotoolbox -b:v 1500k -maxrate 2500k -bufsize 3000k -g 25 \
        -c:a aac -b:a 128k -ac 2 -movflags +faststart "$tmp/proxy.mp4" &&
      [[ -s "$tmp/proxy.mp4" ]] &&
      nas_put "cat > $q_dir/.$q_proxy.mac.part && test -s $q_dir/.$q_proxy.mac.part && mv $q_dir/.$q_proxy.mac.part $q_dir/$q_proxy" < "$tmp/proxy.mp4"; then
      log "done in $(( $(date +%s) - start ))s ($kind): $proxy"
      done_count=$((done_count + 1)); progressed=1
    else
      log "FAILED: $orig"
      nas "rm -f $q_dir/.$q_proxy.mac.part; rmdir $q_dir/.claims/$q_proxy"
    fi
    rm -rf "$tmp"
  done <<<"$batch"
  # Everything left is claimed by the NAS: nothing for us right now.
  ((progressed)) || break
done
log "stopping after $done_count clips"
