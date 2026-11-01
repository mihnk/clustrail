#!/usr/bin/env bash
# Runs every Go fuzz target for a while (FUZZTIME, default 15s each). CI runs
# it briefly on every change; run it longer locally to explore:
#   FUZZTIME=5m hack/fuzz.sh
# A failure writes the input to the package's testdata/fuzz/; commit it as a
# regression test together with the fix.
set -euo pipefail
cd "$(dirname "$0")/.."
FUZZTIME=${FUZZTIME:-15s}
for pkg in $(go list ./internal/...); do
  dir=$(go list -f '{{.Dir}}' "$pkg")
  for target in $(grep -ho '^func Fuzz[A-Za-z0-9_]*' "$dir"/*_test.go 2>/dev/null | sed 's/^func //' | sort -u); do
    echo "== $target ($pkg)"
    go test -run '^$' -fuzz "^${target}\$" -fuzztime "$FUZZTIME" "$pkg"
  done
done
