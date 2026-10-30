# Clustrail

A free, open-source Kubernetes desktop workspace. Clustrail connects to your
clusters with your own kubeconfig. It needs no in-cluster agent, no account and
no SaaS backend.

> **Status:** early development. The desktop app connects to the contexts in
> your kubeconfig. Opened in a plain browser (Vite dev server), the UI runs on
> mock data instead and the status bar says `MOCK DATA`.

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
- **Settings** (`settings.go`): group, protection (Standard · Protected ·
  Read-only) and hidden contexts live in `~/.config/clustrail/contexts.json`.
  Read-only is enforced in Go for every change and every shell; it is a guard
  against mistakes, not a substitute for RBAC.
- **Connections** (`manager.go`, `cluster.go`): one connection per context.
  Connect probes `/version`, identity (SelfSubjectReview) and metrics.k8s.io,
  checks list permission per resource (SelfSubjectAccessReview) and starts
  shared informers for pods, deployments, replicasets, nodes and HPAs. Exec
  plugins never prompt: expired credentials surface with the command to run in
  your own terminal. A lost watch marks the cluster *reconnecting* with stale
  rows until a probe succeeds.
- **Rows** (`convert.go`): pod, deployment and node rows follow kubectl's status
  logic. Changes are sent to the UI as deltas at most every 250 ms
  (`clustrail:delta`), never as full lists.
- **Metrics** (`cluster.go`, `samples.go`): metrics-server is polled every 15 s.
  It has no history, so charts show only samples taken since Clustrail
  connected and say so.
- **Actions** (`actions.go`, `yaml.go`, `helm_actions.go`): delete, rollout
  restart, scale, rollback (like `kubectl rollout undo`), pause, cordon, drain
  through the Eviction API (PDBs respected, refused evictions retried),
  server-side apply with dry run and resourceVersion conflicts, Helm rollback
  with the Helm SDK, Argo CD refresh/sync and Flux reconcile/suspend.
- **Streams** (`streams.go`): follow logs per container (reconnecting across
  container restarts) and interactive exec over WebSocket with SPDY fallback.
- **Helm and GitOps** (`helm.go`, `gitops.go`): releases are read from Helm's
  storage Secrets (values with credential-like keys redacted); Argo CD
  Applications and Flux Kustomizations/HelmReleases from their CRDs when served.

## Layout

```text
main.go                       Wails application, window and Workspace service
internal/app/                 Wails service: the API the frontend calls
internal/kube/                Kubeconfig, connections, informers, rows, actions, streams
build/                        App icon (source SVG and 1024px PNG)
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
  src/features/…               Clusters, Nodes, Logs, Shell, YAML, Compare, Helm, GitOps, Connections, Settings
  src/backend/                Wails client, desktop-mode detection, on-demand data hooks
  src/app/desktop.ts          Snapshot + delta sync and backend actions (desktop mode)
  src/data/                   View-model types and mock data (browser mode)
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
