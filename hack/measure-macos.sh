#!/usr/bin/env bash
# Measures Clustrail on this Mac: builds the production app, runs the
# benchmark scenarios REPEAT times, and writes the raw results, this machine's
# details and a summary to docs/benchmarks/data/macos-<model>-<date>/.
#
#   hack/measure-macos.sh                          # every scenario, 3 runs each
#   REPEAT=5 hack/measure-macos.sh
#   SCENARIOS="idle table-10k" hack/measure-macos.sh
#
# For numbers worth comparing: keep the Mac on its power adapter, close other
# apps (Safari's WebKit processes are excluded, but they still use the CPU),
# and leave the Mac alone while it runs; a window opens and closes once per run.
# Needs Go, Node and python3. No sudo: idle wakeups and energy impact come
# from top(1).
set -euo pipefail
[ "$(uname)" = Darwin ] || { echo "this script is for macOS; hack/bench.sh runs elsewhere" >&2; exit 1; }
root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
REPEAT=${REPEAT:-3}
SCENARIOS=${SCENARIOS:-"idle table-10k table-50k storm-10k multi-20"}
model=$(sysctl -n hw.model 2>/dev/null | tr -c 'A-Za-z0-9,\n' '-' || echo mac)
out=${OUT:-docs/benchmarks/data/macos-${model}-$(date +%Y%m%d-%H%M)}
mkdir -p "$out"

for tool in go node npm python3; do
  command -v "$tool" >/dev/null || { echo "$tool is required" >&2; exit 1; }
done

echo "== building the production app"
(cd frontend && npm ci --no-audit --no-fund >/dev/null && npm run build >/dev/null)
go build -tags production -o bin/clustrail .

echo "== recording this machine"
python3 - "$out/machine.json" <<'PY'
import json, subprocess, sys
def sh(*cmd):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=30).stdout.strip()
    except Exception as e:
        return f"unavailable: {e}"
mem = sh("sysctl", "-n", "hw.memsize")
info = {
    "model": sh("sysctl", "-n", "hw.model"),
    "chip": sh("sysctl", "-n", "machdep.cpu.brand_string"),
    "cores": sh("sysctl", "-n", "hw.ncpu"),
    "memoryGB": round(int(mem) / 2**30) if mem.isdigit() else mem,
    "macOS": sh("sw_vers", "-productVersion") + " (" + sh("sw_vers", "-buildVersion") + ")",
    "power": sh("pmset", "-g", "batt"),
    "lowPowerMode": [l.strip() for l in sh("pmset", "-g").splitlines() if "lowpowermode" in l],
    "thermal": sh("pmset", "-g", "therm"),
    "displays": sh("system_profiler", "SPDisplaysDataType", "-detailLevel", "mini"),
    "commit": sh("git", "rev-parse", "HEAD") + (" (with local changes)" if sh("git", "status", "--porcelain") else ""),
}
json.dump(info, open(sys.argv[1], "w"), indent=2)
print(json.dumps({k: info[k] for k in ("model", "chip", "memoryGB", "macOS")}))
if "AC Power" not in info["power"]:
    print("warning: running on battery; results are not comparable with runs on the adapter")
PY

run() { # name scenario spec seconds
  local name=$1 scenario=$2 spec=$3 seconds=${4:-} i
  for i in $(seq 1 "$REPEAT"); do
    echo "== $name, run $i of $REPEAT"
    local toplog=""
    if [ "$scenario" = idle ]; then
      toplog="$out/$name-$i.top.log"
      # One sample every 2 s; the first sample of top has no CPU figures.
      top -l 0 -s 2 -stats pid,command,cpu,idlew,power -o cpu -n 60 >"$toplog" 2>/dev/null &
      local top_pid=$!
    fi
    hack/bench.sh "$scenario" "$spec" "$out/$name-$i.json" $seconds >/dev/null || echo "   run failed (see above)"
    if [ -n "$toplog" ]; then
      kill "$top_pid" 2>/dev/null || true
      wait "$top_pid" 2>/dev/null || true
      python3 - "$out/$name-$i.json" "$toplog" <<'PY' || echo "   could not read top's samples"
import json, re, sys, time
res = json.load(open(sys.argv[1]))
pids = set([res.get("pids", {}).get("app")] + res.get("pids", {}).get("webview", [])) - {None}
samples, stamp, interval = [], None, 2.0
for line in open(sys.argv[2], errors="replace"):
    m = re.match(r"^(\d{4}/\d{2}/\d{2} \d{2}:\d{2}:\d{2})", line)
    if m:
        stamp = time.mktime(time.strptime(m.group(1), "%Y/%m/%d %H:%M:%S")) * 1000
        samples.append({"t": stamp, "cpu": 0.0, "idlew": 0.0, "power": 0.0, "seen": 0})
        continue
    f = line.split()
    if not samples or len(f) < 5 or not f[0].isdigit() or int(f[0]) not in pids:
        continue
    try:
        cpu, idlew, power = float(f[-3]), float(f[-2]), float(f[-1])
    except ValueError:
        continue
    s = samples[-1]
    s["cpu"] += cpu; s["idlew"] += idlew; s["power"] += power; s["seen"] += 1
samples = samples[1:]  # the first sample has no rates
for ph in res.get("phases", []):
    inside = [s for s in samples if ph["startedAt"] <= s["t"] <= ph["endedAt"] and s["seen"]]
    if inside:
        n = len(inside)
        ph["top"] = {
            "samples": n,
            "cpuPercent": round(sum(s["cpu"] for s in inside) / n, 2),
            "idleWakeupsPerSec": round(sum(s["idlew"] for s in inside) / n / interval, 2),
            "power": round(sum(s["power"] for s in inside) / n, 2),
        }
json.dump(res, open(sys.argv[1], "w"), indent=2)
PY
    fi
    sleep 5 # let the machine settle between runs
  done
}

for s in $SCENARIOS; do
  case $s in
  idle) run idle idle "clusters=5,pods=2000" 60 ;;
  table-10k) run table-10k table "pods=10000" ;;
  table-50k) run table-50k table "pods=50000" ;;
  storm-10k) run storm-10k storm "pods=10000,rate=1000" 60 ;;
  multi-20) run multi-20 multi "clusters=20,pods=2500,rate=100,vary=1" 45 ;;
  *) echo "unknown scenario $s" >&2 ;;
  esac
done

python3 hack/bench-summary.py "$out" | tee "$out/summary.md"
echo
echo "Results: $out"
