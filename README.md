# Clustrail

A free, open-source Kubernetes desktop workspace. Clustrail connects to your
clusters with your own kubeconfig. It needs no in-cluster agent, no account and
no SaaS backend.

Website: [clustrail.mihnk.org](https://clustrail.mihnk.org) (source in `website/`).

> **Status:** early development. The desktop app connects to the contexts in
> your kubeconfig. Opened in a plain browser (Vite dev server), the UI runs on
> mock data instead and the status bar says `MOCK DATA`.

The interface is in English and Turkish (Settings › Appearance › Language;
System follows the OS language).

## Stack

| Layer | Technology |
|---|---|
| Native backend | Go, client-go, Helm SDK (rollback) |
| Desktop runtime | Wails 3 |
| Frontend | React + TypeScript, Vite |
| Styling | Tailwind CSS 4 with semantic design tokens |
| UI primitives | Radix UI (shadcn/ui-style components) |
| Icons | Lucide |
| Resource tables | TanStack Table + TanStack Virtual |
| Charts | uPlot |
| Terminal / YAML | xterm.js / Monaco Editor |

The frontend never talks to a Kubernetes API server. Cluster access, watches,
caching, exec and log streams belong to the Go backend, which the UI reaches
through one Wails service (`internal/app.Workspace`) and its events.

## How the backend works

- **Kubeconfig** (`internal/kube/kubeconfig.go`): `KUBECONFIG` or
  `~/.kube/config` plus files added in Clustrail, merged with kubectl's
  first-file-wins rule. Files are polled for changes; contexts that appear
  later show as *New* and are never connected automatically. The kubeconfig is
  never written.
- **First-run setup** (`setup.go`): a fresh install starts with five steps:
  the kubeconfig files found (or, when there are none, choosing, pasting or
  creating one), the contexts to show, environment and protection (suggested
  from the context, cluster or server name; a context without a hint must be
  chosen), and a parallel connection test. A pasted kubeconfig becomes a new
  file, `~/.kube/clustrail-pasted.yaml` (0600); existing kubeconfig files are
  never written. Settings › Run setup again repeats it.
- **Settings** (`settings.go`): group, protection (Standard · Protected ·
  Read-only) and hidden contexts live in `~/.config/clustrail/contexts.json`.
  Read-only is enforced in Go for every change, every shell and every port
  forward (a forwarded port reaches the application, which can change data);
  viewing (logs, YAML, events) stays available. It is a guard
  against mistakes, not a substitute for RBAC.
- **Connections** (`manager.go`, `cluster.go`): one connection per context.
  Connect probes `/version`, identity (SelfSubjectReview) and metrics.k8s.io,
  checks list permission per resource (SelfSubjectAccessReview) and starts
  shared informers for pods, deployments, replicasets, nodes and HPAs. When an
  identity may not list a resource cluster-wide, the context's namespace (or
  `default`) is watched instead and the UI says so. Exec
  plugins never prompt: expired credentials surface with the command to run in
  your own terminal. A lost watch marks the cluster *reconnecting* with stale
  rows until a probe succeeds.
- **Rows** (`convert.go`): pod, deployment and node rows follow kubectl's status
  logic. Changes are sent to the UI as deltas at most every 250 ms
  (`clustrail:delta`), never as full lists. Informer indexes (pods by node,
  ReplicaSets by owner) keep a change to one object from rebuilding unrelated
  rows.
- **Pod stream** (`internal/streaming`, `podstream.go`): pods take a faster
  path over a Wails stream (`clustrail.pods`). There is one shared
  subscription per cluster and scope, coalesced batches every 16–100 ms,
  sequence numbers with snapshot/resync, and bounded backpressure. The pod
  informer is reused, so no second watch is opened. See
  [docs/architecture/performance.md](docs/architecture/performance.md) and the
  measured results in [docs/benchmarks/m0-results.md](docs/benchmarks/m0-results.md).
- **Secrets** (`secrets.go`): like Lens, keys and sizes are shown and values
  stay hidden until you reveal one key; the log records who revealed which
  key, never the value. In YAML each value reads `(hidden, N bytes)`; an edit
  that keeps the placeholder keeps the live value.
- **Other kinds** (`generic.go`): any kind the cluster serves, CRDs included,
  is listed with the API server's own table columns (what `kubectl get`
  prints), deleted with background propagation, or created from YAML.
- **Metrics** (`cluster.go`, `samples.go`): metrics-server is polled every 15 s
  (Settings). It has no history, so Clustrail keeps its own samples for 2 hours
  in the user cache directory, across restarts, and charts say where they come
  from.
