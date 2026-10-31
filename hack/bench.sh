#!/usr/bin/env bash
# Runs one in-app benchmark against synthetic clusters and writes JSON:
#   hack/bench.sh <table|storm|multi|idle> <CLUSTRAIL_SYNTHETIC spec> <out.json> [seconds]
# e.g. hack/bench.sh table pods=50000 bench-a-50k.json
#      hack/bench.sh idle clusters=5,pods=2000 idle.json 60   (60 s visible, then 60 s hidden)
# The app runs the scenario in its own WebView, reports to Go and quits. On
# Linux without a display it runs under xvfb-run. The app's processes (Go and
# the WebView's) are sampled from the OS every second: resident memory, and
# cumulative CPU time, from which each idle phase's CPU use is computed. On
# macOS the WebKit processes are not children of the app; the ones that start
# with it are attributed to it.
set -euo pipefail
scenario=$1 spec=$2 out=$3 seconds=${4:-}
root=$(cd "$(dirname "$0")/.." && pwd)
bin=${CLUSTRAIL_BIN:-$root/bin/clustrail}
[ -x "$bin" ] || { echo "build first: go build -tags production -o bin/clustrail ."; exit 1; }
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

run=("$bin")
if [ "$(uname)" = Linux ] && [ -z "${DISPLAY:-}" ]; then
  run=(xvfb-run -a -s "-screen 0 1440x900x24" "$bin")
fi
# A hung run is stopped after 15 minutes (macOS has no timeout(1) unless coreutils is installed).
if command -v timeout >/dev/null; then
  run=(timeout 900 "${run[@]}")
elif command -v gtimeout >/dev/null; then
  run=(gtimeout 900 "${run[@]}")
fi
webview='WebKit|WebContent|msedgewebview2'
# WebView processes that already run (Safari, other apps) are not ours.
( (pgrep -f "$webview" 2>/dev/null || true) | sort -n >"$work/before.pids" )

CLUSTRAIL_BENCH=$scenario CLUSTRAIL_SYNTHETIC=$spec CLUSTRAIL_BENCH_SECONDS=$seconds \
CLUSTRAIL_BENCH_OUT=$work/result.json CLUSTRAIL_CONFIG=$work/contexts.json XDG_CACHE_HOME=$work/cache \
KUBECONFIG=/dev/null "${run[@]}" >"$work/app.log" 2>&1 &
wrapper=$!

# Cumulative CPU seconds of a process: /proc (10 ms ticks) on Linux, ps's
# [[dd-]hh:]mm:ss.ff elsewhere (macOS reports hundredths).
cpu_of() {
  if [ -r "/proc/$1/stat" ]; then
    awk '{ sub(/^.*\) /, ""); printf "%.2f", ($12 + $13) / 100 }' "/proc/$1/stat" 2>/dev/null || true
  else
    (ps -o time= -p "$1" 2>/dev/null || true) | tr -d ' ' |
      awk -F'[-:]' 'NF { s=0; n=NF; for (i=1; i<=n; i++) { v=$i; if (n==4 && i==1) s+=v*86400; else s=s*60+v } printf "%.2f", s }'
  fi
}

echo "t_ms,app_mb,webview_mb,app_cpu_s,webview_cpu_s,webview_procs" >"$work/samples.csv"
app=""
while kill -0 $wrapper 2>/dev/null; do
  [ -n "$app" ] || app=$( (pgrep -f "^$bin" 2>/dev/null || true) | head -1)
  if [ -n "$app" ]; then
    now=$(python3 -c 'import time; print(int(time.time()*1000))')
    appmb=$( (ps -o rss= -p "$app" 2>/dev/null || true) | awk '{printf "%.0f", $1/1024}')
    appcpu=$(cpu_of "$app")
    webmb=0 webcpu=0 procs=0
    for p in $( (pgrep -f "$webview" 2>/dev/null || true) | sort -n | comm -13 "$work/before.pids" -); do
      m=$( (ps -o rss= -p "$p" 2>/dev/null || true) | awk '{print $1}')
      c=$(cpu_of "$p")
      [ -n "$m" ] || continue
      webmb=$(awk -v a="$webmb" -v b="$m" 'BEGIN{printf "%.0f", a+b/1024}')
      webcpu=$(awk -v a="$webcpu" -v b="${c:-0}" 'BEGIN{printf "%.2f", a+b}')
      procs=$((procs + 1))
    done
    echo "$now,${appmb:-0},$webmb,${appcpu:-0},$webcpu,$procs" >>"$work/samples.csv"
    echo "$app $( (pgrep -f "$webview" 2>/dev/null || true) | sort -n | comm -13 "$work/before.pids" - | tr '\n' ' ')" >"$work/pids"
  fi
  sleep 1
done
wait $wrapper || true

if [ ! -s "$work/result.json" ]; then
  echo "benchmark produced no result; app log:" >&2
  tail -30 "$work/app.log" >&2
  exit 1
fi
touch "$work/pids"
python3 - "$work/result.json" "$work/samples.csv" "$out" "$work/pids" <<'PY'
import csv, json, platform, sys
res = json.load(open(sys.argv[1]))
pids = open(sys.argv[4]).read().split()
res["pids"] = {"app": int(pids[0]) if pids else None, "webview": [int(p) for p in pids[1:]]}
rows = [{k: float(v) for k, v in r.items()} for r in csv.DictReader(open(sys.argv[2]))]
def summary(key):
    v = [r[key] for r in rows if r[key] > 0]
    return {"max": max(v), "last": v[-1], "samples": len(v)} if v else None
res["osMemoryMB"] = {"go": summary("app_mb"), "webview": summary("webview_mb")}
res["os"] = {"system": platform.system(), "release": platform.release(), "machine": platform.machine()}
# Each idle phase's CPU from the OS, as % of one core: the app process and its
# WebView processes, from cumulative CPU time at the phase's start and end.
def at(t):
    before = [r for r in rows if r["t_ms"] <= t]
    return before[-1] if before else None
for ph in res.get("phases", []):
    a, b = at(ph["startedAt"]), at(ph["endedAt"])
    if not a or not b or b["t_ms"] <= a["t_ms"]:
        continue
    sec = (b["t_ms"] - a["t_ms"]) / 1000
    ph["os"] = {
        "appCpuPercent": round(100 * (b["app_cpu_s"] - a["app_cpu_s"]) / sec, 2),
        "webviewCpuPercent": round(100 * (b["webview_cpu_s"] - a["webview_cpu_s"]) / sec, 2),
        "webviewProcesses": int(b["webview_procs"]),
        "appMB": int(b["app_mb"]), "webviewMB": int(b["webview_mb"]),
    }
json.dump(res, open(sys.argv[3], "w"), indent=2)
print(json.dumps({k: res[k] for k in res if k not in ("backendSamples",)}, indent=1)[:4000])
PY
