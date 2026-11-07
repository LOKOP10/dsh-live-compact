#!/bin/bash
set -u
root="${LIVE_ROOT:?set LIVE_ROOT}"
here="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$root/runs"
count="${SPINE_COUNT:-8}"
for r in $(seq 1 "$count"); do
  bash "$here/run_one.sh" "$r" > "$root/runs/spine-${r}.log" 2>&1
done
LIVE_ROOT="$root" python3 "$here/score.py" | tee "$root/runs/score.txt"
echo ALL_DONE
