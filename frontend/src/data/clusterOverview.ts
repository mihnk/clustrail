// Mock per-cluster overview: discovery (version, provider), node and capacity
// summaries from the node/pod caches, metrics-server usage, detected add-ons.
// The Go backend computes these from the same informers the explorers use.

import type { Cluster, DeploymentRow, Health, PodRow } from "./types";
import type { NodeRow } from "./nodes";
import type { HelmRelease } from "./helm";
import type { GitOpsObject } from "./gitops";

export interface Capacity {
  used: number | null;
  requested: number;
  allocatable: number;
}

export interface ClusterOverview {
  id: string;
  provider: string;
  region: string;
  /** Short version for tables, full gitVersion for the inspector. */
  version: string;
  gitVersion: string;
  /** Last part of the context shown under the name, e.g. "4821…/prod-eu-west-1". */
  contextHint: string;
  nodes: { ready: number; total: number };
  /** One-line problems summary for the table, e.g. "1 workload degraded". */
  problems: string | null;
  cpu: Capacity;
  memoryGiB: Capacity;
  apiServer: string;
  /** p95 needs a latency history; the desktop build reports the last probe only. */
  latency: { p50: number; p95: number | null };
  auth: string;
  watching: { types: number; objects: number };
  components: { name: string; health: Health; text: string }[];
  attention: { health: Health; name: string; detail: string; fact?: string; link?: "gitops" }[];
  quick: { deployments: number; deploymentsAttention: number; events: number; helm: number; gitops: string | null };
}

