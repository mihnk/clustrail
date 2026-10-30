// Mock nodes. The Go backend builds these from the node informer (status,
// conditions, taints, allocatable), the pod cache (requests, limits, pod
// counts) and metrics-server (current usage).

import type { Environment, Health } from "./types";

export interface NodeCondition {
  type: string;
  status: "True" | "False" | "Unknown";
  reason?: string;
  since: string;
  /** True when this status is the healthy one for the condition type. */
  ok: boolean;
}

export interface NodeRow {
  id: string;
  name: string;
  cluster: string;
  env: Environment;
  health: Health;
  status: string;
  reason: string;
  roles: string;
  version: string;
  gitVersion: string;
  instanceType: string;
  zone: string;
  /** Percent of allocatable used, null without metrics. */
  cpuPct: number | null;
  memPct: number | null;
  cpu: { used: number | null; requests: number; limits: number; allocatable: number };
  memoryGiB: { used: number | null; requests: number; allocatable: number };
  pods: number;
  podCapacity: number;
  taints: { key: string; value?: string; effect: "NoSchedule" | "PreferNoSchedule" | "NoExecute" }[];
  ageSeconds: number;
  conditions: NodeCondition[];
  heartbeat: string;
  cordonedBy?: string;
  cordonedAgo?: string;
  labels: Record<string, string>;
}

type Kind = "ok" | "cord" | "nr" | "mp";
const ST: Record<Kind, { health: Health; status: string; reason: string }> = {
  ok: { health: "healthy", status: "Ready", reason: "Ready=True" },
  cord: { health: "cordoned", status: "Cordoned", reason: "Ready, SchedulingDisabled" },
  nr: { health: "failed", status: "NotReady", reason: "Kubelet stopped posting node status 6m ago" },
  mp: { health: "warning", status: "MemPressure", reason: "MemoryPressure=True" },
};

const D = 86400;
const conds = (k: Kind): NodeCondition[] => [
  {
    type: "Ready",
    status: k === "nr" ? "Unknown" : "True",
    reason: k === "nr" ? "NodeStatusUnknown" : "KubeletReady",
    since: k === "nr" ? "6m" : "21d",
    ok: k !== "nr",
  },
  { type: "MemoryPressure", status: k === "mp" ? "True" : k === "nr" ? "Unknown" : "False", since: k === "mp" ? "14m" : "21d", ok: k !== "mp" && k !== "nr" },
  { type: "DiskPressure", status: k === "nr" ? "Unknown" : "False", since: "21d", ok: k !== "nr" },
  { type: "PIDPressure", status: k === "nr" ? "Unknown" : "False", since: "21d", ok: k !== "nr" },
  { type: "NetworkUnavailable", status: "False", since: "21d", ok: true },
];

type Seed = [Kind, string, string, number | null, number | null, number, number, number, number];

const meta: Record<string, { env: Environment; version: string; gitVersion: string; domain: string; zones: string[]; types: string[] }> = {
  "prod-eu-west-1": { env: "prod", version: "v1.30.4", gitVersion: "v1.30.4-eks-a737599", domain: "eu-west-1.compute.internal", zones: ["eu-west-1a", "eu-west-1b", "eu-west-1c"], types: ["m6i.2xlarge"] },
  "prod-us-east-1": { env: "prod", version: "v1.30.4", gitVersion: "v1.30.4-eks-a737599", domain: "ec2.internal", zones: ["us-east-1a", "us-east-1b"], types: ["m6i.2xlarge"] },
  "staging-eu-1": { env: "stg", version: "v1.31.2", gitVersion: "v1.31.2-gke.1115000", domain: "", zones: ["europe-west4-a", "europe-west4-b"], types: ["e2-standard-8"] },
};

const seeds: Record<string, Seed[]> = {
  // kind, host, roles, cpu%, mem%, pods, capacity, taints, age(days)
  "prod-eu-west-1": [
    ["cord", "ip-10-42-3-17", "worker", 40, 69, 31, 58, 1, 21],
    ["ok", "ip-10-42-5-88", "worker", 52, 74, 29, 58, 0, 21],
    ["ok", "ip-10-42-1-203", "worker", 38, 61, 27, 58, 0, 21],
    ["ok", "ip-10-42-7-41", "worker", 44, 66, 30, 58, 0, 14],
    ["ok", "ip-10-42-9-12", "worker · gpu", 71, 58, 9, 29, 1, 14],
    ["ok", "ip-10-42-2-66", "worker", 33, 57, 24, 58, 0, 9],
    ["ok", "ip-10-42-4-150", "system", 21, 46, 18, 58, 1, 61],
    ...Array.from({ length: 11 }, (_, i): Seed => ["ok", `ip-10-42-${10 + i}-${40 + i * 13}`, "worker", 30 + ((i * 7) % 30), 50 + ((i * 11) % 25), 20 + (i % 9), 58, 0, 7 + i]),
  ],
  "prod-us-east-1": [
    ["nr", "ip-10-61-9-201", "worker", null, null, 22, 58, 2, 33],
    ["mp", "ip-10-61-6-9", "worker", 64, 94, 35, 58, 1, 33],
    ["ok", "ip-10-61-6-33", "worker", 61, 88, 34, 58, 0, 33],
    ["ok", "ip-10-61-2-77", "worker", 55, 79, 30, 58, 0, 12],
    ["ok", "ip-10-61-4-19", "worker", 49, 73, 28, 58, 0, 12],
    ["ok", "ip-10-61-8-140", "worker", 58, 81, 31, 58, 0, 5],
    ...Array.from({ length: 8 }, (_, i): Seed => ["ok", `ip-10-61-${10 + i}-${21 + i * 17}`, "worker", 40 + ((i * 9) % 25), 60 + ((i * 7) % 20), 22 + (i % 8), 58, 0, 4 + i]),
  ],
  "staging-eu-1": Array.from({ length: 6 }, (_, i): Seed => [
    "ok",
    `gke-stg-pool-${i < 3 ? "a" : "b"}-${["9x2c", "k7m1", "2qwe", "t8vn", "p3lk", "w6rd"][i]}`,
    "worker",
    15 + i * 5,
    30 + i * 6,
    7 + i,
    110,
    0,
    30,
  ]),
};