- **Actions** (`actions.go`, `yaml.go`, `helm_actions.go`): delete, rollout
  restart, scale, rollback (like `kubectl rollout undo`), pause, cordon, drain
  through the Eviction API (PDBs respected, refused evictions retried),
  server-side apply with dry run and resourceVersion conflicts, Helm rollback
  with the Helm SDK, Argo CD refresh/sync and Flux reconcile/suspend.
- **Log sources** (`logsources.go`): a Logs tab follows a workload, a label
  selector or fixed pods, in any mix. Selector sources are matched again every
  3 s: pods that start later join the stream and pods that go away leave it,
  each with an inline marker. At most 30 pods are followed (Settings › Logs),
  the newest first; the tab says how many were skipped.
- **Streams** (`streams.go`, `portforward.go`): follow logs per container
  (reconnecting across container restarts), interactive exec over WebSocket
  with SPDY fallback (a dropped shell reconnects with backoff), and port
  forwards to a pod, or a ready pod behind a Service or Deployment, that
  re-resolve the pod and keep their local port when it goes away.
- **Workloads** (`workloads.go`): StatefulSets and DaemonSets restart like
  `kubectl rollout restart`; StatefulSets scale through the scale
  subresource; a CronJob runs now (`kubectl create job --from`, owned by the
  CronJob) or is suspended and resumed; a Job lists its attempts, one pod per
  retry, with exit codes and the reason it stopped.
- **Debugging** (`debug.go`): a debug container is an ephemeral container
  (`kubectl debug POD`, with `--target` and the same profiles); it cannot be
  removed, and the dialog says so. A node shell is a privileged pod pinned to
  the node with the host's PID, network and IPC namespaces and its root at
  `/host`; it is deleted when the shell closes or Clustrail quits. Read-only
  contexts offer neither; production and protected contexts ask for the
  context name.
