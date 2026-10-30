// GitOps objects as the controllers report them: Argo CD Applications
// (argoproj.io/v1alpha1) and Flux Kustomizations / HelmReleases
// (kustomize.toolkit.fluxcd.io, helm.toolkit.fluxcd.io). Clustrail only reads
// their status and asks the controller to refresh or sync; it never pushes to git.

import type { Environment, Health } from "./types";

export type GitOpsTool = "Argo CD" | "Flux";
export type GitOpsKind = "Application" | "Kustomization" | "HelmRelease";
export type SyncState = "Synced" | "OutOfSync" | "Applied" | "Failed" | "Unknown";
export type AppHealth = "Healthy" | "Degraded" | "Progressing" | "Ready" | "Not ready" | "Suspended" | "Missing";

export interface Drift {
  resource: string;
  field: string;
  desired: string;
  live: string;
  /** From managedFields: who wrote the live value, and when. */
  manager: string;
  ago: string;
}

export interface GitOpsObject {
  id: string;
  name: string;
  kind: GitOpsKind;
  tool: GitOpsTool;
  /** Namespace of the GitOps object itself (argocd, flux-system). */
  namespace: string;
  /** Namespace it deploys to. */
  destination: string;
  cluster: string;
  env: Environment;
  sync: SyncState;
  appHealth: AppHealth;
  /** Table health: the worse of sync and app health. */
  health: Health;
  repo: string;
  path: string;
  /** Branch, tag or chart version the object follows. */
  target: string;
  revision: string;
  reconciledSeconds: number;
  policy: { automated: boolean; selfHeal: boolean; prune: boolean };
  drift: Drift[];
  resources: { kind: string; name: string; status: "Synced" | "OutOfSync" | "Missing"; health: AppHealth }[];
  conditions: { type: string; message: string; at: string }[];
  history: { revision: string; at: string; message: string }[];
  /** Controller message when reconciliation failed. */
  error?: string;
  suspended?: boolean;
}

export interface Controller {
  cluster: string;
  env: Environment;
  /** null: neither applications.argoproj.io nor kustomizations.kustomize.toolkit.fluxcd.io is served. */
  tool: GitOpsTool | null;
  version?: string;
  url?: string;
}

export const controllers: Controller[] = [
  { cluster: "prod-eu-west-1", env: "prod", tool: "Argo CD", version: "2.12", url: "https://argocd.prod-eu-west-1.acme.internal" },
  { cluster: "prod-us-east-1", env: "prod", tool: "Argo CD", version: "2.12", url: "https://argocd.prod-us-east-1.acme.internal" },
  { cluster: "staging-eu-1", env: "stg", tool: "Flux", version: "2.4" },
  { cluster: "dev-shared", env: "dev", tool: null },
];

const envOf = (cluster: string): Environment => (cluster.startsWith("prod") ? "prod" : cluster.startsWith("staging") ? "stg" : "dev");

export function gitopsHealth(sync: SyncState, app: AppHealth): Health {
  if (sync === "Failed" || app === "Degraded" || app === "Not ready" || app === "Missing") return "failed";
  if (sync === "OutOfSync") return "warning";
  if (app === "Progressing") return "progressing";
  if (app === "Suspended") return "paused";
  if (sync === "Unknown") return "unknown";
  return "healthy";
}

type Seed = [SyncState, AppHealth, string, GitOpsKind, string, string, string, string, number];

