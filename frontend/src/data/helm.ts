// Helm releases as the backend reads them: one release Secret per revision
// (sh.helm.release.v1.<name>.v<rev>) in the release namespace. Rollback runs
// through the bundled Helm SDK; upgrade needs the chart, so it is only offered
// when the chart repository is configured.

import { parseAllDocuments } from "yaml";
import type { Environment, Health } from "./types";

export type HelmStatus = "deployed" | "failed" | "pending-upgrade" | "pending-rollback" | "superseded" | "uninstalling";

export interface HelmRevision {
  rev: number;
  status: HelmStatus;
  chartVersion: string;
  appVersion: string;
  updatedSeconds: number;
  description: string;
}

export interface HelmRelease {
  id: string;
  name: string;
  namespace: string;
  cluster: string;
  env: Environment;
  status: HelmStatus;
  health: Health;
  chart: string;
  chartVersion: string;
  appVersion: string;
  revision: number;
  updatedSeconds: number;
  /** The chart repository is configured in Settings › Helm, so upgrades are possible. */
  repoKnown: boolean;
  history: HelmRevision[];
  /** User-supplied values (helm get values). Secret-looking values are redacted by the backend. */
  values: string;
  notes: string;
  resources: { kind: string; name: string }[];
}

const M = 60;
const H = 3600;
const D = 86400;

const envOf = (cluster: string): Environment => (cluster.startsWith("prod") ? "prod" : cluster.startsWith("staging") ? "stg" : "dev");

export function helmHealth(s: HelmStatus): Health {
  if (s === "failed") return "failed";
  if (s.startsWith("pending") || s === "uninstalling") return "progressing";
  return "healthy";
}

type Seed = [HelmStatus, string, string, string, string, string, string, number, number];

const SEEDS: Seed[] = [
  ["failed", "payments-workers", "payments", "staging-eu-1", "payments-workers", "2.4.0", "1.9.0", 8, 26 * M],
  ["pending-upgrade", "otel-collector", "observability", "staging-eu-1", "opentelemetry-collector", "0.104.0", "0.108.0", 5, 3 * H],
  ["deployed", "payments-workers", "payments", "prod-eu-west-1", "payments-workers", "2.3.2", "1.8.4", 12, 6 * D],
  ["deployed", "ingress-nginx", "ingress-nginx", "prod-eu-west-1", "ingress-nginx", "4.11.3", "1.11.3", 23, 12 * D],
  ["deployed", "ingress-nginx", "ingress-nginx", "prod-us-east-1", "ingress-nginx", "4.11.3", "1.11.3", 21, 12 * D],
  ["deployed", "cert-manager", "cert-manager", "prod-eu-west-1", "cert-manager", "v1.15.3", "v1.15.3", 9, 41 * D],
  ["deployed", "cert-manager", "cert-manager", "prod-us-east-1", "cert-manager", "v1.15.3", "v1.15.3", 9, 41 * D],
  ["deployed", "kube-prometheus-stack", "monitoring", "prod-eu-west-1", "kube-prometheus-stack", "62.7.0", "v0.76.1", 41, 8 * D],
  ["deployed", "kube-prometheus-stack", "monitoring", "prod-us-east-1", "kube-prometheus-stack", "62.7.0", "v0.76.1", 38, 8 * D],
  ["deployed", "argo-cd", "argocd", "prod-eu-west-1", "argo-cd", "7.6.8", "v2.12.4", 18, 22 * D],
  ["deployed", "argo-cd", "argocd", "prod-us-east-1", "argo-cd", "7.6.8", "v2.12.4", 17, 22 * D],
  ["deployed", "external-dns", "external-dns", "prod-eu-west-1", "external-dns", "1.15.0", "0.15.0", 7, 63 * D],
  ["deployed", "external-dns", "external-dns", "prod-us-east-1", "external-dns", "1.15.0", "0.15.0", 7, 63 * D],
  ["deployed", "karpenter", "karpenter", "prod-eu-west-1", "karpenter", "1.0.6", "1.0.6", 11, 19 * D],
  ["deployed", "karpenter", "karpenter", "prod-us-east-1", "karpenter", "1.0.6", "1.0.6", 10, 19 * D],
  ["deployed", "redis-cart", "storefront", "prod-us-east-1", "redis", "19.6.4", "7.2.5", 14, 47 * D],
  ["deployed", "aws-load-balancer-controller", "kube-system", "prod-us-east-1", "aws-load-balancer-controller", "1.8.3", "v2.8.3", 6, 88 * D],
  ["deployed", "aws-load-balancer-controller", "kube-system", "prod-eu-west-1", "aws-load-balancer-controller", "1.8.3", "v2.8.3", 6, 88 * D],
  ["deployed", "metrics-server", "kube-system", "prod-eu-west-1", "metrics-server", "3.12.1", "0.7.1", 4, 120 * D],
  ["deployed", "metrics-server", "kube-system", "prod-us-east-1", "metrics-server", "3.12.1", "0.7.1", 4, 120 * D],
  ["deployed", "flux", "flux-system", "staging-eu-1", "flux2", "2.14.0", "2.4.0", 4, 30 * D],
  ["deployed", "loki", "logging", "staging-eu-1", "loki", "6.16.0", "3.1.1", 3, 33 * D],
  ["deployed", "cert-manager", "cert-manager", "staging-eu-1", "cert-manager", "v1.16.0", "v1.16.0", 10, 9 * D],
  ["deployed", "ingress-nginx", "ingress-nginx", "staging-eu-1", "ingress-nginx", "4.11.3", "1.11.3", 19, 12 * D],
  ["deployed", "kube-prometheus-stack", "monitoring", "staging-eu-1", "kube-prometheus-stack", "62.7.0", "v0.76.1", 29, 8 * D],
  ["deployed", "argo-cd", "argocd", "staging-eu-1", "argo-cd", "7.6.8", "v2.12.4", 12, 22 * D],
  ["deployed", "external-secrets", "external-secrets", "staging-eu-1", "external-secrets", "0.10.4", "v0.10.4", 6, 52 * D],
  ["deployed", "external-secrets", "external-secrets", "prod-eu-west-1", "external-secrets", "0.10.4", "v0.10.4", 6, 52 * D],
  ["deployed", "external-secrets", "external-secrets", "prod-us-east-1", "external-secrets", "0.10.4", "v0.10.4", 6, 52 * D],
  ["deployed", "velero", "velero", "prod-eu-west-1", "velero", "7.2.1", "1.14.1", 5, 74 * D],
  ["deployed", "velero", "velero", "prod-us-east-1", "velero", "7.2.1", "1.14.1", 5, 74 * D],
];

