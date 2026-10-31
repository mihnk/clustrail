# Development

Commands run from the repository root.

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

## Performance and synthetic clusters

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

What the app costs while nothing changes (60 s visible, then 60 s hidden),
and the backend with a connected cluster against a real kube-apiserver
(envtest binaries, e.g. from `setup-envtest`):

```bash
hack/bench.sh idle clusters=5,pods=2000 idle.json 60
```

```bash
KUBEBUILDER_ASSETS=/path/to/envtest/bin go test -tags envtest -run TestIdleConnectedCluster -v ./internal/kube
```

On a Mac, one command builds the app, runs every scenario three times and
records the machine (`docs/benchmarks/data/macos-…/summary.md`):

```bash
hack/measure-macos.sh
```

Budgets and current values: [performance-budgets.md](performance-budgets.md).

## Against a real cluster

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

## Screenshots

The images in `docs/images` (README) and on the website come from the
production build against the faked backend, with sample data:

```bash
cd frontend && npm run build && CLUSTRAIL_SCREENSHOTS=$PWD/../docs/images npx playwright test e2e/screenshots.spec.ts
```

## Releases

Pushing a tag `vX.Y.Z` runs `.github/workflows/release.yml`: a universal macOS
app (`.dmg` and `.zip`), a Windows installer and portable `.exe`, and a Linux
tarball, attached to a draft GitHub release with `SHA256SUMS`. macOS builds are
signed and notarized when the signing secrets listed in the workflow are set;
otherwise they are ad-hoc signed.
