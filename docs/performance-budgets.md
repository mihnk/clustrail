# Performance and energy budgets

What "fast" and "light on the battery" mean for Clustrail, as numbers, with
how each one is measured and where it stands today. Every performance change
is judged against this page with a before and after measurement on the same
machine and workload.

Rules:

- **Speed is never bought with wrong or stale data.** A change that lowers
  CPU by delaying updates past the freshness budget, or by dropping them,
  does not count as a gain.
- **Energy and latency are measured separately.** Lower CPU % alone is not
  enough; energy per task (top's energy impact on macOS) must drop for the
  same work.
- **Idle FPS is not a metric.** A view that does not change should not draw
  at all; the idle benchmark counts DOM changes, timer and frame callbacks
  and wakeups instead.
- **Numbers are medians of at least 3 runs** (5 for a release decision),
  with the range, on a named machine, with the raw JSON kept in
  `docs/benchmarks/data/`.

These are starting budgets. They are finalized against the first macOS
baseline (Apple silicon, `hack/measure-macos.sh`); until then the current
values below come from a Linux VM without a GPU (software rendering under
Xvfb), which overstates rendering cost.

## Budgets

| Budget | Target | Current | Measured by |
|---|---|---|---|
| Input → paint, typical load (5 clusters, 10k pods, 100 changes/s) | p95 ≤ 100 ms, p99 ≤ 200 ms | search p95 271 ms, inspector p95 482 ms (native, 10k pods, Linux/Xvfb) | `hack/bench.sh table` |
| Input → paint, heavy load (20 clusters, 50k pods, 1,000 changes/s) | p95 ≤ 150 ms, p99 ≤ 300 ms | not measured in this combination | `hack/bench.sh multi` |
| Data freshness, change in Go → painted (API wait excluded) | typical p95 ≤ 250 ms, heavy p95 ≤ 750 ms | 282 ms p95 (10k pods, 1,000 changes/s); 3.4 s p95 (20 clusters) | `hack/bench.sh storm`, `multi` |
| Scrolling under heavy load, 60 Hz display | frame p95 ≤ 20 ms | 107 ms (native 10k, Linux/Xvfb); 33 ms (Chromium) | `hack/bench.sh table`, `storm` |
| Open a warm 10k-row table | p95 ≤ 300 ms | not measured separately yet | — |
| First 10k-row view, local deterministic source | p95 ≤ 1 s (cold and warm apart) | 1.06 s median, 1.05–1.06 (was 1.41 s, 1.21–1.65; native, Linux/Xvfb, [before](benchmarks/data/startup-linux-before/) / [after](benchmarks/data/startup-linux-after/)) | `hack/bench.sh table` |
| JavaScript parsed at start | ≤ 500 KB | 980 KB, 301 KB gzipped (was 1,396 / 421 KB); Turkish strings +112 KB only in Turkish | `npm run build` (index + App chunks) |
| Visible, 5 clusters, nothing changing | all app processes ≤ 1 % of one core | 9.2 % (Linux/Xvfb; was 12.2 %) — [idle results](benchmarks/idle-results.md) | `hack/bench.sh idle` |
| Background (hidden), no active log or terminal | all app processes ≤ 0.3 % of one core | **0.1 %** (was 1.5 %) | `hack/bench.sh idle` |
| Hidden window with no active job | zero periodic UI queries and zero paints after the pause | **0** page callbacks and DOM changes | `hack/bench.sh idle` (page callbacks, DOM changes) |
| Backend with a connected cluster, nothing changing | no timer loop wakes without work | only the 15 s probe, 3 s kubeconfig watch and 30 s budget check; 0.02 % of a core | `TestIdleConnectedCluster` (envtest) |
| Memory | after warm-up, Go heap and retained JS grow ≤ 5 % over 8 h; RSS tracked apart | not measured (soak test, D3) | — |
| Resource reclaim | after 200 open/close cycles, sessions, listeners, timers and watches back to baseline | not measured (D3) | — |
| Correctness under load | after load and disconnects, UID, resourceVersion and final state equal the source | equal after the 10k storm (checksum) | `hack/bench.sh storm` |

## Measuring

Build the production app first: `cd frontend && npm run build && cd .. && go build -tags production -o bin/clustrail .`

| What | Command |
|---|---|
| Idle, visible then hidden (60 s each) | `hack/bench.sh idle clusters=5,pods=2000 idle.json 60` |
| Large table | `hack/bench.sh table pods=10000 table.json` |
| Update storm | `hack/bench.sh storm pods=10000,rate=1000 storm.json 60` |
| Many clusters | `hack/bench.sh multi clusters=20,pods=2500,rate=100,vary=1 multi.json 45` |
| Everything on a Mac, 3 runs each, with machine details | `hack/measure-macos.sh` |
| Backend idle against a real kube-apiserver | `KUBEBUILDER_ASSETS=… go test -tags envtest -run TestIdleConnectedCluster -v ./internal/kube` |
| Summary of a results directory | `python3 hack/bench-summary.py <dir>` |

The idle scenario reports, per phase: CPU of every app process from the OS
(`os`), the Go process's CPU and voluntary context switches (wakeups), each
backend loop's wakeups, the page's timer, interval and animation-frame
callbacks, DOM changes and where they happen, and Wails events. On macOS,
`hack/measure-macos.sh` adds top(1)'s idle wakeups and energy impact for the
app and its WebKit processes.

Measurement overhead: the diagnostics overlay (⌘⇧D) draws every frame, so the
idle scenario runs without it; the counters themselves are one atomic add per
loop wakeup and one increment per page callback, installed only in a
benchmark.
