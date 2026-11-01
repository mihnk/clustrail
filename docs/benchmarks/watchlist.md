# Initial list: streaming lists (WatchList)

When a connection starts, its informers list every object in scope. With a
plain LIST, the whole response is decoded before the informer cache takes
over, so the Go heap briefly holds the list twice. Streaming lists
(WatchList) send the initial objects as watch events instead.

client-go 0.37 turns streaming lists on by default (`WatchListClient`,
default on since 1.35). It falls back to a plain LIST when the API server
does not support them, so Clustrail keeps the default. This measurement
checks that the default pays off and that the fallback works.

## Measurement

`internal/kube/watchlist_envtest_test.go` runs against envtest
(Kubernetes 1.32, `--feature-gates=WatchList=true` on the API server). It
uses 10,000 pods in one namespace, each with env vars, probes and a
last-applied annotation. It measures the Go heap, sampled every 5 ms, from
connect until the caches are filled. Linux, 4 cores; 2 runs per mode.

| Client | API server | Peak heap during the initial list | Heap after | Time to filled caches |
|---|---|---|---|---|
| streaming lists (default) | supports them | 74 / 79 MB | 58 / 60 MB | 0.95 / 1.04 s |
| plain LIST (`KUBE_FEATURE_WatchListClient=false`) | supports them | 145 / 146 MB | 62 / 62 MB | 0.99 / 1.01 s |
| streaming lists (default) | does not support them (fallback) | 178 MB | 62 MB | 0.99 s |

- Streaming lists halve the peak at connect: about 70 MB less for
  10,000 pods. The steady state and the time are the same.
- Against an API server without them, client-go falls back to a plain
  LIST. Every pod arrives, at the plain LIST's peak.
- Whether a cluster serves streaming lists depends on its version and
  feature gates. The 1.32 API server used here needed the `WatchList`
  gate turned on. Clusters without it use the fallback.

Decision: keep the client-go default. Do not set `WatchListClient=false`.
The cache transform (C4) applies to both paths.

To reproduce:

```bash
KUBEBUILDER_ASSETS=... KUBE_FEATURE_WatchListClient=true LIST_PODS=10000 \
  go test -tags envtest -run TestInitialListMemory -v ./internal/kube
```

Use `KUBE_FEATURE_WatchListClient=false` to compare with plain lists, and
`LIST_SERVER_WATCHLIST=false` to test against an API server without
streaming lists.
