# How Clustrail works

The desktop app is a Go backend (Wails 3) and a React frontend. This page
describes the backend file by file, the stack and the source layout. The pod
fast path is described in [performance.md](performance.md).

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

## Backend

- **Kubeconfig** (`internal/kube/kubeconfig.go`): `KUBECONFIG` or
  `~/.kube/config` plus files added in Clustrail, merged with kubectl's
  first-file-wins rule. Files are polled for changes; contexts that appear
  later show as *New* and are never connected automatically. The kubeconfig is
  never written. A connected context whose credentials change reconnects; one
  that now names another API server is disconnected and its changes are locked
  until you confirm its environment and protection for the new server in
  Connections (also checked at start and before every change).
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
  rows until a probe succeeds and every watch has caught up again. Disconnect
  cancels a connect still in progress.
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
  [performance.md](performance.md) and the
  measured results in [../benchmarks/m0-results.md](../benchmarks/m0-results.md).
- **Secrets** (`secrets.go`): like Lens, keys and sizes are shown and values
  stay hidden until you reveal one key; the log records who revealed which
  key, never the value. In YAML each value reads `(hidden, N bytes)`; an edit
  that keeps the placeholder keeps the live value. The copy in the
  `last-applied-configuration` annotation and Secrets in Helm manifests are
  masked the same way.
- **Other kinds** (`generic.go`): any kind the cluster serves, CRDs included,
  is listed with the API server's own table columns (what `kubectl get`
  prints), deleted with background propagation, or created from YAML. The kind
  list is refreshed every 5 minutes and when a kind is not found, so CRDs
  installed later appear without a restart.
- **Metrics** (`cluster.go`, `samples.go`): metrics-server is polled every 15 s
  (Settings). It has no history, so Clustrail keeps its own samples for 2 hours
  in the user cache directory, across restarts, and charts say where they come
  from.
- **Actions** (`actions.go`, `yaml.go`, `helm_actions.go`): delete (with the
  UID seen when you confirmed as a precondition, so an object recreated under
  the same name is not deleted), rollout restart, scale, rollback (like
  `kubectl rollout undo`: the whole pod template, refused if the Deployment
  rolled out again meanwhile), pause, cordon, drain through the Eviction API
  (PDBs respected, refused evictions retried, done only when the evicted pods
  are gone),
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
  forwards to a pod, or a ready pod behind a Service or Deployment (matched by
  the whole selector, `matchExpressions` included), that re-resolve the pod and
  keep their local port when it goes away.
- **Workloads** (`workloads.go`): StatefulSets and DaemonSets restart like
  `kubectl rollout restart`; StatefulSets scale through the scale
  subresource; a CronJob runs now (`kubectl create job --from`, owned by the
  CronJob) or is suspended and resumed; a Job lists its attempts, one pod per
  retry, with exit codes and the reason it stopped.
- **Debugging** (`debug.go`): a debug container is an ephemeral container
  (`kubectl debug POD`, with `--target` and the same profiles); it cannot be
  removed, and the dialog says so. A node shell is a privileged pod pinned to
  the node with the host's PID, network and IPC namespaces and its root at
  `/host`; it is deleted when the shell closes or Clustrail quits, and ends by
  itself after 12 hours (`activeDeadlineSeconds`). Each shell carries a label
  with this installation's id; on connect, this installation's shells that no
  open shell uses (left by a crash, or by quitting while the cluster was
  unreachable) are deleted, and other installations' shells are left alone. Read-only
  contexts offer neither; production and protected contexts ask for the
  context name.
- **Helm upgrade** (`helm_upgrade.go`): edit the release's user-supplied
  values (credential-like keys stay `[redacted by Clustrail]` and keep their
  live value), optionally pick another chart version from a repository in
  Helm's `repositories.yaml`, and preview: a server-side dry run diffed object
  by object against the deployed manifest, Secret values hidden. Upgrade runs
  with `--wait`/`--atomic`/`--timeout` as chosen, after a typed confirmation
  on protected and production contexts.
- **Storage** (`storage.go`): claims, volumes and storage classes with the
  pods that mount each claim, why a claim is not Bound (its newest event), and
  how full each volume is from the kubelet's stats (`nodes/proxy`), when
  allowed.
- **Network policies** (`netpol.go`): for one pod, which policies select it
  and what each rule lets in and out, with the network plugin found in
  kube-system and whether it enforces policies; a check says whether one
  connection (pod or IP, port, protocol) is allowed and by which rule.
- **Service chain** (`servicechain.go`): Ingress → IngressClass and its
  controller's pods → Service → EndpointSlices → pods, read from the objects
  (no request is sent, so read-only contexts have it too). Each link is
  checked in the order a request meets it: a missing class or Service, a port
  the Service lacks, a selector that matches nothing (with the label values
  pods do have), a named targetPort the pods do not declare, no ready
  endpoints (with the readiness probe's failure), a missing or expiring TLS
  Secret, and network policies that keep the controller out. The first broken
  link is the verdict.
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
docs/                         How it works, development guide, benchmarks, screenshots
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
  src/features/storage/       Claims, volumes and storage classes
  src/features/network/       Network policies of a pod and connection checks
  src/features/debug/         Debug container and node shell dialogs
  src/features/…               Clusters, Nodes, Logs, Shell, YAML, Compare, Helm, GitOps, Connections, Settings
  src/backend/                Wails client, desktop-mode detection, on-demand data hooks
  src/app/desktop.ts          Snapshot + delta sync and backend actions (desktop mode)
  src/data/                   View-model types and mock data (browser mode)
  src/i18n/                   t()/tn() and the Turkish strings (tr.ts); English text is the key
  e2e/                        Playwright tests (browser preview and desktop mode with a faked backend)
```
