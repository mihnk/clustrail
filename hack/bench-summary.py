#!/usr/bin/env python3
"""Summarizes a directory of benchmark results (hack/bench.sh output files
named <scenario>-<n>.json): the median of each metric across repetitions,
with the range, as a Markdown table on stdout.

    python3 hack/bench-summary.py docs/benchmarks/data/<run>/
"""
import glob
import json
import os
import re
import statistics
import sys


def get(d, path):
    for k in path.split("."):
        if isinstance(d, list):
            d = next((x for x in d if isinstance(x, dict) and x.get("name") == k), None)
        elif isinstance(d, dict):
            d = d.get(k)
        else:
            return None
        if d is None:
            return None
    return d


def total_cpu(r, phase):
    os_ = get(r, f"phases.{phase}.os")
    if os_:
        return os_["appCpuPercent"] + os_["webviewCpuPercent"]
    fam = get(r, f"phases.{phase}.family")
    return fam.get("cpuPercent") if isinstance(fam, dict) else None


def page_callbacks(r, phase):
    p = get(r, f"phases.{phase}.pagePerSec")
    return sum(p.values()) if p else None


# (label, unit, extractor) per scenario kind
METRICS = {
    "idle": [
        ("visible: CPU, all processes", "% of a core", lambda r: total_cpu(r, "visible")),
        ("visible: Go wakeups", "/s", lambda r: get(r, "phases.visible.go.wakeupsPerSec")),
        ("visible: page timer and frame callbacks", "/s", lambda r: page_callbacks(r, "visible")),
        ("visible: DOM changes", "/s", lambda r: get(r, "phases.visible.domMutationsPerSec")),
        ("visible: top idle wakeups (macOS)", "/s", lambda r: get(r, "phases.visible.top.idleWakeupsPerSec")),
        ("visible: top energy impact (macOS)", "", lambda r: get(r, "phases.visible.top.power")),
        ("hidden: CPU, all processes", "% of a core", lambda r: total_cpu(r, "hidden")),
        ("hidden: Go wakeups", "/s", lambda r: get(r, "phases.hidden.go.wakeupsPerSec")),
        ("hidden: page timer and frame callbacks", "/s", lambda r: page_callbacks(r, "hidden")),
        ("hidden: top idle wakeups (macOS)", "/s", lambda r: get(r, "phases.hidden.top.idleWakeupsPerSec")),
        ("hidden: top energy impact (macOS)", "", lambda r: get(r, "phases.hidden.top.power")),
        # The highest sample: the last one may be taken while the app quits.
        ("memory: Go process (max)", "MB", lambda r: get(r, "osMemoryMB.go.max")),
        ("memory: WebView processes (max)", "MB", lambda r: get(r, "osMemoryMB.webview.max")),
    ],
    "table": [
        ("time to first full table", "ms", lambda r: get(r, "loadMs")),
        ("steady scroll frame p95", "ms", lambda r: get(r, "scrollSteady.frameMs.p95")),
        ("jump scroll frame p95", "ms", lambda r: get(r, "scrollJump.frameMs.p95")),
        ("search keystroke → painted p95", "ms", lambda r: get(r, "search.ms.p95")),
        ("sort by status p50", "ms", lambda r: get(r, "sort.Status.p50")),
        ("open inspector p95", "ms", lambda r: get(r, "inspector.p95")),
        ("memory: Go process (max)", "MB", lambda r: get(r, "osMemoryMB.go.max")),
        ("memory: WebView processes (max)", "MB", lambda r: get(r, "osMemoryMB.webview.max")),
    ],
    "storm": [
        ("frame rate during the storm", "fps", lambda r: get(r, "frames.fps")),
        ("receive → painted p95", "ms", lambda r: get(r, "stream.receiveToPaintMs.p95")),
        ("UI update cost p95", "ms", lambda r: get(r, "stream.updateCostMs.p95")),
        ("scroll during the storm, frame p95", "ms", lambda r: get(r, "scrollDuringStorm.frameMs.p95")),
        ("UI equals Go after the storm", "", lambda r: 1 if get(r, "consistency.equal") else 0),
        ("memory: WebView processes (max)", "MB", lambda r: get(r, "osMemoryMB.webview.max")),
    ],
    "multi": [
        ("frame rate", "fps", lambda r: get(r, "frames.fps")),
        ("receive → painted p95", "ms", lambda r: get(r, "stream.receiveToPaintMs.p95")),
        ("UI update cost p95", "ms", lambda r: get(r, "stream.updateCostMs.p95")),
        ("memory: WebView processes (max)", "MB", lambda r: get(r, "osMemoryMB.webview.max")),
    ],
}


def fmt(x):
    return f"{x:.1f}" if isinstance(x, float) and abs(x) < 100 else f"{x:.0f}"


def main(d):
    by_scenario = {}
    for f in sorted(glob.glob(os.path.join(d, "*.json"))):
        m = re.match(r"(.+)-(\d+)\.json$", os.path.basename(f))
        if not m:
            continue
        try:
            by_scenario.setdefault(m.group(1), []).append(json.load(open(f)))
        except (OSError, ValueError):
            pass
    for name, runs in by_scenario.items():
        kind = runs[0].get("scenario", name.split("-")[0])
        errors = [r["error"] for r in runs if r.get("error")]
        print(f"### {name} ({len(runs)} run{'s' if len(runs) != 1 else ''}, synthetic: {runs[0].get('synthetic')})\n")
        if errors:
            print(f"Errors: {errors}\n")
        print("| Metric | Median | Range |\n|---|---|---|")
        for label, unit, fn in METRICS.get(kind, []):
            vals = []
            for r in runs:
                try:
                    v = fn(r)
                except (TypeError, KeyError):
                    v = None
                if isinstance(v, (int, float)):
                    vals.append(float(v))
            if not vals:
                continue
            u = f" {unit}" if unit else ""
            rng = f"{fmt(min(vals))}–{fmt(max(vals))}" if len(vals) > 1 else "—"
            print(f"| {label} | {fmt(statistics.median(vals))}{u} | {rng} |")
        print()


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else ".")