const PAYMENTS_WORKERS_HISTORY: HelmRevision[] = [
  { rev: 8, status: "failed", chartVersion: "2.4.0", appVersion: "1.9.0", updatedSeconds: 26 * M, description: "Upgrade \"payments-workers\" failed: context deadline exceeded" },
  { rev: 7, status: "deployed", chartVersion: "2.3.2", appVersion: "1.8.4", updatedSeconds: 6 * D, description: "Upgrade complete" },
  { rev: 6, status: "superseded", chartVersion: "2.3.1", appVersion: "1.8.3", updatedSeconds: 12 * D, description: "Upgrade complete" },
  { rev: 5, status: "superseded", chartVersion: "2.3.0", appVersion: "1.8.0", updatedSeconds: 19 * D, description: "Upgrade complete" },
  { rev: 4, status: "superseded", chartVersion: "2.2.4", appVersion: "1.7.6", updatedSeconds: 33 * D, description: "Upgrade complete" },
  { rev: 3, status: "superseded", chartVersion: "2.2.2", appVersion: "1.7.4", updatedSeconds: 47 * D, description: "Upgrade complete" },
  { rev: 2, status: "superseded", chartVersion: "2.2.0", appVersion: "1.7.0", updatedSeconds: 61 * D, description: "Upgrade complete" },
  { rev: 1, status: "superseded", chartVersion: "2.1.0", appVersion: "1.6.2", updatedSeconds: 90 * D, description: "Install complete" },
];

function historyFor(s: Seed): HelmRevision[] {
  const [status, name, , cluster, , chartVersion, appVersion, rev, updated] = s;
  if (name === "payments-workers" && cluster === "staging-eu-1") return PAYMENTS_WORKERS_HISTORY;
  const out: HelmRevision[] = [{ rev, status, chartVersion, appVersion, updatedSeconds: updated, description: status === "pending-upgrade" ? "Preparing upgrade" : "Upgrade complete" }];
  for (let r = rev - 1; r >= Math.max(1, rev - 4); r--) {
    out.push({
      rev: r,
      status: status === "pending-upgrade" && r === rev - 1 ? "deployed" : "superseded",
      chartVersion,
      appVersion,
      updatedSeconds: updated + (rev - r) * 9 * D,
      description: r === 1 ? "Install complete" : "Upgrade complete",
    });
  }
  return out;
}

const VALUES: Record<string, string> = {
  "payments-workers": `replicaCount: 3
image:
  repository: ghcr.io/acme/payments-workers
  tag: 1.9.0
resources:
  requests:
    cpu: 200m
    memory: 256Mi
  limits:
    memory: 512Mi
queue:
  url: amqp://rabbitmq.payments.svc:5672
  password: "[redacted by Clustrail]"
cron:
  reconcile: "*/10 * * * *"
serviceMonitor:
  enabled: true
`,
};

