# M0 benchmark results

These are the measured results for the M0 streaming pipeline. Everything here was measured on one machine. Nothing was extrapolated, and anything not measured is listed under *Not verified*. Raw JSON for each run is in [`data/`](data/). The architecture is described in [`docs/architecture/performance.md`](../architecture/performance.md).

## Environment

| | |
|---|---|
| CPU | 4 vCPU, Intel Xeon @ 2.8 GHz (cloud VM) |
| Memory | 15 GB |
| OS | Linux 6.18 |
| Toolchain | Go 1.26.0, Node 22.22 |
| Native app | production build, WebKitGTK 6 / GTK 4.14 under **Xvfb, no GPU** (software rendering), window 1440×900 |
| Chromium comparison | Playwright 1.63 headless Chromium, same frontend build, fake backend in the page |

**Caveat:** Xvfb has no GPU and caps the native frame rate. Even an idle table draws at about 24–31 fps here. The native frame rates below are therefore a floor for this environment, not a prediction for macOS (WKWebView) or Windows (WebView2), which were not measured. The Chromium numbers use the same UI code with a GPU-less but faster compositor. They show what the JavaScript side costs.

Commands (from the repository root, after `go build -tags production -o bin/clustrail .`):

```bash
hack/bench.sh table pods=10000 native-a-10k.json
```

```bash
hack/bench.sh table pods=50000 native-a-50k.json
```

```bash
hack/bench.sh storm pods=10000,rate=1000 native-b-10k.json 60
```

```bash
hack/bench.sh multi clusters=20,pods=2500,rate=100,vary=1,slow=1,drop=2 native-c.json 45
```

```bash
cd frontend && CLUSTRAIL_BENCH_PODS=50000 CLUSTRAIL_BENCH_SCENARIO=storm CLUSTRAIL_BENCH_SECONDS=60 CLUSTRAIL_BENCH_OUT=out.json npx playwright test e2e/bench.spec.ts
```

## Go microbenchmarks

`go test -run - -bench . -benchmem ./internal/mock`

| Benchmark | Result |
|---|---|
| One change through hub + coalescing + batch (10k rows) | 5.6 µs/op, 1.5 KB, 5 allocs |
| Snapshot encode, 10k pods | 19 ms, 3.7 MB JSON (383 B/pod) |
| Snapshot encode, 50k pods | 99 ms, 18.3 MB JSON |
| Generate 50k synthetic pods | 126 ms |

## A — Large table (one cluster)

| | Native 10k | Native 50k | Chromium 10k | Chromium 50k |
|---|---|---|---|---|
| Time to first full table | 1.9 s | 2.5 s | 0.15 s | 1.5 s |
| DOM rows | 37 | 37 | ≈37 | ≈37 |
| Idle fps | 24.5 | 31.2 | 60.3 | 59.0 |
| Steady scroll fps (p95 frame) | 11.5 (107 ms) | 10.9 (128 ms) | 48.2 (33 ms) | 47.6 (33 ms) |
| Jump scroll fps (p95 frame) | 7.9 (236 ms) | 8.1 (161 ms) | 26.3 (67 ms) | 23.0 (67 ms) |
| Search, keystroke → painted (p50 / p95) | 203 / 271 ms | 294 / 486 ms | 86 / 99 ms | 144 / 283 ms |
| Sort Status / Restarts / Age (p50) | 165 / 153 / 181 ms | 409 / 357 / 312 ms | 58 / 74 / 59 ms | 171 / 231 / 93 ms |
| Open inspector (p50 / p95) | 231 / 482 ms | 254 / 465 ms | 95 / 118 ms | 94 / 125 ms |
| Go heap | 24 MB | 93 MB | — | — |
| RSS: Go process / WebKit processes | 440 / 752 MB | 519 / 1156 MB | — | — |

The Go process RSS includes the GTK/WebKit UI host, which runs in-process. The Go heap is the number the backend controls.

Before M0 the native 50k table did not finish loading within the runner's 30 s timeout.

## B — Update storm (10k pods, 1,000 changes/s, 60 s)

| | Native 10k | Chromium 10k | Chromium 50k |
|---|---|---|---|
| Frame rate during storm | 15 fps | 52.7 fps | 31.8 fps |
| Scroll during storm | 7.6 fps | 37.3 fps | 23.8 fps |
| UI update cost (p50 / p95) | 80 / 134 ms | 32 / 53 ms | 172 / 248 ms |
| Receive → painted (p50 / p95) | 140 / 282 ms | 59 / 105 ms | 340 / 520 ms |
| Backend queue, change → send (p50 / p95) | 12.7 / 17.2 ms | — | — |
| Encode per frame (p95) | 0.33 ms | — | — |
| Change → visible, estimated (p50 / p95) | 180 / 369 ms | — | — |
| Sequence gaps / resyncs / send-full | 0 / 0 / 0 | 1* / 0 / 0 | 1* / 0 / 0 |
| Consistency after the storm (count and checksum, UI vs Go) | equal (10,111 rows) | equal | equal |
| Go heap over 60 s | 22–34 MB sawtooth, no growth | — | — |
| Goroutines | 18–19, stable | — | — |
| Go CPU | ≈60 % of one core (generator included) | — | — |
| WebKit RSS | 1.3 GB | — | — |

