#!/usr/bin/env python3
"""Builds the simulator: runs sim/record.sim.tsx against the real plugin and writes sim/out/index.html.

The recorder runs as a test in a scratch copy of the plugin, since the test runner runs only *.test
files and prints nothing a test says but its stderr. Usage: python3 sim/build.py
"""
import json
import pathlib
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
SIM = ROOT / "sim"


def record() -> list[dict]:
    with tempfile.TemporaryDirectory() as tmp:
        copy = pathlib.Path(tmp) / "progress-bar"
        for part in (".claude-plugin", "hooks", "types"):
            shutil.copytree(ROOT / part, copy / part)
        for test in (copy / "hooks").glob("*.test.ts*"):
            test.unlink()
        shutil.copy(SIM / "record.sim.tsx", copy / "hooks" / "record.test.tsx")
        run = subprocess.run(["claude", "plugin", "test", str(copy)], capture_output=True, text=True)
    out = run.stdout + run.stderr
    frames = [json.loads(line[4:]) for line in out.splitlines() if line.startswith("SIM {")]
    if run.returncode != 0 or not frames:
        sys.stderr.write(out)
        sys.exit(f"the recorder failed (exit {run.returncode}, {len(frames)} frames)")
    return frames


def main() -> None:
    frames = record()
    page = (SIM / "replay.html").read_text().replace("/*FRAMES*/[]", json.dumps(frames))
    (SIM / "out").mkdir(exist_ok=True)
    target = SIM / "out" / "index.html"
    target.write_text(page)
    scenarios = len({f["scenario"] for f in frames})
    print(f"{len(frames)} frames in {scenarios} scenarios -> {target}")


if __name__ == "__main__":
    main()
