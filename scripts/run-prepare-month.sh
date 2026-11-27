#!/usr/bin/env bash
# Run prepare-month.sh inside the Jellyfin image, whose FFmpeg has Intel QSV,
# with the GPU passed through. Works without root: the caller only needs to be
# in the docker group.
#
#   run-prepare-month.sh "<source month folder>" <YYYY-MM>
set -euo pipefail
SRC=${1:?source month folder}
MONTH=${2:?YYYY-MM}
WS=${MAKEMYCLIP_WORKSPACE:?set MAKEMYCLIP_WORKSPACE}
HERE=$(cd "$(dirname "$0")" && pwd)
RENDER_GID=$(stat -c %g /dev/dri/renderD128)

exec docker run --rm --name "prepare-$MONTH" \
  --device /dev/dri:/dev/dri \
  --user "$(id -u):$(id -g)" --group-add "$RENDER_GID" \
  -e MAKEMYCLIP_WORKSPACE="$WS" -e LIBVA_MESSAGING_LEVEL=1 -e SCAN_ONLY="${SCAN_ONLY:-}" \
  -e PATH=/usr/lib/jellyfin-ffmpeg:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  -v "$SRC":"$SRC":ro \
  -v "$WS":"$WS" \
  -v "$HERE":/scripts:ro \
  --entrypoint /bin/bash \
  jellyfin/jellyfin:latest /scripts/prepare-month.sh "$SRC" "$MONTH"
