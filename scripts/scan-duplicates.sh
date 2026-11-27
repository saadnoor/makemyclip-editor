#!/usr/bin/env bash
# Find duplicate files in the archive with Czkawka's engine (the `czkawka`
# container) and leave the result where the editor's /duplicates page reads it.
# Read-only: nothing is moved or deleted.
#
#   scan-duplicates.sh
set -uo pipefail

ARCHIVE=${ARCHIVE:-/home/saadnoor/Saadnoors Life}
INSIDE="/storage/$(basename "$ARCHIVE")"          # where czkawka sees it
CONFIG=${CZKAWKA_CONFIG:-/volume1/docker/czkawka/config}
WS=${MAKEMYCLIP_WORKSPACE:-$HOME/editor-workspace}
OUT="$WS/.duplicates"
mkdir -p "$OUT"

status() { printf '{"state":"%s","startedAt":%s,"finishedAt":%s}\n' "$1" "$2" "$3" > "$OUT/status.json"; }
started=$(date +%s)
status scanning "$started" null

# Whole-file hashes (BLAKE3), files of 1 MB and up; the prehash cache makes
# later scans much faster.
if docker exec czkawka czkawka_cli dup -d "$INSIDE" -s hash -m 1000000 -u \
    -C /config/duplicates.json > "$OUT/scan.log" 2>&1; then
  # Map container paths back to NAS paths.
  sed "s#\"$INSIDE#\"$ARCHIVE#g" "$CONFIG/duplicates.json" > "$OUT/result.json.part" &&
    mv "$OUT/result.json.part" "$OUT/result.json"
  status done "$started" "$(date +%s)"
else
  status failed "$started" "$(date +%s)"
  exit 1
fi
