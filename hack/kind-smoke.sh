#!/usr/bin/env bash
# Brings up a local kind cluster with workloads that exercise Clustrail:
# a healthy Deployment with a PDB, a crash-looping one, a Helm release with a
# failed revision, metrics-server, and a namespace-only identity for the RBAC
# fallback. Usage:
#   hack/kind-smoke.sh        create (or refresh) the cluster
#   hack/kind-smoke.sh down   delete it and its kubeconfig entries
set -euo pipefail

NAME="${CLUSTRAIL_SMOKE_NAME:-clustrail-smoke}"
CTX="kind-${NAME}"
NS_CTX="${NAME}-team-a"

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing: $1 ($2)" >&2; exit 1; }; }
step() { printf '\n==> %s\n' "$*"; }
k() { kubectl --context "$CTX" "$@"; }

if [[ "${1:-}" == "down" ]]; then
  need kind "https://kind.sigs.k8s.io"
  kind delete cluster --name "$NAME"
  kubectl config delete-context "$NS_CTX" >/dev/null 2>&1 || true
  kubectl config delete-user "$NS_CTX" >/dev/null 2>&1 || true
  exit 0
fi

need docker "Docker Desktop, colima or podman"
need kind "https://kind.sigs.k8s.io"
need kubectl "https://kubernetes.io/docs/tasks/tools/"

step "cluster $NAME"
if ! kind get clusters 2>/dev/null | grep -qx "$NAME"; then
  kind create cluster --name "$NAME" --wait 120s --config - <<YAML
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
  - role: worker
  - role: worker
YAML
fi

step "metrics-server"
k apply -f https://github.com/kubernetes-sigs/metrics-server/releases/download/v0.7.2/components.yaml >/dev/null
# kind kubelets use self-signed serving certs.
k -n kube-system patch deployment metrics-server --type=json \
  -p '[{"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--kubelet-insecure-tls"}]' >/dev/null 2>&1 || true

step "workloads"
k apply -f - <<'YAML'
apiVersion: v1
kind: Namespace
metadata: { name: payments }
---
apiVersion: v1
kind: Namespace
metadata: { name: team-a }
---
apiVersion: v1
kind: ConfigMap
metadata: { name: checkout-config, namespace: payments }
data: { LOG_LEVEL: info }
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: checkout-api, namespace: payments, labels: { app: checkout-api } }
spec:
  replicas: 3
  selector: { matchLabels: { app: checkout-api } }
  template:
    metadata: { labels: { app: checkout-api } }
    spec:
      containers:
        - name: api
          image: nginx:1.27-alpine
          envFrom: [{ configMapRef: { name: checkout-config } }]
          resources: { requests: { cpu: 20m, memory: 32Mi }, limits: { memory: 64Mi } }
          volumeMounts: [{ name: scratch, mountPath: /scratch }]
      volumes: [{ name: scratch, emptyDir: {} }]
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata: { name: checkout-api, namespace: payments }
spec:
  maxUnavailable: 0
  selector: { matchLabels: { app: checkout-api } }
---
apiVersion: v1
kind: Service
metadata: { name: checkout-api, namespace: payments }
spec:
  selector: { app: checkout-api }
  ports: [{ port: 80, targetPort: 80 }]
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: payments-worker, namespace: payments, labels: { app: payments-worker } }
spec:
  replicas: 1
  selector: { matchLabels: { app: payments-worker } }
  template:
    metadata: { labels: { app: payments-worker } }
    spec:
      containers:
        - name: worker
          image: busybox:1.36
          command: ["sh", "-c", "echo 'level=error msg=\"cannot reach db:5432\"'; sleep 2; exit 1"]
---
apiVersion: apps/v1
kind: Deployment
metadata: { name: web, namespace: team-a, labels: { app: web } }
spec:
  replicas: 2
  selector: { matchLabels: { app: web } }
  template:
    metadata: { labels: { app: web } }
    spec:
      containers:
        - name: web
          image: nginx:1.27-alpine
          resources: { requests: { cpu: 10m, memory: 16Mi } }
YAML
# A second rollout so the Deployment has a revision to roll back to.
k -n payments set image deployment/checkout-api api=nginx:1.27.3-alpine >/dev/null
k -n payments rollout status deployment/checkout-api --timeout=180s

step "namespace-only identity ($NS_CTX)"
k apply -f - <<'YAML'
apiVersion: v1
kind: ServiceAccount
metadata: { name: dev-team, namespace: team-a }
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: dev-team-edit, namespace: team-a }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: edit }
subjects: [{ kind: ServiceAccount, name: dev-team, namespace: team-a }]
YAML
TOKEN="$(k -n team-a create token dev-team --duration=24h)"
kubectl config set-credentials "$NS_CTX" --token="$TOKEN" >/dev/null
kubectl config set-context "$NS_CTX" --cluster="$CTX" --user="$NS_CTX" --namespace=team-a >/dev/null

if command -v helm >/dev/null 2>&1; then
  step "helm release payments/billing (3 revisions, last one failed)"
  CHART="$(mktemp -d)"
  trap 'rm -rf "$CHART"' EXIT
  helm create "$CHART/billing" >/dev/null
  helm --kube-context "$CTX" upgrade --install billing "$CHART/billing" -n payments --set image.tag=1.27-alpine --wait --timeout 120s >/dev/null
  helm --kube-context "$CTX" upgrade billing "$CHART/billing" -n payments --set image.tag=1.27.3-alpine --set replicaCount=2 --wait --timeout 120s >/dev/null
  helm --kube-context "$CTX" upgrade billing "$CHART/billing" -n payments --set image.tag=does-not-exist --wait --timeout 20s >/dev/null 2>&1 || true
else
  echo "helm not found: skipping the Helm release (https://helm.sh/docs/intro/install/)"
fi

cat <<TXT

Ready. Start Clustrail (wails3 dev, or the built app) and check:
  Clusters      $CTX connects; $NS_CTX shows "Limited by RBAC … showing only team-a"
  Pods          payments-worker-* in CrashLoopBackOff, logs show "cannot reach db:5432"
  Deployments   checkout-api revision 2; roll back to 1; restart; scale
  Nodes         drain a worker: checkout-api pods blocked by the PDB (maxUnavailable 0)
  Helm          payments/billing: rev 3 failed; inspect manifest/values, roll back to 2
  Shell         exec into a checkout-api pod
  Metrics       CPU/memory appear ~1 minute after metrics-server starts

Remove everything with: hack/kind-smoke.sh down
TXT
