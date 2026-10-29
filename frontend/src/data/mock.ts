// Mock data for UI development. Replaced by Wails bindings to the Go
// backend once the cluster connection manager exists. The status bar shows
// a "MOCK DATA" badge while this module is the data source.

import type { Cluster, DeploymentRow, Environment, Health, PodDetail, PodRow } from "./types";

export const IS_MOCK = true;

export const clusters: Cluster[] = [
  { id: "prod-eu-west-1", name: "prod-eu-west-1", env: "prod", protected: true, connection: "connected", latencyMs: 38, summary: "EKS 1.30 · eu-west-1" },
  { id: "prod-us-east-1", name: "prod-us-east-1", env: "prod", protected: true, connection: "connected", latencyMs: 112, summary: "EKS 1.30 · us-east-1" },
  { id: "staging-eu-1", name: "staging-eu-1", env: "stg", protected: false, connection: "connected", latencyMs: 64, summary: "GKE 1.31 · europe-west4" },
  { id: "staging-perf", name: "staging-perf", env: "stg", protected: false, connection: "disconnected", latencyMs: null, summary: null },
  { id: "dev-shared", name: "dev-shared", env: "dev", protected: false, connection: "disconnected", latencyMs: null, summary: null },
  { id: "kind-local", name: "kind-local", env: "dev", protected: false, connection: "disconnected", latencyMs: null, summary: null },
];

export const initialSelectedClusters = ["prod-eu-west-1", "prod-us-east-1", "staging-eu-1"];

const STATUS: Record<string, { health: Health; status: string; reason: string }> = {
  crash: { health: "failed", status: "CrashLoop", reason: "CrashLoopBackOff" },
  pull: { health: "failed", status: "ImagePull", reason: "ImagePullBackOff" },
  error: { health: "failed", status: "Error", reason: "Error (exit 1)" },
  pending: { health: "progressing", status: "Pending", reason: "Unschedulable: 0/12 nodes have enough memory" },
  restart: { health: "warning", status: "Restarting", reason: "Running, 6 restarts in the last hour" },
  term: { health: "terminating", status: "Terminating", reason: "Terminating" },
  run: { health: "healthy", status: "Running", reason: "Running" },
  done: { health: "completed", status: "Completed", reason: "Completed" },
};

type Seed = [keyof typeof STATUS, string, string, string, string, number, number | null, number | null, number];

const H = 3600;
const D = 86400;

// The rows of the approved Pods explorer design, in design order.
const seeds: Seed[] = [
  ["crash", "checkout-api-7d9f8b6c4-x2kqp", "payments", "prod-eu-west-1", "1/2", 14, 212, 251, 3 * D],
  ["crash", "checkout-api-7d9f8b6c4-m8vtn", "payments", "prod-eu-west-1", "1/2", 11, 198, 248, 3 * D],
  ["pull", "ledger-sync-5b6d9c7f8-q4wzr", "payments", "staging-eu-1", "0/1", 0, null, null, 12 * 60],
  ["error", "invoice-render-28734410-7kd2p", "billing", "prod-us-east-1", "0/1", 2, null, null, 41 * 60],
  ["pending", "search-indexer-2", "catalog", "prod-us-east-1", "0/1", 0, null, null, 6 * 60],
  ["restart", "notifications-worker-7c9d8f6b5-cn4px", "messaging", "staging-eu-1", "1/1", 6, 88, 164, D],
  ["term", "cart-web-6f8c7d5b9-2xhls", "storefront", "prod-us-east-1", "1/1", 0, 4, 92, 2 * D],
  ["run", "checkout-api-7d9f8b6c4-9rkzd", "payments", "prod-eu-west-1", "2/2", 0, 184, 231, 3 * D],
  ["run", "checkout-api-7d9f8b6c4-h2pqs", "payments", "prod-eu-west-1", "2/2", 0, 176, 226, 3 * D],
  ["run", "payments-gateway-84f6d7c9b-vt5nx", "payments", "prod-eu-west-1", "2/2", 0, 96, 188, 9 * D],
  ["run", "payments-gateway-84f6d7c9b-zl8wm", "payments", "prod-us-east-1", "2/2", 0, 88, 179, 9 * D],
  ["run", "fraud-scorer-6bd8f9c7d-kq2jt", "risk", "prod-eu-west-1", "1/1", 0, 410, 1229, 5 * D],
  ["run", "fraud-scorer-6bd8f9c7d-w7xhb", "risk", "prod-us-east-1", "1/1", 1, 392, 1126, 5 * D],
  ["run", "cart-web-6f8c7d5b9-p7wnr", "storefront", "prod-us-east-1", "1/1", 0, 38, 104, 2 * D],
  ["run", "cart-web-6f8c7d5b9-rt4mz", "storefront", "staging-eu-1", "1/1", 0, 12, 86, D],
  ["run", "catalog-api-5c7b8d9f6-ws3xv", "catalog", "prod-us-east-1", "1/1", 0, 64, 142, 14 * D],
  ["run", "search-indexer-0", "catalog", "prod-us-east-1", "1/1", 0, 820, 3482, 21 * D],
  ["run", "search-indexer-1", "catalog", "prod-us-east-1", "1/1", 0, 794, 3379, 21 * D],
  ["run", "redis-cart-0", "storefront", "prod-us-east-1", "1/1", 0, 22, 312, 47 * D],
  ["run", "ledger-sync-7f4c8b9d5-jx6nl", "payments", "staging-eu-1", "1/1", 0, 31, 96, 4 * D],
  ["run", "notifications-worker-7c9d8f6b5-d2kfs", "messaging", "prod-eu-west-1", "1/1", 0, 54, 121, 6 * D],
  ["run", "invoice-api-6c5d7b8f9-n3vzq", "billing", "prod-us-east-1", "1/1", 0, 41, 118, 11 * D],
  ["done", "invoice-render-28734380-r9tq2", "billing", "prod-us-east-1", "0/1", 0, null, null, H],
  ["done", "risk-rules-sync-28734400-bz5mq", "risk", "prod-eu-west-1", "0/1", 0, null, null, 58 * 60],
];

