# Performance architecture (M0)

This page covers the path a pod change takes from the Kubernetes API to a painted table row. It also covers what bounds each stage and how the app measures it. Pods are the only kind on this path so far. Every other kind still goes through the older `clustrail:delta` events (250 ms flush, see [backend.md](backend.md)).

Measured numbers are in [`docs/benchmarks/m0-results.md`](../benchmarks/m0-results.md).

## Pipeline

```text
 Kubernetes API                     synthetic provider (CLUSTRAIL_SYNTHETIC)
      │ list + watch (client-go)          │ deterministic adds/updates/deletes,
      ▼                                   │ restarts, disconnects, slow lists
 pod informer (one per cluster)           │
      │ publishPod(ns, name)              │
      ▼                                   ▼
 ┌──────────────────── streaming.Hub[PodRow] ─────────────────────┐
 │ topic per Key{cluster, kind, namespace, selector}              │
 │   one source per topic, ref-counted, stopped with the last     │
 │   consumer; rows kept for snapshots                            │
 │ consumer per subscription                                      │
 │   pending: map[id]op (last write wins, deletes kept)           │
 │   snapshot flag, connection state, oldest-change time          │
 └───────────────────────────────┬────────────────────────────────┘
                                 │ Take() every window (16–100 ms, adaptive)
                                 ▼
 sender per subscription: encode → frames (seq, snapshot chunks of 5,000)
                                 │ TrySend; on ErrFull keep the frames and retry
                                 ▼
 Wails 3 stream "clustrail.pods" (HTTP poll transport, 256 frames / 8 MB per window)
                                 ▼
 frontend/src/backend/podStream.ts
   per-subscription Map<id, PodRow>; seq check → resync on gap
   notify at most once per animation frame, and no sooner than the last
   render took (adaptive pacing)
                                 ▼
 store (allPods) → PodsWorkspace: filter → incremental sort → cached row
 model → virtualized ResourceTable (≈30–40 DOM rows) → ack after paint
```

### Why each stage looks the way it does

- **One watch per cluster.** Real clusters reuse the connection's existing pod informer; the hub only subscribes to it (`internal/kube/podstream.go`). Opening a second window or a second scope does not add an API watch. `TestPodSourceUsesTheConnectionInformer` counts the watches.
- **Shared topics.** Subscriptions with the same key share one source and one row cache. Each consumer keeps its own pending set, so a slow window cannot slow a fast one (`TestTopicsAreSharedAndStopWithTheLastConsumer`, `TestSlowSourceDoesNotDelayOthers`).
- **Coalescing instead of queues.** A consumer's backlog is a map keyed by row ID. Ten updates to one pod in a window become one, and a delete is never lost behind an upsert. Its size is bounded by the number of rows, not by the event rate. That is the backpressure: falling behind costs latency, never memory.
- **Bounded transport, no forced resync.** When the window's stream queue is full, `TrySend` fails. The sender keeps the already-encoded frames (sequence numbers included) and retries them every 10 ms before it takes anything newer. Meanwhile new changes fold into the pending map. An earlier version answered a stall that lasted more than 3 s with a full resync. That made an overloaded UI receive *more* data: 298 resyncs and 6,358 snapshots in one run of benchmark C. `TestStallMidSnapshotResumesWithoutResync` and the backpressure test now assert that a stall costs no snapshot.
- **Snapshot / resync.** A consumer's first batch is a snapshot. A source's `Replace` (initial list, re-list after 410 Gone or a reconnect) turns into a snapshot for every consumer. The client asks for a resync only when it sees a sequence gap.
- **Adaptive batching window.** The window is 16 ms when idle. It doubles up to 100 ms when a window carries more than 2,000 changes and halves when it carries fewer than 200. It goes to 100 ms while the transport is full.
- **Frontend pacing.** Frames are applied to plain `Map`s as they arrive, which is cheap (p95 ≤ 1 ms). React is notified at most once per animation frame, and never sooner than the previous render took, so an expensive table update cannot starve input and paint.
- **Keeping per-update work O(changes) where it was O(rows):**
  - `withoutUsage` and the stale-row mapping keep object identity for unchanged pods. Before this, a cluster without metrics-server copied every pod on every update, which defeated every memo downstream.
  - `podSorter` (`features/pods/sort.ts`) sorts only rows that are new objects and merges them into the previous order. The order is total (name, then ID break ties), so the result is identical to a full sort. A randomized check against `sortPods` covered this.
  - `cachedCoreRowModel` (`lib/rowModel.ts`) keys TanStack `Row` objects by the data object in a `WeakMap`. It builds `rowsById` only when something reads it. Under a 50k-pod storm this removed most of the garbage: GC fell from 31 % to 4 % of the profile.
  - Table rows are `memo` components with stable handlers and `contain: strict`. Only rows whose `Row` object changed re-render.

  O(n) passes remain per update: filtering, the sort merge, the row-model loop and the virtualizer's measurements. They are why update cost still grows with the row count; see *Known bottlenecks*.

