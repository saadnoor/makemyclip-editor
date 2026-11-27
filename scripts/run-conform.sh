#!/usr/bin/env bash
# Render a timeline to 4K on the NAS: plan it (conform.ts), then run the plan in
# the Jellyfin image, whose FFmpeg has Intel QSV, with the GPU passed through.
#
#   run-conform.sh <timeline>
set -euo pipefail
TIMELINE=${1:?timeline}
WS=${MAKEMYCLIP_WORKSPACE:?set MAKEMYCLIP_WORKSPACE}
ARCHIVE=${ARCHIVE:-/home/saadnoor/Saadnoors Life}
HERE=$(cd "$(dirname "$0")" && pwd)

(cd "$HERE/.." && pnpm exec tsx scripts/conform.ts "$TIMELINE")

RENDER_GID=$(stat -c %g /dev/dri/renderD128)
exec docker run --rm --name "conform-$TIMELINE" \
  --device /dev/dri:/dev/dri \
  --user "$(id -u):$(id -g)" --group-add "$RENDER_GID" \
  -e LIBVA_MESSAGING_LEVEL=1 \
  -e FFMPEG=/usr/lib/jellyfin-ffmpeg/ffmpeg \
  -e VENC="-c:v hevc_qsv -profile:v main10 -preset medium -global_quality 22 -g 50 -tag:v hvc1" \
  -v "$ARCHIVE":"$ARCHIVE":ro \
  -v "$WS":"$WS" \
  --entrypoint /bin/bash \
  jellyfin/jellyfin:latest "$WS/$TIMELINE/render/plan.sh"