const envOf = (cluster: string): Environment =>
  cluster.startsWith("prod") ? "prod" : cluster.startsWith("staging") ? "stg" : "dev";

const nodeDomain: Record<string, string> = {
  "prod-eu-west-1": "eu-west-1.compute.internal",
  "prod-us-east-1": "ec2.internal",
  "staging-eu-1": "eu-west-1.compute.internal",
};
const nodeNet: Record<string, string> = { "prod-eu-west-1": "42", "prod-us-east-1": "61", "staging-eu-1": "80" };

// Small deterministic PRNG so the mock list is identical on every load.
function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function nodeFor(cluster: string, n: number) {
  if (cluster.startsWith("staging")) {
    return `gke-stg-pool-${n % 2 ? "b" : "a"}-${alphabet.slice(n % 20, (n % 20) + 4)}`;
  }
  return `ip-10-${nodeNet[cluster] ?? "90"}-${(n % 12) + 1}-${17 + ((n * 7) % 200)}.${nodeDomain[cluster] ?? "internal"}`;
}

function ownerOf(name: string): PodRow["owner"] {
  if (/-\d{8}-[a-z0-9]{5}$/.test(name)) return { kind: "Job", name: name.replace(/-[a-z0-9]{5}$/, "") };
  if (/-[a-z0-9]{8,10}-[a-z0-9]{5}$/.test(name)) return { kind: "ReplicaSet", name: name.replace(/-[a-z0-9]{5}$/, "") };
  const sts = name.match(/^(.*)-\d+$/);
  if (sts?.[1]) return { kind: "StatefulSet", name: sts[1] };
  return null;
}

function toRow(seed: Seed, n: number): PodRow {
  const [kind, name, namespace, cluster, ready, restarts, cpu, mem, age] = seed;
  const s = STATUS[kind]!;
  const [r, t] = ready.split("/").map(Number) as [number, number];
  return {
    id: `${cluster}/${namespace}/${name}`,
    name,
    namespace,
    cluster,
    env: envOf(cluster),
    node: name === "checkout-api-7d9f8b6c4-x2kqp" ? "ip-10-42-3-17.eu-west-1.compute.internal" : nodeFor(cluster, n),
    health: s.health,
    status: s.status,
    reason: s.reason,
    readyContainers: r,
    totalContainers: t,
    restarts,
    cpuMilli: cpu,
    memoryMiB: mem,
    ageSeconds: age,
    owner: ownerOf(name),
    labels: labelsFor(name, namespace),
  };
}

/** Recommended app labels plus a tier, derived from the workload name. */
function labelsFor(name: string, namespace: string): Record<string, string> {
  const app = name.replace(/-[a-z0-9]{8,10}-[a-z0-9]{5}$|-\d{8}-[a-z0-9]{5}$|-\d+$/, "");
  const tier = /redis|store|indexer/.test(app) ? "data" : /-web$|storefront-web/.test(app) ? "frontend" : "backend";
  return { "app.kubernetes.io/name": app, "app.kubernetes.io/part-of": namespace, tier };
}