const SEEDS: Seed[] = [
  ["OutOfSync", "Healthy", "payments-gateway", "Application", "prod-eu-west-1", "github.com/acme/deploy", "apps/payments-gateway/overlays/prod", "8c41e2f", 41],
  ["OutOfSync", "Healthy", "search-api", "Application", "prod-us-east-1", "github.com/acme/deploy", "apps/search-api/overlays/prod", "8c41e2f", 62],
  ["Synced", "Degraded", "checkout-api", "Application", "prod-eu-west-1", "github.com/acme/deploy", "apps/checkout-api/overlays/prod", "8c41e2f", 38],
  ["Failed", "Not ready", "ledger", "Kustomization", "staging-eu-1", "github.com/acme/deploy", "apps/ledger/overlays/staging", "a90d3be", 34 * 60],
  ["Failed", "Not ready", "payments-workers", "HelmRelease", "staging-eu-1", "oci://ghcr.io/acme/charts", "payments-workers", "2.4.0", 26 * 60],
  ["Synced", "Progressing", "cart-web", "Application", "prod-us-east-1", "github.com/acme/deploy", "apps/cart-web/overlays/prod", "8c41e2f", 12],
  ["Synced", "Healthy", "fraud-scorer", "Application", "prod-eu-west-1", "github.com/acme/deploy", "apps/fraud-scorer/overlays/prod", "8c41e2f", 44],
  ["Synced", "Healthy", "refunds-api", "Application", "prod-eu-west-1", "github.com/acme/deploy", "apps/refunds-api/overlays/prod", "8c41e2f", 50],
  ["Synced", "Healthy", "webhook-dispatcher", "Application", "prod-eu-west-1", "github.com/acme/deploy", "apps/webhook-dispatcher/overlays/prod", "8c41e2f", 52],
  ["Synced", "Healthy", "platform-ingress", "Application", "prod-eu-west-1", "github.com/acme/platform", "ingress", "1d7e9a0", 60],
  ["Synced", "Healthy", "catalog-api", "Application", "prod-us-east-1", "github.com/acme/deploy", "apps/catalog-api/overlays/prod", "8c41e2f", 70],
  ["Synced", "Healthy", "invoice-api", "Application", "prod-us-east-1", "github.com/acme/deploy", "apps/invoice-api/overlays/prod", "8c41e2f", 75],
  ["Applied", "Ready", "apps", "Kustomization", "staging-eu-1", "github.com/acme/deploy", "clusters/staging", "a90d3be", 120],
  ["Applied", "Ready", "infrastructure", "Kustomization", "staging-eu-1", "github.com/acme/platform", "staging", "1d7e9a0", 240],
  ["Applied", "Ready", "cert-manager", "HelmRelease", "staging-eu-1", "https://charts.jetstack.io", "cert-manager", "v1.16.0", 540],
  ["Synced", "Healthy", "monitoring", "Application", "prod-eu-west-1", "github.com/acme/platform", "monitoring", "1d7e9a0", 120],
  ["Synced", "Healthy", "monitoring", "Application", "prod-us-east-1", "github.com/acme/platform", "monitoring", "1d7e9a0", 130],
  ["Synced", "Healthy", "platform-ingress", "Application", "prod-us-east-1", "github.com/acme/platform", "ingress", "1d7e9a0", 65],
  ["Synced", "Healthy", "payments-gateway", "Application", "prod-us-east-1", "github.com/acme/deploy", "apps/payments-gateway/overlays/prod", "8c41e2f", 48],
  ["Synced", "Healthy", "checkout-api", "Application", "prod-us-east-1", "github.com/acme/deploy", "apps/checkout-api/overlays/prod", "8c41e2f", 46],
  ["Synced", "Healthy", "fraud-scorer", "Application", "prod-us-east-1", "github.com/acme/deploy", "apps/fraud-scorer/overlays/prod", "8c41e2f", 51],
  ["Synced", "Healthy", "refunds-api", "Application", "prod-us-east-1", "github.com/acme/deploy", "apps/refunds-api/overlays/prod", "8c41e2f", 55],
  ["Synced", "Healthy", "cart-web", "Application", "prod-eu-west-1", "github.com/acme/deploy", "apps/cart-web/overlays/prod", "8c41e2f", 15],
  ["Synced", "Healthy", "search-api", "Application", "prod-eu-west-1", "github.com/acme/deploy", "apps/search-api/overlays/prod", "8c41e2f", 58],
  ["Synced", "Healthy", "catalog-api", "Application", "prod-eu-west-1", "github.com/acme/deploy", "apps/catalog-api/overlays/prod", "8c41e2f", 72],
  ["Synced", "Healthy", "invoice-api", "Application", "prod-eu-west-1", "github.com/acme/deploy", "apps/invoice-api/overlays/prod", "8c41e2f", 77],
  ["Synced", "Healthy", "external-secrets", "Application", "prod-eu-west-1", "github.com/acme/platform", "external-secrets", "1d7e9a0", 140],
  ["Synced", "Healthy", "external-secrets", "Application", "prod-us-east-1", "github.com/acme/platform", "external-secrets", "1d7e9a0", 150],
  ["Synced", "Healthy", "karpenter", "Application", "prod-eu-west-1", "github.com/acme/platform", "karpenter", "1d7e9a0", 160],
  ["Synced", "Healthy", "karpenter", "Application", "prod-us-east-1", "github.com/acme/platform", "karpenter", "1d7e9a0", 170],
  ["Applied", "Ready", "checkout-api", "Kustomization", "staging-eu-1", "github.com/acme/deploy", "apps/checkout-api/overlays/staging", "a90d3be", 130],
  ["Applied", "Ready", "payments-gateway", "Kustomization", "staging-eu-1", "github.com/acme/deploy", "apps/payments-gateway/overlays/staging", "a90d3be", 135],
  ["Applied", "Ready", "search-api", "Kustomization", "staging-eu-1", "github.com/acme/deploy", "apps/search-api/overlays/staging", "a90d3be", 138],
  ["Applied", "Ready", "otel-collector", "HelmRelease", "staging-eu-1", "https://open-telemetry.github.io/opentelemetry-helm-charts", "opentelemetry-collector", "0.104.0", 600],
  ["Applied", "Ready", "loki", "HelmRelease", "staging-eu-1", "https://grafana.github.io/helm-charts", "loki", "6.16.0", 620],
  ["Applied", "Ready", "ingress-nginx", "HelmRelease", "staging-eu-1", "https://kubernetes.github.io/ingress-nginx", "ingress-nginx", "4.11.3", 640],
  ["Applied", "Ready", "flux-system", "Kustomization", "staging-eu-1", "github.com/acme/platform", "clusters/staging/flux-system", "1d7e9a0", 60],
  ["Applied", "Suspended", "cart-web", "Kustomization", "staging-eu-1", "github.com/acme/deploy", "apps/cart-web/overlays/staging", "9b2f4c1", 3 * 86400],
];