- **Checks** (`insights.go`): Warning events across the selected clusters
  (the context's namespace when RBAC denies cluster-wide); certificates and
  tokens with an end date (the kubeconfig's client certificate or JWT, the API
  server's certificate, every `kubernetes.io/tls` Secret; only names and dates
  leave the backend); and an access matrix per namespace from
  (Self)SubjectAccessReviews, with the bindings that name the identity.
- **Update method** (`cluster.go`, `generic_watch.go`): informers and watches by
  default; in poll mode (Settings) every resource is listed every 30 s
  instead. After 5 minutes in the background watches pause and resume with a
  full re-list; clusters with an open log stream, shell or port forward stay
  connected. An optional cache budget disconnects connected clusters that are
  not selected when the Go heap grows past it.
- **Log** (`internal/app/logging.go`): `clustrail.log` in the user cache
  directory (5 MB, one rotated file) records connections, errors and every
  change Clustrail makes to a cluster, never Secret values, YAML bodies, log
  lines or shell input. Settings › Privacy & diagnostics shows it.
- **PATH** (`internal/app/env.go`): apps started from Finder or a desktop
  launcher get a minimal PATH, so the login shell's PATH is read at startup and
  exec auth plugins (`aws`, `gke-gcloud-auth-plugin`, `kubelogin`) are found.
- **Helm and GitOps** (`helm.go`, `gitops.go`): releases are read from Helm's
  storage Secrets (values with credential-like keys redacted); Argo CD
  Applications and Flux Kustomizations/HelmReleases from their CRDs when served.

## Layout

```text
main.go                       Wails application, window and Workspace service
internal/app/                 Wails service: the API the frontend calls
internal/kube/                Kubeconfig, connections, informers, rows, actions, streams
internal/streaming/           Hub (shared subscriptions, coalescing), stream protocol, latency stats
internal/mock/                Deterministic synthetic pod provider for benchmarks
internal/diagnostics/         Process stats (CPU, heap, GC, goroutines)
hack/bench.sh                 In-app benchmarks against synthetic clusters
website/                      Product page (Astro, deployed to Cloudflare Workers)
docs/                         Performance architecture and benchmark results
build/                        App icon, macOS Info.plist, Windows installer (NSIS), Linux .desktop
hack/kind-smoke.sh            Local kind cluster with workloads that exercise the app
frontend/
  src/styles/index.css        Design tokens (dark + light) and Tailwind theme
  src/app/                    App shell, workspace state, preferences
  src/components/ui/          Button, Tabs, Segmented, menus, TextField, Banner, …
  src/components/status/      StatusGlyph, ResourceStatus, EnvironmentBadge, …
  src/components/shell/       WindowToolbar, ClusterNavigation, NavigationRail, StatusBar
  src/components/resource-table/    Virtualized ResourceTable (grouping, row menus)
  src/components/resource-actions/  Observe / Modify action menus
  src/components/safety/      ConfirmationDialog, ProtectedContextBar
  src/components/charts/      MetricsChart (uPlot)
  src/features/pods/          Pods explorer and inspector
  src/features/deployments/   Deployments list and restart flow
  src/features/investigation/ Investigation workspace
  src/features/insights/      Warning events, Certificates, Access
  src/features/debug/         Debug container and node shell dialogs
  src/features/…               Clusters, Nodes, Logs, Shell, YAML, Compare, Helm, GitOps, Connections, Settings
  src/backend/                Wails client, desktop-mode detection, on-demand data hooks
  src/app/desktop.ts          Snapshot + delta sync and backend actions (desktop mode)
  src/data/                   View-model types and mock data (browser mode)
  src/i18n/                   t()/tn() and the Turkish strings (tr.ts); English text is the key
  e2e/                        Playwright tests (browser preview and desktop mode with a faked backend)
```

## Development

Requirements: Go 1.26+, Node 22+. On Linux you also need the GTK 4 and
WebKitGTK 6 development packages, for example
`sudo apt install libgtk-4-dev libwebkitgtk-6.0-dev`.

```bash
cd frontend && npm install && npm run build && cd ..
```

Run the desktop app against the Vite dev server (hot reload):

```bash
cd frontend && npm run dev
```

```bash
FRONTEND_DEVSERVER_URL=http://localhost:9245 go run .
```

You can also open the UI alone at http://localhost:9245 in a browser; without
the Go side it runs on mock data.

Production build (embeds `frontend/dist`):

```bash
cd frontend && npm run build && cd .. && go build -tags production -o bin/clustrail .
```

Checks:

```bash
cd frontend && npm run typecheck
```

```bash
go vet ./... && go test -race ./internal/...
```

The Go tests run the informers, actions and Helm/GitOps readers against
client-go's fake clientsets; no cluster is needed.

End-to-end tests run the production build in Chromium. Desktop mode is tested
against a faked Wails transport answering from `frontend/e2e/fixtures/desktop.json`,
which the Go converters produce:

```bash
cd frontend && npm run build && npx playwright install chromium && npm run e2e
```

```bash
CLUSTRAIL_FIXTURE=$PWD/frontend/e2e/fixtures/desktop.json go test -run TestWriteUIFixture ./internal/kube
```

### Performance and synthetic clusters

Synthetic clusters stand in for real ones (read-only, never saved):

```bash
CLUSTRAIL_SYNTHETIC=clusters=3,pods=10000,rate=1000 bin/clustrail
```

Spec keys: `clusters`, `pods` (per cluster), `rate` (changes/s per cluster),
`slow=1` (5 s lists), `drop=1` (disconnect every 20 s for 3 s), `vary=1`
(sizes and rates from ½× to 2×), `seed`. Press ⌘⇧D (Ctrl+Shift+D) for the
diagnostics overlay: backend queue and encode times, stream latency, frame
times, heap and goroutines.

Benchmarks run a scenario in the real app window, write JSON and quit (under
`xvfb-run` on Linux without a display):

```bash
hack/bench.sh table pods=50000 bench-a.json
```

```bash
hack/bench.sh storm pods=10000,rate=1000 bench-b.json 60
```

```bash
hack/bench.sh multi clusters=20,pods=2500,rate=100,vary=1,slow=1,drop=2 bench-c.json 45
```

```bash
go test -run - -bench . -benchmem ./internal/mock
```

### Against a real cluster

`hack/kind-smoke.sh` creates a three-node [kind](https://kind.sigs.k8s.io)
cluster with workloads that exercise the app: a healthy Deployment guarded by
a PodDisruptionBudget, a crash-looping one, a Helm release whose last
revision failed (when `helm` is installed), metrics-server, and a second
context `clustrail-smoke-team-a` that may only see the `team-a` namespace.
It needs Docker, `kind` and `kubectl`, and prints what to check in the app.

```bash
hack/kind-smoke.sh
```

```bash
hack/kind-smoke.sh down
```

## Releases

Pushing a tag `vX.Y.Z` runs `.github/workflows/release.yml`: a universal macOS
app (`.dmg` and `.zip`), a Windows installer and portable `.exe`, and a Linux
tarball, attached to a draft GitHub release with `SHA256SUMS`. macOS builds are
signed and notarized when the signing secrets listed in the workflow are set;
otherwise they are ad-hoc signed.

## License

Apache License 2.0, see [LICENSE](LICENSE). Contributions are welcome, see
[CONTRIBUTING.md](CONTRIBUTING.md).
