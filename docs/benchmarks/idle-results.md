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
| Memory, Go / WebView processes (max) | 402 / 671 MB | — |

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

## After (patch 55)

The mock interval runs only with mock data; the backend's row, Helm, GitOps
and log flushes stop when they have nothing to send and wake on the next
change; list watches arm a timer on their first change; the frontend polls
only while the window is visible; the shell's countdown ticks only while a
session reconnects.

| | Visible | Hidden |
|---|---|---|
| CPU, all app processes (OS) | **9.2 %** of a core (6.8–10.0), was 12.2 % | **0.1 %** (0.1–0.1), was 1.5 % |
| Go process wakeups | 50 /s (36–50), was 51 | 11.5 /s (10.5–11.9), was 10 |
| Page timer and frame callbacks | **0 /s**, was 0.2 | **0 /s**, was 0.2 |
| DOM changes | **0 /s**, was 1.3 | **0 /s**, was 1.0 |
| Memory, Go / WebView processes (max) | 450 / 544 MB | — |

With a cluster connected to a real kube-apiserver (envtest, 2,000 pods,
nothing changing), the Go process went from 0.13 % to **0.02 %** of a core
and from 27 to **5.7** context switches per second; the row flush (4 /s)
and the Helm flush (1 /s) no longer wake. What still wakes is periodic by
nature: the API probe every 15 s, the kubeconfig watch every 3 s, the cache
budget every 30 s
([raw](data/idle-linux-after/envtest-connected-cluster.json)).

Typed clients now decode protobuf: a list of 10,000 pods decodes in about
55 ms instead of 230 ms, with 12 % fewer allocations
(`go test -run - -bench Decode -benchmem ./internal/kube`).

Still open: while the window is visible and nothing changes, the Go process
uses 3–4 % of a core and wakes about 50 times a second. On Linux, WebKitGTK's
UI process runs inside it, and strace shows where the time goes: WebKit's
memory-pressure monitor reading `/proc/self/cgroup` (one byte per read),
`/proc/meminfo`, `/proc/zoneinfo` and the cgroup memory limits, the GTK main
loop's eventfds, and the Go runtime reading the cgroup CPU quota. None of it
is Clustrail's code (no backend loop, page callback or DOM change runs); the
macOS run will show what WebKit costs there.

Raw results: [data/idle-linux-after/](data/idle-linux-after/).
