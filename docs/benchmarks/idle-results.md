# Idle results

What Clustrail costs while nothing changes, measured with the idle scenario
(`hack/bench.sh idle`) and, for the backend with a real cluster,
`TestIdleConnectedCluster` (envtest). Budgets are in
[performance-budgets.md](../performance-budgets.md).

**Machine:** 4 vCPU Intel Xeon @ 2.8 GHz cloud VM, 15 GB, Linux 6.18, WebKitGTK 6
under **Xvfb without a GPU** (software rendering). Rendering costs more here
than on a Mac with a GPU; the differences between builds are what matter.
macOS numbers come from `hack/measure-macos.sh`.

**Workload:** 5 synthetic clusters × 2,000 pods with no changes, the Pods tab
open, 60 s visible then 60 s hidden, 3 runs (median and range).

## Before (patch 54)

| | Visible | Hidden |
|---|---|---|
| CPU, all app processes (OS) | 12.2 % of a core (11.7–13.8) | 1.5 % (1.4–1.9) |
| Go process wakeups (voluntary context switches) | 51 /s (50–52) | 10 /s (10–11) |
| Page timer and frame callbacks | 0.2 /s | 0.2 /s |
| DOM changes | 1.3 /s | 1.0 /s |
| Backend loop wakeups (synthetic clusters) | kubeconfig watch 0.33 /s, cache budget 0.03 /s | same |
| Memory, Go / WebView processes | 396 / 671 MB | — |

What still happens while nothing changes:

- **Made-up CPU values in the desktop app.** An interval meant for the
  browser preview's mock data also ran in the desktop app: every 5 s it
  changed the CPU of about one in nine healthy pods to a random value and
  re-rendered the whole workspace. It is the 0.2 /s timer and the DOM
  changes above (each re-render rewrites the filter inputs).
- **Backend loops with a connected cluster** (envtest, 2,000 pods, nothing
  changing): the row flush wakes 4 times a second, the Helm flush once a
  second, with nothing to send; the API probe (every 15 s), the kubeconfig
  watch (every 3 s) and the cache budget (every 30 s) are periodic by
  nature. Go process: 0.13 % of a core, 27 context switches/s
  ([raw](data/idle-linux-before/envtest-connected-cluster.json)).
- Not found: no animation-frame loop, no Wails events, no polling of the
  Wails stream (its poll is held for 20 s). The diagnostics overlay, which
  benchmarks used to open, draws every frame (its FPS meter) and was the
  only frame loop; the idle scenario runs without it.

Raw results: [data/idle-linux-before/](data/idle-linux-before/).
