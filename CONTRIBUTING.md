# Contributing to Clustrail

Thanks for helping. Bug reports, fixes and features are all welcome; for a
larger change, open an issue first so we can agree on the approach.

## Ground rules

- **The UI never talks to a Kubernetes API server.** Cluster access belongs to
  the Go side (`internal/kube`); the frontend calls the `internal/app.Workspace`
  service and listens to its events.
- **Changes go through the safety model.** Anything that modifies a cluster
  checks Read-only in Go (`Manager.writable`) and asks for confirmation in the
  UI (`useConfirm`), with the equivalent `kubectl` command shown. A new
  `Workspace` method goes into one of the two lists in
  `internal/app/readonly_test.go`; the test calls every method that changes a
  cluster against a read-only context.
- **A panic never ends the app.** Goroutines in `internal/kube` start with
  `safeGo` or `safeLoop` (`safe.go`), which recover, log the stack and put
  the component in a defined state; a test refuses a bare `go` statement.
- **Say what is true.** Views state where data comes from and what is missing
  (RBAC limits, metrics history, unsupported features) instead of filling gaps
  with made-up values. Mock data belongs to the browser preview only.
- **No telemetry, no accounts, no network calls** other than to the user's
  clusters and the optional update check.
- **UI text goes through `t()`** (`frontend/src/i18n`). The English text is
  the key: write `t("Delete pod")`, or `t("Scale to {replicas}", { replicas })`
  with placeholders instead of string concatenation, and `tn()` when a
  placeholder is an element (a `<code>` span). Write whole sentences, and
  separate keys for singular and plural. Add the Turkish text to
  `frontend/src/i18n/tr.ts`; a missing entry falls back to English. Kubernetes
  kinds, statuses, field names and commands stay in English.

## Setup

See [docs/development.md](docs/development.md) for requirements and
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
- If you change the row converters, regenerate the e2e fixture (command in
  [docs/development.md](docs/development.md)).
- Match the surrounding code: naming, comment density, and the design tokens
  in `frontend/src/styles/index.css` rather than raw colors.
- Keep commits focused, with a message that says what changed and why.

## License

By contributing, you agree that your contributions are licensed under the
Apache License 2.0.
