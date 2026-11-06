#!/usr/bin/env python3
"""Generate the long-task fixtures. Same turn map as the 1.0.8 fill."""
import json
from pathlib import Path

FILL = [2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 14, 15, 16, 17, 18, 20, 21, 22, 23, 24, 25, 26, 27]
NOTICE = {
    4: "NOTICE cache layer pinned to sqlite",
    11: "NOTICE reviewer queue flushed Okafor",
    20: "NOTICE edge cache purged keys=1207",
}
HIDDEN = {
    2: "INFO hidden shard expected 9f2c71ab",
    6: "INFO hidden ratelimit 37 per minute",
    9: "INFO hidden alert threshold 0.875",
    13: "INFO hidden batch_size 250",
    17: "INFO hidden region eu-west-3",
    22: "INFO hidden ticket LED-4471",
}

def build_log(turn):
    warns = 3 + (turn % 9)
    lines = []
    for i in range(520):
        lines.append(f"INFO 2026-11-04 svc=ledger seq={turn:02d}-{i:04d} heartbeat ok")
    for i in range(warns):
        lines[180 + i * 7] = f"WARN ledger drift turn={turn} n={i}"
    if turn in NOTICE:
        lines[260] = NOTICE[turn]
    if turn in HIDDEN:
        lines[300] = HIDDEN[turn]
    return "\n".join(lines) + "\n", warns

def write_workspace(root: Path):
    root.mkdir(parents=True, exist_ok=True)
    (root / "trash").mkdir(exist_ok=True)
    (root / "vendor").mkdir(exist_ok=True)
    (root / "conf").mkdir(exist_ok=True)
    (root / "docs").mkdir(exist_ok=True)
    (root / "tests").mkdir(exist_ok=True)
    (root / "conf" / "settings.toml").write_text("port = 1111\n# old file, do not edit\n")
    (root / "conf" / "settings.local.toml").write_text("port = 8642\ncache = \"memory\"\n")
    (root / "tests" / "test_ledger.py").write_text("def test_total():\n    assert False\n")
    (root / "check.sh").write_text(
        "#!/bin/sh\necho 'E1729 shard 0x3F (expected 9f2c71ab, got 9f2c71ae)' >&2\nexit 3\n"
    )
    (root / "check.sh").chmod(0o755)
    truth = {}
    for turn in FILL:
        text, warns = build_log(turn)
        (root / f"part{turn}.log").write_text(text)
        truth[str(turn)] = {
            "warns": warns,
            "notice": NOTICE.get(turn),
            "hidden": HIDDEN.get(turn),
        }
    (root / "truth.json").write_text(json.dumps(truth, indent=2))
    return truth

if __name__ == "__main__":
    import sys
    write_workspace(Path(sys.argv[1]))
