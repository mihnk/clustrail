#!/usr/bin/env bash
# Performance gate (issue A3): runs the Go benchmarks of the base commit and
# of the change on this machine, interleaved round by round so drift hits
# both alike, then fails if a median got more than THRESHOLD % worse with
# p < 0.05 (hack/perfgate).
#   hack/perf-gate.sh                       # against the merge base with origin/main
#   BASE_REF=HEAD~1 hack/perf-gate.sh       # against another commit
#   AA=1 hack/perf-gate.sh                  # A/A: base against itself, the noise floor
set -euo pipefail
cd "$(dirname "$0")/.."
ROUNDS=${ROUNDS:-8}
THRESHOLD=${THRESHOLD:-10}
PKGS=${PKGS:-"./internal/mock ./internal/kube ./internal/streaming"}
BENCHTIME=${BENCHTIME:-1s}
ref=${BASE_REF:-origin/main}
base=$(git merge-base HEAD "$ref" 2>/dev/null || git rev-parse "$ref")
work=$(mktemp -d)
trap 'git worktree remove --force "$work/base" >/dev/null 2>&1 || true; rm -rf "$work"' EXIT
git worktree add --detach "$work/base" "$base" >/dev/null
echo "base $(git rev-parse --short "$base"), change: the working tree; $ROUNDS rounds"
bench() { (cd "$1" && go test -run '^$' -bench . -benchmem -count=1 -benchtime="$BENCHTIME" $PKGS 2>/dev/null | grep -E '^(pkg:|Benchmark)'); }
for i in $(seq "$ROUNDS"); do
  bench "$work/base" >>"$work/base.txt"
  if [ -n "${AA:-}" ]; then bench "$work/base" >>"$work/head.txt"; else bench . >>"$work/head.txt"; fi
  echo "round $i done"
done
mkdir -p perf-results
cp "$work/base.txt" perf-results/base.txt
cp "$work/head.txt" perf-results/head.txt
go run ./hack/perfgate -threshold "$THRESHOLD" "$work/base.txt" "$work/head.txt"