export const clusterOverviews: Record<string, ClusterOverview> = {
  "prod-eu-west-1": {
    id: "prod-eu-west-1",
    provider: "EKS",
    region: "eu-west-1",
    version: "v1.30.4",
    gitVersion: "v1.30.4-eks-a737599",
    contextHint: "4821…/prod-eu-west-1",
    nodes: { ready: 18, total: 18 },
    problems: "1 workload degraded",
    cpu: { used: 29.6, requested: 50.1, allocatable: 70.4 },
    memoryGiB: { used: 174, requested: 201, allocatable: 276 },
    apiServer: "https://4F3A…C1.gr7.eu-west-1.eks.amazonaws.com",
    latency: { p50: 38, p95: 71 },
    auth: "exec · aws eks get-token",
    watching: { types: 23, objects: 6412 },
    components: [
      { name: "Metrics", health: "healthy", text: "metrics-server v0.7.1" },
      { name: "GitOps", health: "healthy", text: "Argo CD v2.12.4 · Flux not found" },
      { name: "Gateway API", health: "unknown", text: "CRDs not installed" },
    ],
    attention: [
      { health: "failed", name: "checkout-api", detail: "Deployment · payments", fact: "2/4" },
      { health: "failed", name: "2 pods", detail: "CrashLoopBackOff · OOMKilled", fact: "14 ↻" },
      { health: "warning", name: "payments-gateway", detail: "Argo CD · OutOfSync", link: "gitops" },
    ],
    quick: { deployments: 41, deploymentsAttention: 1, events: 14, helm: 12, gitops: "9 apps" },
  },
  "prod-us-east-1": {
    id: "prod-us-east-1",
    provider: "EKS",
    region: "us-east-1",
    version: "v1.30.4",
    gitVersion: "v1.30.4-eks-a737599",
    contextHint: "4821…/prod-us-east-1",
    nodes: { ready: 14, total: 14 },
    problems: "1 job failed · 1 pod pending",
    cpu: { used: 32.4, requested: 41.2, allocatable: 56 },
    memoryGiB: { used: 181, requested: 192, allocatable: 216 },
    apiServer: "https://9B21…7E.yl4.us-east-1.eks.amazonaws.com",
    latency: { p50: 112, p95: 204 },
    auth: "exec · aws eks get-token",
    watching: { types: 23, objects: 5980 },
    components: [
      { name: "Metrics", health: "healthy", text: "metrics-server v0.7.1" },
      { name: "GitOps", health: "healthy", text: "Argo CD v2.12.4 · Flux not found" },
      { name: "Gateway API", health: "unknown", text: "CRDs not installed" },
    ],
    attention: [
      { health: "failed", name: "invoice-render-28734410", detail: "Job · billing", fact: "failed" },
      { health: "progressing", name: "search-indexer-2", detail: "Pending · Unschedulable" },
    ],
    quick: { deployments: 33, deploymentsAttention: 0, events: 9, helm: 11, gitops: "7 apps" },
  },
  "staging-eu-1": {
    id: "staging-eu-1",
    provider: "GKE",
    region: "europe-west4",
    version: "v1.31.2",
    gitVersion: "v1.31.2-gke.1115000",
    contextHint: "gke_acme-stg_…",
    nodes: { ready: 6, total: 6 },
    problems: "1 workload degraded",
    cpu: { used: 5.3, requested: 9.8, allocatable: 24 },
    memoryGiB: { used: 38, requested: 44, allocatable: 96 },
    apiServer: "https://34.90.12.7",
    latency: { p50: 64, p95: 98 },
    auth: "exec · gke-gcloud-auth-plugin",
    watching: { types: 21, objects: 1874 },
    components: [
      { name: "Metrics", health: "healthy", text: "metrics-server v0.7.0" },
      { name: "GitOps", health: "healthy", text: "Flux v2.3.0 · Argo CD not found" },
      { name: "Gateway API", health: "healthy", text: "v1.1.0 CRDs" },
    ],
    attention: [{ health: "failed", name: "ledger-sync", detail: "Deployment · payments · ImagePullBackOff", fact: "0/1" }],
    quick: { deployments: 12, deploymentsAttention: 1, events: 6, helm: 8, gitops: "4 kustomizations" },
  },
  "staging-perf": {
    id: "staging-perf",
    provider: "GKE",
    region: "europe-west4",
    version: "—",
    gitVersion: "—",
    contextHint: "gke_acme-perf_…",
    nodes: { ready: 0, total: 0 },
    problems: null,
    cpu: { used: null, requested: 0, allocatable: 0 },
    memoryGiB: { used: null, requested: 0, allocatable: 0 },
    apiServer: "https://35.204.88.2",
    latency: { p50: 0, p95: 0 },
    auth: "exec · gke-gcloud-auth-plugin",
    watching: { types: 0, objects: 0 },
    components: [],
    attention: [],
    quick: { deployments: 0, deploymentsAttention: 0, events: 0, helm: 0, gitops: null },
  },
  "dev-shared": {
    id: "dev-shared",
    provider: "k3s",
    region: "dev.acme.internal:6443",
    version: "v1.29.6",
    gitVersion: "v1.29.6+k3s2",
    contextHint: "dev.acme.internal:6443",
    nodes: { ready: 3, total: 3 },
    problems: null,
    cpu: { used: 2.1, requested: 3.4, allocatable: 12 },
    memoryGiB: { used: 9, requested: 11, allocatable: 48 },
    apiServer: "https://dev.acme.internal:6443",
    latency: { p50: 22, p95: 40 },
    auth: "client certificate",
    watching: { types: 19, objects: 640 },
    components: [
      { name: "Metrics", health: "healthy", text: "metrics-server v0.7.1" },
      { name: "GitOps", health: "unknown", text: "Argo CD and Flux not found" },
    ],
    attention: [],
    quick: { deployments: 9, deploymentsAttention: 0, events: 2, helm: 3, gitops: null },
  },
  "kind-local": {
    id: "kind-local",
    provider: "kind",
    region: "127.0.0.1:6443",
    version: "—",
    gitVersion: "—",
    contextHint: "127.0.0.1:6443",
    nodes: { ready: 0, total: 0 },
    problems: null,
    cpu: { used: null, requested: 0, allocatable: 0 },
    memoryGiB: { used: null, requested: 0, allocatable: 0 },
    apiServer: "https://127.0.0.1:6443",
    latency: { p50: 0, p95: 0 },
    auth: "client certificate",
    watching: { types: 0, objects: 0 },
    components: [],
    attention: [],
    quick: { deployments: 0, deploymentsAttention: 0, events: 0, helm: 0, gitops: null },
  },
};

// ---------------------------------------------------------------------------
// Desktop mode: the same overview, derived from the rows the backend streams.


const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const round1 = (v: number) => Math.round(v * 10) / 10;

