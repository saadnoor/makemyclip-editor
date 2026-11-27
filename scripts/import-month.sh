#!/usr/bin/env bash
# Put a prepared month's proxies on a timeline of their own, in shooting order.
#
#   import-month.sh <YYYY-MM> [fps]
#
# Reads $MAKEMYCLIP_WORKSPACE/<YYYY-MM>/manifest.tsv (written by
# prepare-month.sh) and appends every proxy that exists to the timeline named
# <YYYY-MM>, which is recreated from scratch. The canvas is 4K: proxies are
# only stand-ins for the originals the final conform renders from.
set -euo pipefail

MONTH=${1:?YYYY-MM}
FPS=${2:-25}
WS=${MAKEMYCLIP_WORKSPACE:?set MAKEMYCLIP_WORKSPACE}
DIR="$WS/$MONTH"
CLI="node $(cd "$(dirname "$0")/.." && pwd)/dist/cli.js"

# Never rebuild a month that already has a timeline: that wipes its edits and
# their undo history. FORCE=1 overrides, deliberately.
if [[ -f "$WS/timelines/$MONTH/composition.json" && "${FORCE:-}" != 1 ]]; then
  echo "timeline $MONTH already exists — not rebuilding it (FORCE=1 to wipe and rebuild)" >&2
  exit 3
fi

cd "$WS"
$CLI timeline new --timeline "$MONTH" --width 3840 --height 2160 --fps "$FPS" >/dev/null
n=0
while IFS=$'\t' read -r proxy _stamp _dur _orig; do
  [[ "$proxy" == proxy || ! -s "$DIR/$proxy" ]] && continue
  $CLI timeline add-media "$DIR/$proxy" --timeline "$MONTH" >/dev/null
  n=$((n + 1))
done < "$DIR/manifest.tsv"
echo "added $n clips to timeline $MONTH"