const LEDGER_ERROR =
  "kustomize build failed: accumulating resources: accumulation err='accumulating resources from 'cronjob.yaml': open /tmp/kustomization-1873/apps/ledger/overlays/staging/cronjob.yaml: no such file or directory'";
const WORKERS_ERROR = "Helm upgrade failed for release payments/payments-workers with chart payments-workers@2.4.0: context deadline exceeded";

export const gitopsObjects: GitOpsObject[] = SEEDS.map(([sync, appHealth, name, kind, cluster, repo, path, revision, reconciledSeconds]) => {
  const tool: GitOpsTool = kind === "Application" ? "Argo CD" : "Flux";
  const isGateway = name === "payments-gateway" && cluster === "prod-eu-west-1";
  const isSearch = name === "search-api" && cluster === "prod-us-east-1";
  const drift: Drift[] = isGateway
    ? [{ resource: "Deployment payments-gateway", field: "spec.replicas", desired: "3", live: "4", manager: "kubectl-scale", ago: "2h 14m" }]
    : isSearch
      ? [{ resource: "ConfigMap search-api-config", field: "data.QUERY_TIMEOUT", desired: "2s", live: "5s", manager: "kubectl-edit", ago: "47m" }]
      : [];
  const error = name === "ledger" ? LEDGER_ERROR : name === "payments-workers" && kind === "HelmRelease" ? WORKERS_ERROR : undefined;
  const resources: GitOpsObject["resources"] = [
    { kind: "Deployment", name, status: drift.some((d) => d.resource.startsWith("Deployment")) ? "OutOfSync" : "Synced", health: appHealth === "Degraded" ? "Degraded" : appHealth === "Progressing" ? "Progressing" : "Healthy" },
    { kind: "Service", name, status: "Synced", health: "Healthy" },
    { kind: "ConfigMap", name: `${name}-config`, status: drift.some((d) => d.resource.startsWith("ConfigMap")) ? "OutOfSync" : "Synced", health: "Healthy" },
    { kind: "ServiceAccount", name, status: "Synced", health: "Healthy" },
    { kind: "HorizontalPodAutoscaler", name, status: "Synced", health: "Healthy" },
    { kind: "PodDisruptionBudget", name, status: "Synced", health: "Healthy" },
    { kind: "ServiceMonitor", name, status: "Synced", health: "Healthy" },
  ];
  return {
    id: `${cluster}/${kind}/${name}`,
    name,
    kind,
    tool,
    namespace: tool === "Argo CD" ? "argocd" : "flux-system",
    destination: name === "checkout-api" || name.startsWith("payments") || name === "ledger" || name === "refunds-api" || name === "fraud-scorer" ? "payments" : name,
    cluster,
    env: envOf(cluster),
    sync,
    appHealth,
    health: gitopsHealth(sync, appHealth),
    repo,
    path,
    target: kind === "HelmRelease" ? revision : "main",
    revision,
    reconciledSeconds,
    policy: { automated: true, selfHeal: !isGateway && !isSearch, prune: true },
    drift,
    resources,
    conditions: error
      ? [{ type: "Ready=False", message: kind === "Kustomization" ? "ReconciliationFailed" : "UpgradeFailed", at: name === "ledger" ? "11:42:07" : "11:49:55" }]
      : appHealth === "Degraded"
        ? [{ type: "Health", message: "Deployment checkout-api: 2 of 4 replicas available", at: "11:24:31" }]
        : [],
    history: [
      { revision, at: "3d ago", message: `Sync to ${revision}` },
      { revision: "6e10a77", at: "9d ago", message: "Sync to 6e10a77" },
    ],
    error,
    suspended: appHealth === "Suspended",
  };
});

export function shortRepo(o: GitOpsObject): string {
  const repo = o.repo.replace(/^(https?|oci):\/\//, "").replace(/^github\.com\//, "").replace(/^ghcr\.io\//, "");
  return o.kind === "HelmRelease" ? `${repo.split("/").pop()} · ${o.path}` : `${repo} · ${o.path.replace(/\/overlays\/.*$/, "")}`;
}