const taintsFor = (k: Kind, roles: string): NodeRow["taints"] => {
  if (k === "cord") return [{ key: "node.kubernetes.io/unschedulable", effect: "NoSchedule" }];
  if (k === "nr") return [{ key: "node.kubernetes.io/unreachable", effect: "NoExecute" }, { key: "node.kubernetes.io/unreachable", effect: "NoSchedule" }];
  if (k === "mp") return [{ key: "node.kubernetes.io/memory-pressure", effect: "NoSchedule" }];
  if (roles.includes("gpu")) return [{ key: "nvidia.com/gpu", value: "present", effect: "NoSchedule" }];
  if (roles === "system") return [{ key: "CriticalAddonsOnly", value: "true", effect: "NoSchedule" }];
  return [];
};

export const nodes: NodeRow[] = Object.entries(seeds).flatMap(([cluster, rows]) =>
  rows.map(([k, host, roles, cpuPct, memPct, pods, cap, , age], i) => {
    const m = meta[cluster]!;
    const name = m.domain ? `${host}.${m.domain}` : host;
    const allocCpu = 7.91;
    const allocMem = 27.8;
    return {
      id: `${cluster}/${name}`,
      name,
      cluster,
      env: m.env,
      ...ST[k],
      roles,
      version: m.version,
      gitVersion: m.gitVersion,
      instanceType: roles.includes("gpu") ? "g5.2xlarge" : m.types[0]!,
      zone: m.zones[i % m.zones.length]!,
      cpuPct,
      memPct,
      cpu: {
        used: cpuPct === null ? null : +((cpuPct / 100) * allocCpu).toFixed(1),
        requests: k === "cord" ? 6.1 : +(((cpuPct ?? 50) / 100) * allocCpu * 1.6).toFixed(1),
        limits: k === "cord" ? 9.4 : +(((cpuPct ?? 50) / 100) * allocCpu * 2.2).toFixed(1),
        allocatable: allocCpu,
      },
      memoryGiB: {
        used: memPct === null ? null : +((memPct / 100) * allocMem).toFixed(1),
        requests: k === "cord" ? 24.1 : +(((memPct ?? 60) / 100) * allocMem * 1.1).toFixed(1),
        allocatable: allocMem,
      },
      pods,
      podCapacity: cap,
      taints: taintsFor(k, roles),
      ageSeconds: age * D,
      conditions: conds(k),
      heartbeat: k === "nr" ? "6m ago" : "9s ago",
      cordonedBy: k === "cord" ? "you in Clustrail" : undefined,
      cordonedAgo: k === "cord" ? "2m ago" : undefined,
      labels: {
        "kubernetes.io/hostname": host,
        "node.kubernetes.io/instance-type": roles.includes("gpu") ? "g5.2xlarge" : m.types[0]!,
        "topology.kubernetes.io/zone": m.zones[i % m.zones.length]!,
        ...(roles === "system" ? { "node-role.kubernetes.io/system": "" } : { "node-role.kubernetes.io/worker": "" }),
      },
    };
  }),
);

/** Drain preflight for a node: what happens to every pod on it. */
export interface DrainPreflight {
  evict: number;
  pdbBlocked: { pods: string[]; pdb: string };
  emptyDir: { pod: string; size: string }[];
  unmanaged: string[];
  daemonSets: string[];
  freeAfter: { cpu: number; memGiB: number; nodes: number };
  evictedRequests: { cpu: number; memGiB: number };
}

export function drainPreflight(node: NodeRow): DrainPreflight {
  if (node.name.startsWith("ip-10-42-3-17")) {
    return {
      evict: 22,
      pdbBlocked: { pods: ["payments/checkout-api-7d9f8b6c4-x2kqp", "payments/checkout-api-7d9f8b6c4-9rkzd"], pdb: "checkout-api" },
      emptyDir: [{ pod: "payments/payments-gateway-84f6d7c9b-vt5nx", size: "2.1 GiB" }],
      unmanaged: ["default/debug-shell-mk2"],
      daemonSets: ["aws-node", "kube-proxy", "ebs-csi-node", "fluent-bit", "otel-collector-agent"],
      freeAfter: { cpu: 21.4, memGiB: 61, nodes: 17 },
      evictedRequests: { cpu: 5.2, memGiB: 18.3 },
    };
  }
  const ds = node.cluster === "staging-eu-1" ? ["gke-metadata-server", "kube-proxy", "fluentbit-gke"] : ["aws-node", "kube-proxy", "ebs-csi-node"];
  return {
    evict: Math.max(0, node.pods - ds.length),
    pdbBlocked: { pods: [], pdb: "" },
    emptyDir: [],
    unmanaged: [],
    daemonSets: ds,
    freeAfter: { cpu: 18, memGiB: 52, nodes: 13 },
    evictedRequests: { cpu: 3.1, memGiB: 9.4 },
  };
}
