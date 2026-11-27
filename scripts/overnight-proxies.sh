#!/usr/bin/env bash
# Prepare every month of the archive, oldest first, and put each on its own
# timeline. Safe to run again: months that already have a timeline are only
# topped up with missing proxies, never re-imported (that would wipe edits).
#
#   overnight-proxies.sh [first-year] [last-year]     (default 2022 2026)
#
# Month folders are matched by the start of their name, so "February Berlin +
# Amsterdam", "DECEMBER", "jan [wedding month]" and "Semtember UK trip" all
# work. A folder whose month can't be told, or a second folder for a month that
# already has one, is skipped and listed at the end.
set -uo pipefail

ARCHIVE=${ARCHIVE:-/home/saadnoor/Saadnoors Life}
FIRST=${1:-2022}
LAST=${2:-2026}
HERE=$(cd "$(dirname "$0")" && pwd)
set -a
# shellcheck disable=SC1090
. "$HOME/.config/makemyclip/env"
set +a
export PATH="$HOME/.local/node/bin:$PATH"
WS=$MAKEMYCLIP_WORKSPACE

log() { printf '%s %s\n' "$(date '+%F %T')" "$*"; }

month_of() { # folder name -> 01..12, or nothing
  local n
  n=$(tr '[:upper:]' '[:lower:]' <<<"$1")
  case "$n" in
    jan*) echo 01 ;; feb*) echo 02 ;; mar*) echo 03 ;; apr*) echo 04 ;;
    may*) echo 05 ;; jun*) echo 06 ;; jul*) echo 07 ;; aug*) echo 08 ;;
    sep* | sem*) echo 09 ;; oct*) echo 10 ;; nov*) echo 11 ;; dec*) echo 12 ;;
  esac
}

skipped=()
plan="$WS/overnight-plan.tsv"
: > "$plan"
for ((year = FIRST; year <= LAST; year++)); do
  [[ -d "$ARCHIVE/$year" ]] || continue
  declare -A seen=()
  # Collect "MM<TAB>folder" pairs, sorted by month.
  pairs=$(for d in "$ARCHIVE/$year"/*/; do
    name=$(basename "$d")
    mm=$(month_of "$name")
    if [[ -n "$mm" && ! "$name" =~ ^[A-Za-z]+-[A-Za-z]+ ]]; then printf '%s\t%s\n' "$mm" "$name"
    else printf 'xx\t%s\n' "$name"; fi
  done | sort)
  while IFS=$'\t' read -r mm name; do
    [[ -z "$name" ]] && continue
    if [[ "$mm" == xx ]]; then skipped+=("$year/$name (no single month)"); continue; fi
    month="$year-$mm"
    if [[ -n "${seen[$month]:-}" ]]; then skipped+=("$year/$name (second folder for $month)"); continue; fi
    seen[$month]=1
    printf '%s\t%s\n' "$month" "$year/$name" >> "$plan"
  done <<<"$pairs"
  unset seen
done

# PLAN_ONLY=1 just writes the plan (the progress page reads it).
[[ "${PLAN_ONLY:-}" == 1 ]] && exit 0

# Second pass: do the work, in plan order.
while IFS=$'\t' read -r month rel; do
    year=${month%%-*}; name=${rel#*/}
    log "== $month  ←  $year/$name"
    "$HERE/run-prepare-month.sh" "$ARCHIVE/$year/$name" "$month" < /dev/null 2>&1 | grep -v "libva info" | tail -3
    if [[ -f "$WS/timelines/$month/composition.json" ]]; then
      log "   $month already has a timeline — kept as is (proxies topped up only)"
    else
      "$HERE/import-month.sh" "$month" 25 < /dev/null 2>&1 | tail -1
    fi
done < "$plan"

log "finished $FIRST–$LAST"
if ((${#skipped[@]})); then
  log "skipped (do these by hand):"
  printf '   %s\n' "${skipped[@]}"
fi