export const helmReleases: HelmRelease[] = SEEDS.map((s) => {
  const [status, name, namespace, cluster, chart, chartVersion, appVersion, revision, updatedSeconds] = s;
  return {
    id: `${cluster}/${namespace}/${name}`,
    name,
    namespace,
    cluster,
    env: envOf(cluster),
    status,
    health: helmHealth(status),
    chart,
    chartVersion,
    appVersion,
    revision,
    updatedSeconds,
    // Public charts come from known repos; internal acme/* charts are pushed from CI.
    repoKnown: !["payments-workers"].includes(chart),
    history: historyFor(s),
    values: VALUES[name] ?? `# ${name}: no user-supplied values (chart defaults)\n`,
    notes:
      name === "payments-workers"
        ? "payments-workers is deployed.\nQueue consumers start after the db-migrate-check hook succeeds."
        : `${name} has been installed. See the chart README for configuration.`,
    resources:
      name === "payments-workers"
        ? [
            { kind: "Deployment", name: "payments-workers" },
            { kind: "ConfigMap", name: "payments-workers" },
            { kind: "CronJob", name: "payments-workers-reconcile" },
            { kind: "ServiceMonitor", name: "payments-workers-v2" },
            { kind: "Job", name: "db-migrate-check" },
          ]
        : [
            { kind: "Deployment", name },
            { kind: "Service", name },
            { kind: "ServiceAccount", name },
          ],
  };
});

/** What a rollback to `rev` changes, from the manifests of both revisions. */
export function rollbackPlan(r: HelmRelease, rev: number): { changed: string; removed?: string; hooks?: string; options: string } {
  const target = r.history.find((h) => h.rev === rev);
  if (r.name === "payments-workers" && rev === 7)
    return {
      changed: `3 resources — Deployment image 1.9.0 → 1.8.4, ConfigMap 2 keys, CronJob schedule`,
      removed: "ServiceMonitor payments-workers-v2",
      hooks: "post-rollback Job db-migrate-check",
      options: "wait 5m · no force · no cleanup-on-fail",
    };
  return {
    changed: `Deployment image ${r.appVersion} → ${target?.appVersion ?? "?"}`,
    options: "wait 5m · no force · no cleanup-on-fail",
  };
}

// ---------------------------------------------------------------------------
// Desktop mode: the rollback summary from the two stored manifests.


export interface RollbackPlan {
  changed: string;
  removed?: string;
  added?: string;
  hooks?: string;
  options: string;
}

interface ManifestDoc {
  key: string;
  text: string;
  images: string[];
}

function manifestDocs(manifest: string): Map<string, ManifestDoc> {
  const out = new Map<string, ManifestDoc>();
  for (const doc of parseAllDocuments(manifest)) {
    const obj = doc.toJS() as { kind?: string; metadata?: { name?: string } } | null;
    if (!obj?.kind) continue;
    const key = `${obj.kind} ${obj.metadata?.name ?? ""}`.trim();
    // "# Source:" comments name the template file; they do not change the object.
    const text = doc.toString().replace(/^# Source:.*$/gm, "").trim();
    const images = [...text.matchAll(/^\s*image:\s*"?([^"\s]+)"?/gm)].map((m) => m[1]!);
    out.set(key, { key, text, images });
  }
  return out;
}

const tag = (image: string) => image.slice(image.lastIndexOf(":") + 1);

/** What `helm rollback` to the target revision changes, from the two stored manifests. */
export function planFromManifests(current: string, target: string, targetHooks: { name: string; kind: string; events: string[] }[]): RollbackPlan {
  const a = manifestDocs(current);
  const b = manifestDocs(target);
  const changed: string[] = [];
  for (const [key, doc] of b) {
    const before = a.get(key);
    if (!before || before.text === doc.text) continue;
    const imgFrom = before.images.find((img, i) => img !== doc.images[i]);
    const imgTo = doc.images[before.images.indexOf(imgFrom ?? "")];
    changed.push(imgFrom && imgTo ? `${key} image ${tag(imgFrom)} → ${tag(imgTo)}` : key);
  }
  const removed = [...a.keys()].filter((k) => !b.has(k));
  const added = [...b.keys()].filter((k) => !a.has(k));
  const hooks = targetHooks.filter((h) => h.events.some((e) => e === "pre-rollback" || e === "post-rollback"));
  return {
    changed: changed.length ? `${changed.length} resource${changed.length === 1 ? "" : "s"} — ${changed.join(", ")}` : "no resource changes",
    removed: removed.length ? removed.join(", ") : undefined,
    added: added.length ? added.join(", ") : undefined,
    hooks: hooks.length ? hooks.map((h) => `${h.events.filter((e) => e.endsWith("rollback")).join("/")} ${h.kind} ${h.name}`).join(", ") : undefined,
    options: "wait 5m · no force · no cleanup-on-fail",
  };
}
