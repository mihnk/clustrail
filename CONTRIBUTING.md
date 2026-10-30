# Contributing to Clustrail

Thanks for helping. Bug reports, fixes and features are all welcome; for a
larger change, open an issue first so we can agree on the approach.

## Ground rules

- **The UI never talks to a Kubernetes API server.** Cluster access belongs to
  the Go side (`internal/kube`); the frontend calls the `internal/app.Workspace`
  service and listens to its events.
- **Changes go through the safety model.** Anything that modifies a cluster
  checks Read-only in Go (`Manager.writable`) and asks for confirmation in the
  UI (`useConfirm`), with the equivalent `kubectl` command shown.
- **Say what is true.** Views state where data comes from and what is missing
  (RBAC limits, metrics history, unsupported features) instead of filling gaps
  with made-up values. Mock data belongs to the browser preview only.
- **No telemetry, no accounts, no network calls** other than to the user's
  clusters and the optional update check.

## Setup

See [Development](README.md#development) in the README for requirements and
how to run the app. For a real cluster to test against:

```bash
hack/kind-smoke.sh
```

## Before you open a pull request

```bash
cd frontend && npm run typecheck && npm run build
```

```bash
go vet ./... && go test -race ./internal/...
```

```bash
cd frontend && npm run e2e
```

- Add or update Go tests (fake clientsets in `internal/kube/*_test.go`) for
  backend changes, and a Playwright test for new UI flows.
- If you change the row converters, regenerate the e2e fixture (command in the
  README).
- Match the surrounding code: naming, comment density, and the design tokens
  in `frontend/src/styles/index.css` rather than raw colors.
- Keep commits focused, with a message that says what changed and why.

## License

By contributing, you agree that your contributions are licensed under the
Apache License 2.0.
