// Mock live objects as the API server returns them (kubectl get -o yaml).
// The Go backend fetches the real object and its resourceVersion; server-side
// dry run and apply go through the same backend call with DryRun=All.

export interface LiveObject {
  yaml: string;
  resourceVersion: number;
  /** Set when ownership labels or managedFields point to a GitOps controller. */
  gitops?: { tool: "Argo CD" | "Flux"; app: string; selfHeal: boolean; source: string };
  /** Field paths and the manager that owns them (from managedFields). */
  owners: Record<string, string>;
}

const CHECKOUT = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: checkout-api
  namespace: payments
  labels:
    app.kubernetes.io/name: checkout-api
    app.kubernetes.io/instance: checkout-api
  annotations:
    argocd.argoproj.io/tracking-id: checkout-api:apps/Deployment:payments/checkout-api
    deployment.kubernetes.io/revision: "14"
  managedFields:
    - manager: argocd-controller
      operation: Apply
      fieldsType: FieldsV1
    - manager: kube-controller-manager
      operation: Update
      subresource: status
spec:
  replicas: 4
  revisionHistoryLimit: 10
  selector:
    matchLabels:
      app.kubernetes.io/name: checkout-api
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 1
  template:
    metadata:
      labels:
        app.kubernetes.io/name: checkout-api
      annotations:
        prometheus.io/scrape: "true"
    spec:
      containers:
        - name: api
          image: ghcr.io/acme/checkout-api:v2.31.0
          env:
            - name: JAVA_TOOL_OPTIONS
              value: -Xmx384m -XX:+UseG1GC
          resources:
            requests:
              cpu: 250m
              memory: 192Mi
            limits:
              cpu: "1"
              memory: 256Mi
          readinessProbe:
            httpGet:
              path: /readyz
              port: 8080
            periodSeconds: 5
            failureThreshold: 3
        - name: envoy
          image: envoyproxy/envoy:v1.31.2
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              memory: 128Mi
status:
  observedGeneration: 14
  replicas: 4
  updatedReplicas: 4
  readyReplicas: 2
  availableReplicas: 2
  unavailableReplicas: 2
  conditions:
    - type: Available
      status: "False"
      reason: MinimumReplicasUnavailable
      message: Deployment does not have minimum availability.
    - type: Progressing
      status: "True"
      reason: NewReplicaSetAvailable
      message: ReplicaSet "checkout-api-7d9f8b6c4" has successfully progressed.
`;

export function liveObject(params: Record<string, string>, cluster: string): LiveObject {
  const kind = params.kind ?? "Deployment";
  const name = params.name ?? "unknown";
  const namespace = params.namespace;
  if (kind === "Deployment" && name === "checkout-api" && cluster === "prod-eu-west-1") {
    return {
      yaml: CHECKOUT,
      resourceVersion: 48211907,
      gitops: {
        tool: "Argo CD",
        app: "argocd/checkout-api",
        selfHeal: true,
        source: "acme/deploy · apps/checkout-api/overlays/prod/resources.yaml",
      },
      owners: {
        "spec.template.spec.containers[api].resources": "argocd-controller",
        "spec.replicas": "argocd-controller",
        "spec.template.spec.containers[api].image": "argocd-controller",
      },
    };
  }
  const header = `apiVersion: ${kind === "Node" || kind === "Pod" ? "v1" : "apps/v1"}\nkind: ${kind}\nmetadata:\n  name: ${name}\n${namespace ? `  namespace: ${namespace}\n` : ""}`;
  const body =
    kind === "Node"
      ? "spec:\n  podCIDR: 10.42.3.0/24\n  unschedulable: true\nstatus:\n  allocatable:\n    cpu: 7910m\n    memory: 28466Mi\n    pods: \"58\"\n"
      : `spec:\n  replicas: 2\n  selector:\n    matchLabels:\n      app.kubernetes.io/name: ${name}\n  template:\n    spec:\n      containers:\n        - name: app\n          image: ghcr.io/acme/${name}:latest\n          resources:\n            requests:\n              cpu: 100m\n              memory: 128Mi\nstatus:\n  readyReplicas: 2\n`;
  return { yaml: header + body, resourceVersion: 30000000 + name.length * 1117, owners: {} };
}

/** The edit the investigation leads to: double the api container's memory. */
export function suggestedEdit(live: string): string {
  return live.replace("              memory: 192Mi", "              memory: 384Mi").replace("              memory: 256Mi", "              memory: 512Mi");
}
