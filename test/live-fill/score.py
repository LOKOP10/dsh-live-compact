#!/usr/bin/env python3
"""Score the 8x31 fill from the original turn map, not a workspace truth file."""
import json
import os
from pathlib import Path

FILL = [2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 14, 15, 16, 17, 18, 20, 21, 22, 23, 24, 25, 26, 27]
NOTICE = {
    4: "NOTICE cache layer pinned to sqlite",
    11: "NOTICE reviewer queue flushed Okafor",
    20: "NOTICE edge cache purged keys=1207",
}
ROOT = Path(os.environ.get("LIVE_ROOT", "."))

def warns_for(turn):
    return 3 + (turn % 9)

def load_turn(path: Path):
    tools = 0
    final = ""
    done = False
    hit = miss = out = 0
    first_hit = first_miss = 0
    last_total = None
    seen = False
    for line in path.read_text(errors="replace").splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        ev = json.loads(line)
        if ev.get("type") == "tool_call":
            tools += 1
        if ev.get("type") == "final":
            final = ev.get("text") or ""
            done = True
        if ev.get("type") == "status" and ev.get("phase") == "step_end" and ev.get("usage"):
            usage = ev["usage"]
            hit += usage.get("cacheReadTokens") or 0
            miss += usage.get("inputTokens") or 0
            out += usage.get("outputTokens") or 0
            if not seen:
                first_hit = usage.get("cacheReadTokens") or 0
                first_miss = usage.get("inputTokens") or 0
                seen = True
            last_total = usage.get("totalTokens") or last_total
    return done, tools, final, hit, miss, out, first_hit, first_miss, last_total

def main():
    skip = answered = warn_bad = notice_bad = 0
    hit = miss = fh = fm = 0
    last_totals = []
    for rid in range(1, 9):
        spine_hit = spine_miss = 0
        last27 = None
        for turn in range(1, 32):
            log = ROOT / f"runs/spine-{rid}/t{turn}.jsonl"
            if not log.exists():
                continue
            done, tools, final, h, m, o, first_h, first_m, last = load_turn(log)
            if not done:
                continue
            hit += h
            miss += m
            fh += first_h
            fm += first_m
            spine_hit += first_h
            spine_miss += first_m
            if turn == 27:
                last27 = last
                last_totals.append(last)
            if turn not in FILL:
                continue
            answered += 1
            if tools == 0 and any(ch.isdigit() for ch in final):
                skip += 1
            if str(warns_for(turn)) not in final:
                warn_bad += 1
            notice = NOTICE.get(turn)
            if notice is None:
                if "NOTICE" in final and "NONE" not in final:
                    notice_bad += 1
            elif notice not in final:
                notice_bad += 1
        denom = spine_hit + spine_miss
        print(f"spine-{rid} t27 {last27} prefix {spine_hit / denom if denom else 0:.2%}")
    prefix = fh / (fh + fm) if fh + fm else 0
    all_steps = hit / (hit + miss) if hit + miss else 0
    print(f"answered {answered} skip {skip} warn_bad {warn_bad} notice_bad {notice_bad}")
    print(f"prefix {prefix:.2%} all_steps {all_steps:.2%}")
    print(f"turn27 {last_totals} max {max(last_totals) if last_totals else None}")

if __name__ == "__main__":
    main()