export function overviewFromRows(
  c: Cluster,
  rows: { pods: PodRow[]; deployments: DeploymentRow[]; nodes: NodeRow[]; helm: HelmRelease[]; gitops: GitOpsObject[] },
  controller?: { tool: string | null; version?: string },
): ClusterOverview {
  const pods = rows.pods.filter((p) => p.cluster === c.id);
  const deps = rows.deployments.filter((d) => d.cluster === c.id);
  const nodes = rows.nodes.filter((n) => n.cluster === c.id);
  const failingDeps = deps.filter((d) => d.health === "failed" || d.health === "warning");
  const failingPods = pods.filter((p) => p.health === "failed");
  // Unknown until the first connect: no provider is guessed.
  const [provider = "", ...rest] = (c.summary ?? "").split(" · ")[0]!.split(" ");
  const region = (c.summary ?? "").split(" · ")[1] ?? nodes.find((n) => n.labels["topology.kubernetes.io/region"])?.labels["topology.kubernetes.io/region"] ?? "";
  const usedKnown = nodes.length > 0 && nodes.every((n) => n.cpu.used !== null);
  const problems = [
    failingDeps.length && `${failingDeps.length} workload${failingDeps.length === 1 ? "" : "s"} degraded`,
    failingPods.length && `${failingPods.length} pod${failingPods.length === 1 ? "" : "s"} failing`,
    nodes.some((n) => n.health === "failed") && `${nodes.filter((n) => n.health === "failed").length} node NotReady`,
  ].filter(Boolean);
  const gitops = rows.gitops.filter((g) => g.cluster === c.id);
  const drift = gitops.filter((g) => g.sync === "OutOfSync").length;
  return {
    id: c.id,
    provider,
    region,
    version: rest.join(" ") || (c.version ?? "").replace(/^v(\d+\.\d+).*/, "$1"),
    gitVersion: c.version ?? "",
    contextHint: c.context.length > 32 ? `…${c.context.slice(-28)}` : c.context,
    nodes: { ready: nodes.filter((n) => n.health !== "failed").length, total: nodes.length },
    problems: problems.length ? problems.join(" · ") : null,
    cpu: {
      used: usedKnown ? round1(sum(nodes.map((n) => n.cpu.used ?? 0))) : null,
      requested: round1(sum(nodes.map((n) => n.cpu.requests))),
      allocatable: round1(sum(nodes.map((n) => n.cpu.allocatable))),
    },
    memoryGiB: {
      used: usedKnown ? Math.round(sum(nodes.map((n) => n.memoryGiB.used ?? 0))) : null,
      requested: Math.round(sum(nodes.map((n) => n.memoryGiB.requests))),
      allocatable: Math.round(sum(nodes.map((n) => n.memoryGiB.allocatable))),
    },
    apiServer: c.server ?? "",
    latency: { p50: c.latencyMs ?? 0, p95: null },
    auth: c.auth ?? "",
    watching: { types: 5 + (rows.helm.some((h) => h.cluster === c.id) ? 1 : 0) + (gitops.length ? 1 : 0), objects: pods.length + deps.length + nodes.length },
    components: [
      { name: "metrics-server", health: c.metrics ? "healthy" : "unknown", text: c.metrics ? "metrics.k8s.io served" : "not installed · usage unavailable" },
      ...(controller?.tool ? [{ name: controller.tool, health: "healthy" as const, text: `CRDs served${controller.version ? ` · ${controller.version}` : ""}` }] : []),
    ],
    attention: [
      ...failingDeps.slice(0, 3).map((d) => ({ health: d.health, name: d.name, detail: `Deployment · ${d.namespace}`, fact: `${d.readyReplicas}/${d.replicas}` })),
      ...failingPods.slice(0, 2).map((p) => ({ health: p.health, name: p.name, detail: p.reason, fact: p.restarts ? `${p.restarts} ↻` : undefined })),
      ...gitops
        .filter((g) => g.sync === "OutOfSync")
        .slice(0, 2)
        .map((g) => ({ health: "warning" as const, name: g.name, detail: `${g.tool} · OutOfSync`, link: "gitops" as const })),
    ],
    quick: {
      deployments: deps.length,
      deploymentsAttention: failingDeps.length,
      events: 0,
      helm: rows.helm.filter((h) => h.cluster === c.id).length,
      gitops: gitops.length ? `${gitops.length} apps${drift ? ` · ${drift} drift` : ""}` : null,
    },
  };
}
