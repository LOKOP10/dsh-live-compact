#!/bin/bash
set -u
root="${LIVE_ROOT:?set LIVE_ROOT}"
here="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$root/runs"
for r in 1 2 3 4 5 6 7 8; do
  bash "$here/run_one.sh" "$r" > "$root/runs/spine-${r}.log" 2>&1 &
done
wait
LIVE_ROOT="$root" python3 "$here/score.py" | tee "$root/runs/score.txt"
echo ALL_DONE