## Connection states

Each subscription carries a state the UI shows next to the cluster:

| State | Meaning |
|---|---|
| `connecting` | source started, no list yet |
| `live` | listed and watching |
| `stale` | watch lost (network, credentials); rows are the last known, kept until a re-list succeeds and a probe passes |
| `disconnected` | the cluster is not connected, or this identity may not list pods (detail says which) |
| `error` | the subscription could not start |

410 Gone / expired resourceVersions are routine. The reflector re-lists, the rows converge, and the state stays `live`. `TestPodStreamRecoversFromWatchFailures` covers 410, connection refused, 401 and recovery against a fake API server.

## Measuring latency without mixing clocks

The Go and WebView clocks are never subtracted from each other.

- **Backend (Go clock):** `queue` = time from the oldest change in a batch to its send; `encode` = JSON encoding; `round` = from a frame's send to its ack.
- **UI (WebView clock):** each frame carries an opaque token. After the update that included the frame has painted (double `requestAnimationFrame`), the client acks the token with `ui` = receive→paint in its own clock.
- **Visible latency** ≈ `queue + (round − ui) / 2 + ui`, which is one-way transport estimated as half of the round trip minus UI time. It is an estimate, labelled as such.

Process numbers come from `internal/diagnostics` (heap, GC, goroutines, CPU via `getrusage`). `hack/bench.sh` adds OS-level RSS of the Go process and the WebKit helper processes, sampled every second.

## Tools

- **Diagnostics overlay:** ⌘⇧D / Ctrl+Shift+D. Shows backend stats, stream latency percentiles and frame times live.
- **Synthetic clusters:** `CLUSTRAIL_SYNTHETIC=clusters=N,pods=N,rate=N[,slow=1][,drop=1][,vary=1][,seed=N]`. Deterministic for a seed. `slow` delays every list by 5 s. `drop` disconnects every 20 s for 3 s. `vary` spreads sizes and rates from ½× to 2×.
- **In-app benchmarks:** `hack/bench.sh <table|storm|multi> <spec> <out.json> [seconds]`. Runs a scenario in the real WebView, writes JSON and quits.
- **Chromium comparison:** `CLUSTRAIL_BENCH_PODS=… npx playwright test e2e/bench.spec.ts` runs the same runner against a fake backend; `CLUSTRAIL_BENCH_PROFILE=out.cpuprofile` records a CPU profile.
- **Go microbenchmarks:** `go test -run - -bench . -benchmem ./internal/mock`.

## Security notes for this path

- Read-only: the pod stream has no write operations, and synthetic clusters refuse every action (`ErrSynthetic`).
- The kubeconfig is never modified. Synthetic clusters are never saved to settings.
- The stream runs over the Wails transport inside the app. No network listener is opened.
- The log records subscribe/close events at debug level (`CLUSTRAIL_DEBUG=1`) with cluster and scope only, never row contents or credentials.
- RBAC: a scope this identity may not list reports `disconnected` with the reason instead of failing silently.

## Known bottlenecks

See the results page for numbers. In order of impact:

1. **UI update cost still scales with visible-scope rows.** Each update re-runs filter, sort merge, row-model loop and virtualizer measurement over all rows: about 170 ms at 50k in Chromium and more in WebKitGTK without a GPU. Next step: keep filtered and sorted indexes incrementally in the store (apply deltas to the sorted array instead of rebuilding it), and give the virtualizer fixed row heights so it skips per-item measurement.
2. **WebKitGTK under Xvfb renders in software.** The native numbers here are a floor, not what a GPU-backed WebKit on macOS shows. macOS (WKWebView) and Windows (WebView2) were not measured.
3. **JSON over the HTTP poll transport.** Snapshot encode and parse are linear and fine at 50k (≈120 ms in Go). Above that, a binary or columnar encoding would help.
4. **The hub keeps a full row copy per topic** (≈380 B per pod, 18 MB at 50k) besides the informer cache. Building rows on demand from the informer would halve that.
