# Memory holders

Everything Clustrail keeps in memory, who owns it, how long it lives and
what drops it. `MemoryStats` (Settings › Memory) reports:

- the Go heap, where the caches live and which the cache budget checks;
- the Go process's resident memory;
- on Linux, the whole app with its WebKitGTK processes. On macOS WebKit
  runs outside the app's process tree, so Activity Monitor is the place to
  look;
- a count for each holder below.

## Backend (Go)

| Holder | Owner | Lives | Dropped when |
|---|---|---|---|
| Informer caches (pods, Deployments, ReplicaSets, nodes, events…) | connection | while connected | disconnect, target change, cache budget (unselected clusters first), pause in background |
| Rows built from them | connection | while connected | with the informers; a deleted object's row at once |
| Stream hub topics | hub, per subscription key | while a window subscribes | the last consumer leaves (tested) |
| Stream consumer queues | consumer | until sent | sent, or dropped for a snapshot past `MaxPending` changes (C9) |
| Encoded frames waiting for the window | sender | until sent | sent; at most one batch, retried with backoff |
| Generic list watches | list watch id | while its tab is open | tab closed, disconnect |
| Metric series | connection | 120 samples per container, saved for 24 h | the pod is gone; disconnect |
| Alert state | connection | while the object is wrong | it recovers or is deleted (tested under churn) |
| Recent alerts | notifier | last 50 | older ones |
| Background jobs | registry | running, and the last 30 results | older results |
| Log lines between flushes | log stream | one flush interval | flushed to the window |
| Exec sessions, port forwards | manager | until closed | closed, disconnect |
| Stored Helm releases | read on demand | one request | after the request; decompressed up to 64 MiB |
| Discovery | discovery client | no cache kept | — |

## Frontend (WebView)

| Holder | Owner | Lives | Dropped when |
|---|---|---|---|
| Pod rows | pod stream store | while subscribed | unsubscribe; a snapshot replaces everything |
| Other rows (Deployments, nodes, Helm, GitOps) | workspace | while the cluster is connected | disconnect, deselect |
| Log lines | log tab | its line limit, within the total log memory (Settings) | trimmed from the oldest; tab closed |
| Query results (`lib/query.ts`) | the view that asked | while the view is mounted | unmount, key change |
| Tabs and their state | workspace, saved in local storage | until closed | closed |
| Monaco editors, terminals | their tab | while open | disposed with the tab |

## Over budget

The cache budget never drops data from a selected cluster behind the
user's back.

1. Over budget, connected clusters that are not selected are disconnected,
   the largest first. A notice names each one.
2. If only selected clusters are left, a notice says how far over the
   budget it is. It also names the cluster that caches the most and what
   frees the most: showing one namespace there, or deselecting it.
