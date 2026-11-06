#!/bin/bash
# Eight-spine, 31-turn fill. Needs a DSH profile and a model. No API key is stored here.
set -u
rid="$1"
root="${LIVE_ROOT:?set LIVE_ROOT}"
profile="${DSH_PROFILE:?set DSH_PROFILE}"
export DSH_HOME="${DSH_HOME:?set DSH_HOME}"
export SPINE_SHADOW_DIR="${SPINE_SHADOW_DIR:-$root/shadow/spine-${rid}}"
if [ -n "${SPINE_ENGINE:-}" ]; then
  export SPINE_ENGINE
fi
work="$root/work/spine-${rid}"
out="$root/runs/spine-${rid}"
here="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$out" "$SPINE_SHADOW_DIR"
rm -rf "$work"
python3 "$here/mkfx.py" "$work"
python3 "$here/prompts.py" >/dev/null
cd "$work"
sid=""
for turn in $(seq 1 31); do
  prompt=$(python3 -c 'import json,sys; print(next(x["prompt"] for x in json.load(open(sys.argv[1])) if x["turn"]==int(sys.argv[2])))' "$here/prompts.json" "$turn")
  log="$out/t${turn}.jsonl"
  if [ -n "$sid" ]; then
    dsh --profile "$profile" --json --session-id "$sid" "$prompt" > "$log" 2>"$log.err"
  else
    dsh --profile "$profile" --json "$prompt" > "$log" 2>"$log.err"
  fi
  sid=$(python3 -c 'import json,sys
sid=""
for line in open(sys.argv[1], errors="replace"):
    line=line.strip()
    if not line.startswith("{"):
        continue
    ev=json.loads(line)
    if ev.get("type")=="session" and ev.get("sessionId"):
        sid=ev["sessionId"]
print(sid)' "$log")
  echo "spine-${rid} turn ${turn} session ${sid}" >> "$out/progress.txt"
done
echo DONE >> "$out/progress.txt"
