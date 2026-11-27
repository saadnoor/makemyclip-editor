#!/usr/bin/env bash
# Run on the Mac: put a month's edit into Final Cut Pro on the original footage.
#
#   fcp-handoff-mac.sh <YYYY-MM> [target volume]
#
# 1. The NAS writes <YYYY-MM>.fcpxml pointing at the originals' future place on
#    the target volume, plus the list of originals the edit uses.
# 2. Those originals (only the clips the edit keeps, whole files) are copied
#    from the NAS to <volume>/<YYYY-MM>/Originals/, resumably.
# 3. The FCPXML lands next to them; open it and Final Cut imports an event with
#    the clips and a project with the cut.
set -euo pipefail

MONTH=${1:?YYYY-MM}
VOLUME=${2:-/Volumes/nvmessdsaadnoor}
NAS=${PROXY_NAS:-saadnoor@192.168.8.214}
ARCHIVE="/home/saadnoor/Saadnoors Life"
REPO=/home/saadnoor/code/makemyclip-editor
DEST="$VOLUME/$MONTH"
ORIG="$DEST/Originals"

[[ -d "$VOLUME" ]] || { echo "$VOLUME is not mounted." >&2; exit 1; }
mkdir -p "$ORIG"

echo "→ building the Final Cut project on the NAS…"
ssh "$NAS" "bash -lc 'cd $REPO && set -a && . ~/.config/makemyclip/env && set +a && pnpm exec tsx scripts/fcp-handoff.ts $MONTH \"$ARCHIVE\" \"$ORIG\"'" < /dev/null

HANDOFF="/home/saadnoor/editor-workspace/$MONTH/handoff"
ssh "$NAS" "cat $HANDOFF/originals.txt" < /dev/null > "$DEST/originals.txt"
need=$(ssh "$NAS" "cd \"$ARCHIVE\" && tr '\n' '\0' < $HANDOFF/originals.txt | du -ch --files0-from=- | tail -1 | cut -f1" < /dev/null)
echo "→ copying $(wc -l < "$DEST/originals.txt" | tr -d ' ') originals ($need) to $ORIG…"

# One file at a time over ssh (macOS's openrsync can't take remote paths with
# spaces); a file already complete at the right size is skipped, so re-running
# resumes.
while IFS= read -r rel; do
  [[ -z "$rel" ]] && continue
  dst="$ORIG/$rel"
  size=$(ssh "$NAS" "stat -c %s $(printf '%q' "$ARCHIVE/$rel")" < /dev/null)
  if [[ -f "$dst" && $(stat -f %z "$dst") == "$size" ]]; then continue; fi
  mkdir -p "$(dirname "$dst")"
  printf '   %s\n' "$rel"
  ssh "$NAS" "cat $(printf '%q' "$ARCHIVE/$rel")" < /dev/null > "$dst.part"
  [[ $(stat -f %z "$dst.part") == "$size" ]] || { echo "Copy of $rel is incomplete." >&2; exit 1; }
  mv "$dst.part" "$dst"
done < "$DEST/originals.txt"

ssh "$NAS" "cat $HANDOFF/$MONTH.fcpxml" < /dev/null > "$DEST/$MONTH.fcpxml"
echo "✓ Done. Open $DEST/$MONTH.fcpxml in Final Cut Pro."
