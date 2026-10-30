// Kubeconfig sources and connection diagnostics. The backend loads kubeconfig
// files with client-go's loading rules (KUBECONFIG, ~/.kube/config, files the
// user added), watches them for changes and runs exec/auth plugins locally.

import type { Cluster } from "./types";

export interface KubeconfigSource {
  path: string;
  /** e.g. "$KUBECONFIG" resolves to a real file shown underneath. */
  resolved?: string;
  contexts: number;
  watched: boolean;
  changed?: string;
  /** Unreadable or invalid file, verbatim. */
  error?: string;
}

export const kubeconfigSources: KubeconfigSource[] = [
  { path: "~/.kube/config", contexts: 5, watched: true, changed: "2m ago" },
  { path: "~/work/acme-perf.yaml", contexts: 1, watched: true },
  { path: "$KUBECONFIG", resolved: "~/.kube/kind-local.yaml", contexts: 1, watched: true },
];

/** Contexts that appeared in a watched kubeconfig and are not added yet. Never auto-connected. */
export const discoveredContexts: Cluster[] = [
  {
    id: "staging-eu-2",
    name: "staging-eu-2",
    context: "gke_acme-stg_europe-west4_staging-eu-2",
    env: "stg",
    protected: false,
    readOnly: false,
    connection: "disconnected",
    latencyMs: null,
    summary: null,
    metrics: "metrics-server",
    server: "https://34.90.77.140",
    auth: "exec · gcloud",
    source: "~/.kube/config",
  },
];

export type StepResult = "ok" | "failed" | "skipped";

export interface TestStep {
  name: string;
  result: StepResult;
  detail?: string;
  ms?: number;
}

/** The connection test runs these steps in order and stops at the first failure. */
export function connectionTest(c: Cluster): TestStep[] {
  const host = (c.server ?? "").replace(/^https:\/\//, "").replace(/:\d+$/, "");
  const ip = /^\d/.test(host) ? host.replace(/\.\d+\.\d+$/, ".x.x") : host.includes("…") ? "52.48.x.x" : "10.20.x.x";
  const steps: TestStep[] = [
    { name: "DNS", result: "ok", detail: ip, ms: 9 },
    { name: "TCP 443", result: "ok", ms: 31 },
    { name: "TLS", result: "ok", detail: "CA trusted · valid to 2027-02-11", ms: 48 },
    { name: "Authentication", result: "ok", detail: c.auth, ms: 410 },
    { name: "API discovery", result: "ok", detail: `${c.version ?? "v1.31"} · 64 groups`, ms: 120 },
    { name: "Permissions", result: "ok", detail: c.identity ? `RBAC: ${c.identity}` : "SelfSubjectRulesReview", ms: 85 },
  ];
  const failAt = (i: number, detail: string, ms: number) => {
    steps[i] = { ...steps[i]!, result: "failed", detail, ms };
    for (let k = i + 1; k < steps.length; k++) steps[k] = { name: steps[k]!.name, result: "skipped", detail: "skipped" };
  };
  if (c.connection === "auth-expired") failAt(3, "exec plugin failed", 1200);
  if (c.connection === "unreachable") {
    steps[0] = { name: "DNS", result: "ok", detail: "127.0.0.1", ms: 0 };
    failAt(1, "connection refused", 2);
  }
  return steps;
}