\* Chromium runs use a fake backend written for the tests. Its one gap was answered by a resync, and the final state matched. The real backend produced no gaps in native runs. The fake's gap was not investigated further.

Progress during M0 (native B, same settings): receive→paint p50 went from 409 to 140 ms, UI update cost p50 from 228 to 80 ms, and frame rate from 11 to 15 fps. The causes, as found by CPU profiles of the 50k Chromium storm:

- Garbage collection fell from 31 % to 4 % of the profile.
- Pod objects were copied on every update for clusters without metrics.
- The core row model was rebuilt on every update.
- A full sort ran on every update.

## C — 20 clusters (2,500 pods each, ½×–2× varied, 100 changes/s each, one slow, two dropping)

| | After M0 fixes | Before (first run) |
|---|---|---|
| Rows in the UI | 61,246 | 56,237 |
| Per-cluster time to first rows | 147–390 ms (slow cluster: list delayed 5 s by design) | ≈300 ms |
| Resyncs / snapshots sent | **0 / 44** | 298 / 6,358 |
| Transport full (retries) | 49,576 | 8,582 |
| Backend queue (p50 / p95) | 14 ms / 410 ms | — / 2.5 s |
| UI update cost (p50 / p95) | 543 / 1,594 ms | 1,243 ms p50 |
| Receive → painted (p50 / p95) | 1.5 s / 3.4 s | 2.8 s p50 |
| Change → visible, estimated (p50) | 2.75 s | 13 s |
| Frame rate | 4.9 fps | 0.7 fps |
| Go heap | 95–210 MB | 140–270 MB |
| Goroutines | 56–58, stable | 57 |
| WebKit RSS | 2.6 GB | 3.8 GB |

The pipeline now degrades as designed under overload. Latency grows, the transport retries, and no snapshot storm or unbounded memory follows. The disconnecting clusters report `disconnected` and come back.

**Not acceptable yet:** 61k rows at this change rate in software-rendered WebKitGTK still gives multi-second latency and single-digit fps. The bottleneck is the UI's per-update O(n) work (see *Known bottlenecks* in the architecture doc).

## D — Reconnection and lifecycle (automated tests)

| Case | Test | Result |
|---|---|---|
| 410 Gone (expired resourceVersion) | `TestPodStreamRecoversFromWatchFailures` | re-list; rows converge (an unseen add and an unseen delete reconciled); state stays live |
| Network loss (connection refused) | same | scope goes stale; rows kept |
| Expired credentials (401) | same | stays stale through failed re-lists; rows kept |
| Recovery | same | rows converge to the server (create and delete during the outage both applied); live after a good probe |
| Slow API in one cluster | `TestSlowSourceDoesNotDelayOthers` | other cluster's first rows in ≈20 ms while the slow one takes 2 s |
| Transport stall mid-snapshot | `TestStallMidSnapshotResumesWithoutResync` | snapshot resumes; changes made during the stall arrive; 0 gaps, 0 resyncs |
| Backpressure under 20k changes | `TestServeStaysConsistentUnderLoadAndBackpressure` | final state equal, 0 gaps, 1 snapshot total |
| 200× subscribe/unsubscribe | `TestRepeatedSubscribeUnsubscribeLeaksNothing` | every source stopped, goroutines back to baseline |
| App shutdown (3 windows × 20 clusters) | `TestShutdownStopsEverything` | all sources and handlers stop, goroutines back to baseline |
| One watch per cluster | `TestPodSourceUsesTheConnectionInformer` | exactly one pod watch; disconnect reported |
| Synthetic disconnects | native C run (`drop=2`) | clusters reported disconnected, then re-snapshotted |

All pass under `go test -race`. `TestPodStreamRecoversFromWatchFailures` was repeated 4 times without a failure. It takes about 10 s because client-go's reflector backs off between re-lists.

## Not verified

- macOS (WKWebView) and Windows (WebView2): no measurements. The Linux numbers do not transfer.
- A GPU-backed Linux desktop: all native runs used Xvfb.
- A real cluster at 10k+ pods: real-cluster streaming was tested against client-go's fake API server and by hand on small clusters, not at benchmark scale. Real API latency, watch bookmarks and apiserver throttling were not measured.
- More than one window on the same stream: covered by unit tests (shared topics), not by a native benchmark.
- Memory over hours: the longest run was 60 s (B). It showed no heap growth, but that is not a soak test.
