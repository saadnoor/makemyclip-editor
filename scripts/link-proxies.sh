#!/usr/bin/env bash
# Mirror the archive's folder structure for the proxies, under one top folder:
#
#   /home/saadnoor/Saadnoors Life/2022/January/trip/GX010389.MP4          (original)
#   /home/saadnoor/Proxies/Saadnoors Life/2022/January/trip/GX010389.mp4  (proxy)
#
# Entries are hard links to the proxies the editor uses, so they take no extra
# space and stay valid if either name is removed. Idempotent; run any time.
#
#   link-proxies.sh [YYYY-MM ...]     (default: every prepared month)
set -uo pipefail

WS=${MAKEMYCLIP_WORKSPACE:-$HOME/editor-workspace}
BASE=${ARCHIVE_BASE:-$HOME}              # originals are relative to this
ROOT=${PROXY_ROOT:-$HOME/Proxies}

months=("$@")
if ((${#months[@]} == 0)); then
  for m in "$WS"/20*-*/manifest.tsv; do months+=("$(basename "$(dirname "$m")")"); done
fi

linked=0
for month in "${months[@]}"; do
  manifest="$WS/$month/manifest.tsv"
  [[ -f "$manifest" ]] || continue
  while IFS=$'\t' read -r proxy _stamp _dur orig; do
    [[ "$proxy" == proxy ]] && continue
    src="$WS/$month/$proxy"
    [[ -s "$src" ]] || continue
    rel=${orig#"$BASE"/}
    [[ "$rel" == "$orig" ]] && continue   # not under BASE
    dest="$ROOT/${rel%.*}.mp4"
    # Two originals differing only by extension (X.MOV and X.MP4) keep theirs.
    if [[ -e "$dest" && ! "$dest" -ef "$src" ]]; then
      ext=${rel##*.}
      dest="$ROOT/${rel%.*}.${ext,,}.mp4"
    fi
    [[ "$dest" -ef "$src" ]] && continue
    mkdir -p "$(dirname "$dest")"
    ln -f "$src" "$dest" && linked=$((linked + 1))
  done < "$manifest"
done
echo "linked $linked new proxies under $ROOT"
