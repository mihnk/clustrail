# Clustrail

A free, open-source Kubernetes desktop workspace. Clustrail connects to your
clusters with your own kubeconfig. It needs no in-cluster agent, no account and
no SaaS backend.

> **Status:** early development. The UI runs on mock data (the status bar shows
> `MOCK DATA`). Nothing connects to a cluster yet.

## Stack

| Layer | Technology |
|---|---|
| Native backend | Go, client-go (planned) |
| Desktop runtime | Wails 3 |
| Frontend | React + TypeScript, Vite |
| Styling | Tailwind CSS 4 with semantic design tokens |
| UI primitives | Radix UI (shadcn/ui-style components) |
| Icons | Lucide |
| Resource tables | TanStack Table + TanStack Virtual |
| Charts | uPlot |
| Terminal / YAML (planned) | xterm.js / Monaco Editor |

The frontend never talks to a Kubernetes API server. Cluster access, watches,
caching, exec and log streams belong to the Go backend, which the UI reaches
through Wails bindings.

## Layout

```text
main.go                       Wails application and window
frontend/
  src/styles/index.css        Design tokens (dark + light) and Tailwind theme
  src/app/                    App shell, workspace state, preferences
  src/components/ui/          Button, Tabs, Segmented, DropdownMenu, Tooltip, …
  src/components/status/      StatusGlyph, ResourceStatus, EnvironmentBadge, …
  src/components/shell/       WindowToolbar, ClusterNavigation, StatusBar
  src/components/resource-table/  Virtualized ResourceTable
  src/components/charts/      MetricsChart (uPlot)
  src/features/pods/          Pods explorer and inspector
  src/data/                   View-model types and mock data
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

You can also open the UI alone at http://localhost:9245 in a browser.

Production build (embeds `frontend/dist`):

```bash
cd frontend && npm run build && cd .. && go build -tags production -o bin/clustrail .
```

Checks:

```bash
cd frontend && npm run typecheck
```

```bash
go vet ./...
```