const fillerApps: [string, string, number, number][] = [
  // app, namespace, typical cpu (m), typical memory (Mi)
  ["orders-api", "orders", 120, 210],
  ["orders-worker", "orders", 60, 150],
  ["inventory-api", "catalog", 70, 180],
  ["pricing-engine", "catalog", 240, 520],
  ["session-store", "storefront", 30, 260],
  ["storefront-web", "storefront", 45, 130],
  ["email-dispatch", "messaging", 25, 96],
  ["sms-gateway", "messaging", 18, 84],
  ["risk-api", "risk", 150, 330],
  ["billing-api", "billing", 55, 140],
  ["tax-calculator", "billing", 35, 110],
  ["payments-webhooks", "payments", 40, 120],
  ["recommendation-api", "catalog", 310, 780],
  ["image-resizer", "storefront", 90, 240],
];

const alphabet = "bcdfghjklmnpqrstvwxz2456789";

function generateFiller(count: number): PodRow[] {
  const rand = prng(412);
  const targets = ["prod-eu-west-1", "prod-us-east-1", "staging-eu-1"];
  const pick = (len: number) => Array.from({ length: len }, () => alphabet[Math.floor(rand() * alphabet.length)]).join("");
  const hashes = new Map<string, string>();
  const rows: PodRow[] = [];
  for (let i = 0; i < count; i++) {
    const [app, ns, cpu, mem] = fillerApps[i % fillerApps.length]!;
    const cluster = targets[Math.floor(rand() * targets.length)]!;
    const key = `${cluster}/${app}`;
    if (!hashes.has(key)) hashes.set(key, `${Math.floor(rand() * 0xffffffff).toString(16).slice(0, 9).padStart(9, "6")}`);
    const name = `${app}-${hashes.get(key)}-${pick(5)}`;
    const jitter = 0.6 + rand() * 0.8;
    rows.push(
      toRow(
        [
          "run",
          name,
          ns,
          cluster,
          "1/1",
          rand() < 0.04 ? 1 : 0,
          Math.round(cpu * jitter),
          Math.round(mem * jitter),
          Math.floor((1 + rand() * 30) * D),
        ],
        i + seeds.length,
      ),
    );
  }
  return rows;
}

export const pods: PodRow[] = [...seeds.map(toRow), ...generateFiller(412 - seeds.length)];

// ---------------------------------------------------------------------------
// Deployments (payments namespace on prod-eu-west-1)

type DeploySeed = [string, number, number, number, number, DeploymentRow["strategy"], number];
const rolling = (maxSurge: string, maxUnavailable: string): DeploymentRow["strategy"] => ({
  type: "RollingUpdate",
  maxSurge,
  maxUnavailable,
});
const Y = 365 * D;

const deploySeeds: DeploySeed[] = [
  // name, ready, replicas, up-to-date, available, strategy, age
  ["checkout-api", 2, 4, 4, 2, rolling("1", "1"), 212 * D],
  ["payments-gateway", 3, 3, 3, 3, rolling("25%", "25%"), Y],
  ["fraud-scorer", 2, 2, 2, 2, rolling("1", "0"), 144 * D],
  ["ledger-sync", 2, 2, 2, 2, { type: "Recreate" }, 96 * D],
  ["refunds-api", 2, 2, 2, 2, rolling("25%", "25%"), 301 * D],
  ["payouts-scheduler", 1, 1, 1, 1, { type: "Recreate" }, 88 * D],
  ["currency-rates", 2, 2, 2, 2, rolling("25%", "25%"), Y],
  ["webhook-dispatcher", 3, 3, 3, 3, rolling("1", "0"), 57 * D],
  ["tax-calculator", 2, 2, 2, 2, rolling("25%", "25%"), 230 * D],
];

export const deployments: DeploymentRow[] = deploySeeds.map(([name, ready, replicas, upd, avail, strategy, age]) => ({
  id: `prod-eu-west-1/payments/${name}`,
  name,
  namespace: "payments",
  cluster: "prod-eu-west-1",
  env: "prod",
  health: ready < replicas ? "failed" : "healthy",
  status: ready < replicas ? "Degraded" : "Available",
  readyReplicas: ready,
  replicas,
  updatedReplicas: upd,
  availableReplicas: avail,
  strategy,
  ageSeconds: age,
}));

/** Total Deployments across all namespaces of the cluster, for "9 of 86". */
export const deploymentTotal = 86;

/** Facts the restart dialog shows for a Deployment. */
export function getDeploymentState(d: DeploymentRow): { health: Health; text: string; mono?: string }[] {
  if (d.name !== "checkout-api") {
    return [{ health: "healthy", text: `All ${d.replicas} pods are ready.` }];
  }
  return [
    {
      health: "failed",
      text: "2 of 4 pods are unhealthy (CrashLoopBackOff, OOMKilled). A restart does not change the 256Mi memory limit.",
    },
    {
      health: "warning",
      text: "allows 0 disruptions. Rollouts are not blocked by PDBs, so ready capacity can drop during replacement.",
      mono: "PodDisruptionBudget checkout-api",
    },
    { health: "warning", text: "has 2 of 4 endpoints ready.", mono: "Service checkout-api" },
  ];
}

