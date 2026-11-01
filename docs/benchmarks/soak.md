# Soak and chaos results

`hack/envtest.sh` runs both suites against a real kube-apiserver and etcd
(envtest, Kubernetes 1.32, no kubelet). CI runs the chaos cases and a
30-cycle soak on every change.

## Soak: 200 cycles

Each cycle:

1. Connect the cluster.
2. Start a list watch.
3. Create and delete 10 pods with new names.
4. Wait until Clustrail shows exactly the API server's pods.
5. Stop the watch and disconnect.

200 pods stay in the namespace the whole time. Go heap after GC and
goroutines were sampled every 5 cycles, 300 ms after the disconnect.

| | Start | End | Over 41 samples |
|---|---|---|---|
| Go heap after GC | 3.79 MB | 3.84 MB | 3.83 – 3.88 MB |
| Goroutines | 6 | 6 | 6 at every sample |

The test fails if any goroutine started during the cycles is still running
at the end (goleak). It also fails on growth across the cycles: more than
3 goroutines or 8 MB of heap from the first sample to the last.

Before the fix in this change, goroutines went from 9 to 38 over 30 cycles
and the heap from 5.8 to 25.8 MB. The cause was the lookup of the
cluster's region after a connect. It slept up to 10 s without watching the
connection, kept the closed connection and its caches alive, and could
write the old connection's summary into a newer one.

Linux, 4 cores, Go 1.26. Raw samples: `SOAK_OUT=file.json`.

## Chaos cases

Each case breaks the path to the API server through a proxy. Clustrail
must report the loss: rows are marked stale, and the cluster never shows
as connected while it is not. Once the path is healed, Clustrail must end
with exactly the API server's pods.

| Case | What breaks | Found |
|---|---|---|
| Network partition, then 410 Gone | Connections drop. Pods change while cut off, and etcd compacts every second, so resumed watches get 410 Gone. | — |
| Requests that hang | The proxy accepts and never answers. | Watches opened while the server hung stayed open forever after it recovered. The probe, on a fresh connection, reported the cluster connected while its rows were frozen. Long-running requests now must start answering within 30 s. |
| Expired credentials, then renewed | Every request gets 401, then requests work again. | A successful probe never cleared the expired-credentials state, so a renewed token still showed as expired. |
| API server restart | The API server is killed and started on the same port. | — |

The suite also found a data race: the cluster list read a connection's
GitOps and RBAC details while the connection was still writing them.
