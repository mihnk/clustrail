# Request budgets, retries and buffers

What Clustrail may ask of one cluster, how failures are retried, and which
buffers a cluster can fill. The code is `internal/kube/budget.go`; the tests
are `internal/kube/budget_test.go`.

## Budget per cluster

Every client of one connection (typed, dynamic, metrics, discovery, Helm)
shares one budget. Each connection has its own, so a slow cluster never
delays another.

| Limit | Value | Notes |
|---|---|---|
| Rate | 50 QPS, burst 100 | One token bucket for all clients; before, each client had its own. |
| Requests in flight | 16 | Held from the request until its body is closed. |
| Background lane | 8 of the 16 | Polls, probes and metrics. A click always finds a free slot. |
| Deadline | 60 s | Set on every short request that came without one. A hanging request ends and frees its slot. |
| API probe | 10 s | Before, a hanging `/readyz` blocked the probe loop forever, and the cluster still looked connected. |

Watches, followed logs, exec, attach and port forwarding are not counted.
They last as long as the user keeps them open.

Identical requests are coalesced in the UI. Views asking the same thing
share one request in flight (`frontend/src/lib/query.ts`, issue E5).
Repeated reads of watched kinds come from the informer caches and never
reach the API server.

## Retries

| Failure | What happens |
|---|---|
| 429, or 503 with `Retry-After` | client-go waits as the server asks and retries at most 10 times (11 requests). |
| 500, 502, or 503 without `Retry-After` | Returned once. The UI query layer retries reads twice with backoff and jitter. |
| 401, 403, 404, validation | Never retried, here or in the UI (`isPermanent`). |
| Connection lost | client-go retries reads whose connection reset, within the same bound. |
| Watch ends | The reflector re-lists with exponential backoff and jitter (client-go). |
| Poll list fails | Tried again at the next poll interval, never sooner. |
| Connect fails | Not retried automatically. A kubeconfig change, the user, or wake from sleep (B3) starts the next attempt. |
| A change whose result is unknown | Never replayed. The job ends as `unknown`, and the release or object is read back to judge it (D11). |

Twenty clusters behind one failing API server, connecting at once, make at
most 60 requests in all and no more after that
(`TestTwentyClustersReconnectingMakeBoundedRequests`).

## Buffers a cluster can fill

| Buffer | Bound |
|---|---|
| Informer caches | Objects in scope. The cache budget (Settings) watches the Go heap; C10 adds per-holder budgets. |
| Pod stream hub: pending changes per consumer | One entry per object (changes coalesce), so it is bounded by the objects in scope. Byte limits come with C9. |
| Generic list watch: events channel | 256 events; the producer waits, it never grows. |
| Generic list watch: batch | One entry per object per 500 ms. |
| Log lines between flushes | Flushed every interval. The per-stream line and byte budget comes with C11. |
| One log line | Cut at the scanner limit and marked (patch 60). |
| Exec input | 1 MiB per write (D10); terminal resizes buffer 4, the newest wins. |
| Stored Helm release | Decompressed up to 64 MiB, then refused. Before, a gzip bomb in a release Secret could expand without limit. |
| Text from the UI | Objects 3 MiB, manifests 8 MiB / 500 objects, kubeconfig 1 MiB (D10). |
| Storage and insight fan-out | At most 8 or 16 concurrent requests (semaphores). |

## Audit checklist

- [x] Every client of a connection shares one rate limiter and one concurrency budget.
- [x] Background work cannot take every slot.
- [x] Every short request has a deadline; the probe has its own.
- [x] Long-running requests are exempt and listed.
- [x] Permanent errors are not retried, by client-go or by the UI.
- [x] 429 and 503 honour `Retry-After`, bounded at 10 retries.
- [x] No change is replayed automatically.
- [x] No unbounded channel is fed by a cluster.
- [x] Decompression of cluster data is bounded.
- [ ] Byte limits on the stream hub and log streams: C9 and C11.