// ---------------------------------------------------------------------------
// Inspector details

const NOW = Math.floor(Date.UTC(2026, 9, 29, 10, 52, 0) / 1000);

/** One hour of 15 s samples climbing to the 256Mi limit and resetting at each OOMKill. */
function oomSawtooth() {
  const timestamps: number[] = [];
  const values: number[] = [];
  const markers: number[] = [];
  const kills = [NOW - 47 * 60, NOW - 32 * 60, NOW - 17 * 60, NOW - 2 * 60];
  let from = NOW - 60 * 60;
  let base = 196;
  for (let t = from; t <= NOW; t += 15) {
    const nextKill = kills.find((k) => k >= t);
    if (nextKill !== undefined && t >= nextKill - 7 && !markers.includes(nextKill)) {
      markers.push(nextKill);
      from = t;
      base = 150;
    }
    const sinceReset = (t - from) / 60;
    const v = Math.min(256, base + sinceReset * 7.4);
    timestamps.push(t);
    values.push(Math.round(v));
  }
  return { timestamps, values, markers };
}

export function getPodDetail(pod: PodRow): PodDetail {
  if (pod.name === "checkout-api-7d9f8b6c4-x2kqp") {
    const saw = oomSawtooth();
    return {
      pod,
      problem: {
        title: "CrashLoopBackOff",
        container: "api",
        detail: "Last terminated OOMKilled (exit 137) 2m ago · 14 restarts, first 52m ago",
      },
      containers: [
        {
          name: "api",
          health: "failed",
          state: "Waiting · CrashLoopBackOff",
          ready: false,
          restarts: 14,
          image: "ghcr.io/acme/checkout-api:v2.31.0",
          lastState: "Terminated · OOMKilled · exit 137",
          memory: "req 192Mi · limit 256Mi",
        },
        { name: "envoy", health: "healthy", state: "Running · ready", ready: true, restarts: 0 },
      ],
      events: [
        { type: "Warning", reason: "BackOff", object: "pod", count: 42, lastSeen: "1m", message: "Back-off restarting failed container api in pod checkout-api-7d9f8b6c4-x2kqp" },
        { type: "Warning", reason: "Killing", object: "pod", count: 14, lastSeen: "2m", message: "Container api exceeded its memory limit (256Mi): OOMKilled, exit code 137" },
        { type: "Warning", reason: "Unhealthy", object: "pod", count: 9, lastSeen: "3m", message: "Readiness probe failed: HTTP probe failed with statuscode: 503" },
        { type: "Normal", reason: "Pulled", object: "pod", count: 14, lastSeen: "4m", message: 'Container image "ghcr.io/acme/checkout-api:v2.31.0" already present on machine' },
        { type: "Normal", reason: "Started", object: "pod", count: 15, lastSeen: "4m", message: "Started container api" },
        { type: "Normal", reason: "ScalingReplicaSet", object: "deploy/checkout-api", count: 1, lastSeen: "3d", message: "Scaled up replica set checkout-api-7d9f8b6c4 to 4 (revision 14)" },
        { type: "Normal", reason: "Scheduled", object: "pod", count: 1, lastSeen: "3d", message: "Successfully assigned payments/checkout-api-7d9f8b6c4-x2kqp to ip-10-42-3-17" },
      ],
      memory: {
        container: "api",
        series: { source: "sampled from metrics-server · 15s", ...saw, limit: 256, request: 192 },
      },
      ownerChain: [
        { kind: "Deployment", name: "checkout-api", note: "2/4 ready", tone: "warning" },
        { kind: "ReplicaSet", name: "checkout-api-7d9f8b6c4", note: "rev 14" },
      ],
    };
  }

  const app = pod.owner?.name.replace(/-[a-z0-9]{8,10}$/, "") ?? pod.name;
  const containers = Array.from({ length: pod.totalContainers }, (_, i) => ({
    name: i === 0 ? "app" : "envoy",
    health: pod.health,
    state: pod.reason,
    ready: i < pod.readyContainers,
    restarts: i === 0 ? pod.restarts : 0,
    image: i === 0 ? `ghcr.io/acme/${app}:v1.${(pod.name.length * 7) % 40}.0` : undefined,
  }));
  return {
    pod,
    problem:
      pod.health === "failed" || pod.health === "warning" || pod.health === "progressing"
        ? {
            title: pod.health === "progressing" ? pod.status : pod.reason,
            container: containers[0]?.name ?? "",
            detail: pod.health === "progressing" ? pod.reason : `${pod.restarts} restarts`,
          }
        : null,
    containers,
    events: [],
    memory: null,
    ownerChain: pod.owner ? [{ kind: pod.owner.kind, name: pod.owner.name, note: "" }] : [],
  };
}
