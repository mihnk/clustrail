#!/usr/bin/env bash
# Runs the tests that need a real kube-apiserver and etcd (envtest binaries,
# no kubelet): the chaos cases (issue D4) and the soak (D3).
#   hack/envtest.sh                   # chaos + a 30-cycle soak
#   SOAK_CYCLES=200 hack/envtest.sh   # the full soak
# KUBEBUILDER_ASSETS points at the binaries; without it they are installed
# with setup-envtest (Kubernetes 1.32).
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -z "${KUBEBUILDER_ASSETS:-}" ]; then
  go install sigs.k8s.io/controller-runtime/tools/setup-envtest@release-0.20
  KUBEBUILDER_ASSETS=$("$(go env GOPATH)/bin/setup-envtest" use 1.32.0 -p path)
  export KUBEBUILDER_ASSETS
fi
export SOAK_CYCLES=${SOAK_CYCLES:-30}
go test -tags envtest -race -count=1 -timeout 30m -run 'TestChaos|TestSoak' -v ./internal/kube 2>&1 |
  grep -vE '^[IWE][0-9]{4} |^20[0-9]{2}/'
