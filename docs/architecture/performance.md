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
 data/podStore.ts (external store; components subscribe to what they show)
   → PodsWorkspace (only while its tab is in front): view.ts filter (cached
   per row object) → incremental sort → cached row model → virtualized
   ResourceTable (fixed heights, ≈30–40 DOM rows) → ack after paint
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

## Frontend store and update cost (C1, C8, C6)

- **External pod store** (`data/podStore.ts`). Pods are no longer in the
  workspace context, so a pod frame no longer re-renders every component
  that reads the workspace. Components subscribe to what they show:
  - the sidebar to two counts;
  - an inspector to its pod's list;
  - the Pods table to its rows, and only while its tab is in front.

  A hidden view keeps the rows it had until it is shown again.
  `e2e/render-isolation.spec.ts` checks that 20 frames changing a pod's CPU
  render neither the sidebar, nor the tab strip, nor the Deployments view.
- **Incremental filter** (`features/pods/view.ts`). The filter's answer is
  cached per row object, and the sort merges only the new rows.
  `view.test.ts` checks random sequences of creates, updates, deletes,
  sort changes and query changes against a full recompute after every
  step.
- **Stable table layout.** Rows and group headers have fixed heights. The
  virtualizer's options now change only with the item count or the group
  layout, not with every data change. Keyboard positions come from the
  few header positions instead of an array over all rows.
- **Patches on the stream.** A change to a pod the window already has goes
  out as its changed fields (`Patchable` in `internal/streaming`). For
  1,000 pod updates (`BenchmarkPodDelta`):
  - JSON size drops from 407 to 70 bytes per change;
  - Go encoding takes 1.32 ms instead of 2.31 ms;
  - parsing and merging in the page takes about 0.6 ms instead of 2.4 ms.

  Shortening the keys was measured too and not adopted. It saved 25 % of
  the bytes but made parsing 30 % slower, because each row needs its keys
  mapped back.

Measured in Chromium (`e2e/storm.spec.ts`): a storm of 1,000 changes/s for
10 s, about 490 frames rendered, before and after these changes. The fake
transport sends whole rows, so the patch savings are not in these numbers.

| Pods | View in front | Receive → paint p50 / p95 | Script time in 10 s |
|---|---|---|---|
| 10,000 | Pods, before | 48 / 73 ms | 5.19 s |
| 10,000 | Pods, after | 28 / 53 ms | 4.63 s |
| 10,000 | another view, before | 60 / 82 ms | 5.03 s |
| 10,000 | another view, after | 24 / 36 ms | 1.25 s |
| 50,000 | Pods, before | 176 / 252 ms | 5.35 s |
| 50,000 | Pods, after | 130 / 187 ms | 5.23 s |
| 50,000 | another view, before | 224 / 323 ms | 5.55 s |
| 50,000 | another view, after | 22 / 36 ms | 3.88 s |

Rendering is paced: the next render waits as long as the last one took. A
cheaper render therefore shows up as lower latency and more headroom, not
always as less script time.

### C2: sorting and filtering in the backend (decision)

With the Pods table in front, 50,000 pods still take 130 ms from receive to
paint, against 48 ms for 10,000 pods before. The remaining cost is a few
linear passes per render, all over plain arrays: selecting the clusters'
pods, the filter loop, the sort merge, and the row model. The goal
"50k performs like 10k did" is not met yet.

Moving the query to the backend (Go keeps the indexes; the window receives
only the visible rows and the counts) would remove those passes and most
of the WebView's row memory. It also changes everything that reads the
full pod list in the page today:
- counts in the sidebar;
- node and Deployment inspectors;
- the palette;
- the log source picker;
- the Clusters overview.

The alternative is a Web Worker. It keeps the page's model but does not
reduce memory.

Next step: a backend query subscription for the Pods table only. Every
other reader moves to a counts or by-owner topic on the same hub. Measure
it with `e2e/storm.spec.ts` at 50k, and WebKit memory with
`hack/bench.sh`. Until then the issue stays open.

## Known bottlenecks

See the results page for numbers. In order of impact:

1. **UI update cost still scales with visible-scope rows** while the Pods table is in front: about 130 ms at 50k in Chromium (see the C2 decision above), more in WebKitGTK without a GPU. Other views no longer pay it.
2. **WebKitGTK under Xvfb renders in software.** The native numbers here are a floor, not what a GPU-backed WebKit on macOS shows. macOS (WKWebView) and Windows (WebView2) were not measured.
3. **JSON over the HTTP poll transport.** Updates now go as patches (70 bytes per change). Snapshots are still whole rows, linear and fine at 50k (≈120 ms in Go).
4. **The hub keeps a full row copy per topic** (≈380 B per pod, 18 MB at 50k) besides the informer cache. Building rows on demand from the informer would halve that.
