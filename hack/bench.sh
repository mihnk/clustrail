#!/usr/bin/env bash
# Runs one in-app benchmark against synthetic clusters and writes JSON:
#   hack/bench.sh <table|storm|multi> <CLUSTRAIL_SYNTHETIC spec> <out.json> [seconds]
# e.g. hack/bench.sh table pods=50000 bench-a-50k.json
# The app runs the scenario in its own WebView, reports to Go and quits. On
# Linux without a display it runs under xvfb-run. Go and WebView memory are
# sampled from the OS every second (RSS), since they are separate processes.
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

CLUSTRAIL_BENCH=$scenario CLUSTRAIL_SYNTHETIC=$spec CLUSTRAIL_BENCH_SECONDS=$seconds \
CLUSTRAIL_BENCH_OUT=$work/result.json CLUSTRAIL_CONFIG=$work/contexts.json XDG_CACHE_HOME=$work/cache \
KUBECONFIG=/dev/null timeout 900 "${run[@]}" >"$work/app.log" 2>&1 &
pid=$!

# RSS in MB: the Go process, and WebKit/WebView helper processes started for it.
echo "t,go_mb,webview_mb" >"$work/mem.csv"
t=0
while kill -0 $pid 2>/dev/null; do
  # (ps exits non-zero when nothing matches; that is not an error here)
  gomb=$( (ps -C clustrail -o rss= 2>/dev/null || true) | awk '{s+=$1} END {printf "%.0f", s/1024}')
  webmb=$( (ps -eo rss=,comm= 2>/dev/null || true) | awk '/WebKit|WebContent|msedgewebview2/ {s+=$1} END {printf "%.0f", s/1024}')
  echo "$t,$gomb,$webmb" >>"$work/mem.csv"
  sleep 1
  t=$((t + 1))
done
wait $pid || true

if [ ! -s "$work/result.json" ]; then
  echo "benchmark produced no result; app log:" >&2
  tail -30 "$work/app.log" >&2
  exit 1
fi
python3 - "$work/result.json" "$work/mem.csv" "$out" <<'PY'
import csv, json, sys
res = json.load(open(sys.argv[1]))
rows = list(csv.DictReader(open(sys.argv[2])))
def summary(key):
    v = [int(r[key]) for r in rows if r[key]]
    return {"max": max(v), "last": v[-1], "samples": len(v)} if v else None
res["osMemoryMB"] = {"go": summary("go_mb"), "webview": summary("webview_mb")}
json.dump(res, open(sys.argv[3], "w"), indent=2)
print(json.dumps({k: res[k] for k in res if k not in ("backendSamples",)}, indent=1)[:4000])
PY
