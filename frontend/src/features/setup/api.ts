import { backend, type SetupChoice, type SetupInfo, type SetupTestResult } from "@/backend/client";

/** Opens first-run setup again (Settings › Run setup again). */
export const SETUP_EVENT = "clustrail:setup";

/**
 * Setup calls: the Go side in the desktop app, sample data in the browser
 * preview (the design's contexts, so every screen and failure can be seen).
 */
export interface SetupApi {
  info(): Promise<SetupInfo>;
  test(id: string): Promise<SetupTestResult>;
  addFile(): Promise<string>;
  paste(text: string): Promise<string>;
  complete(choices: SetupChoice[], selected: string[]): Promise<void>;
  skip(): Promise<void>;
  connect(id: string): Promise<void>;
}

export function setupApi(): SetupApi {
  const b = backend;
  if (b) {
    return {
      info: () => b.setup(),
      test: (id) => b.setupTest(id),
      addFile: () => b.addKubeconfig(),
      paste: (text) => b.pasteKubeconfig(text),
      complete: (choices, selected) => b.completeSetup(choices, selected),
      skip: () => b.skipSetup(),
      connect: (id) => b.connect(id),
    };
  }
  return mockSetup;
}

const ctx = (
  id: string,
  cluster: string,
  server: string,
  auth: string,
  source: string,
  env: SetupInfo["contexts"][number]["env"],
  hint?: SetupInfo["contexts"][number]["hint"],
  current = false,
): SetupInfo["contexts"][number] => ({
  id,
  name: id,
  cluster,
  server,
  auth,
  source,
  current,
  env,
  hint,
  stored: false,
  protected: env === "prod",
  readOnly: false,
  known: true,
});

const mockInfo: SetupInfo = {
  needed: true,
  locations: [
    { path: "~/.kube/config", via: "default", state: "found", contexts: 5 },
    { path: "~/work/acme-perf.yaml", via: "added", state: "found", contexts: 1 },
    { path: "~/.kube/kind-local.yaml", via: "added", state: "found", contexts: 1 },
    { path: "~/.kube/config.bak", via: "added", state: "invalid", error: "error converting YAML to JSON: yaml: line 41: did not find expected key", contexts: 0 },
  ],
  contexts: [
    ctx("prod-eu-west-1", "arn:aws:eks:eu-west-1:4821…:cluster/prod-eu-west-1", "https://4F3A…C1.gr7.eu-west-1.eks.amazonaws.com", "exec · aws eks", "~/.kube/config", "prod", { word: "prod", field: "context" }, true),
    ctx("prod-us-east-1", "arn:aws:eks:us-east-1:4821…:cluster/prod-us-east-1", "https://9B21…77.yl4.us-east-1.eks.amazonaws.com", "exec · aws eks", "~/.kube/config", "prod", { word: "prod", field: "context" }),
    ctx("staging-eu-1", "gke_acme-stg_europe-west4_staging-1", "https://34.90.118.21", "exec · gcloud", "~/.kube/config", "stg", { word: "staging", field: "context" }),
    ctx("acme-main", "acme-main", "https://k8s.acme.internal:6443", "exec · kubelogin", "~/.kube/config", ""),
    ctx("dev-shared", "k3s-dev", "https://dev.acme.internal:6443", "client cert", "~/.kube/config", "dev", { word: "dev", field: "context" }),
    ctx("staging-perf", "gke_acme-perf_europe-west4_perf-1", "https://34.91.204.7", "exec · gcloud", "~/work/acme-perf.yaml", "stg", { word: "staging", field: "context" }),
    ctx("kind-local", "kind-local", "https://127.0.0.1:6443", "client cert", "~/.kube/kind-local.yaml", "dev", { word: "local", field: "context" }),
  ],
};

const ok = (name: string, detail: string, ms: number) => ({ name, result: "ok" as const, detail, ms });
const skipped = (name: string) => ({ name, result: "skipped" as const, detail: "skipped" });
const connected = (identity: string, version: string, ms: number): SetupTestResult => ({
  state: "connected",
  steps: [ok("DNS", "34.90.x.x", 4), ok("TCP 443", "", ms), ok("TLS", "CA trusted", 21), ok("Authentication", identity, 180), ok("API discovery", `${version} · 26 API groups`, 30), ok("Permissions", "41 rules in default (SelfSubjectRulesReview)", 18)],
});
const mockTests: Record<string, SetupTestResult> = {
  "prod-eu-west-1": connected("sre-oncall", "v1.30.4", 38),
  "prod-us-east-1": connected("sre-readonly", "v1.30.4", 112),
  "staging-eu-1": connected("edit", "v1.31.2", 64),
  "acme-main": connected("jane@acme.com", "v1.29.8", 52),
  "dev-shared": connected("dev", "v1.29.3", 17),
  "staging-perf": {
    state: "auth",
    hint: "gcloud auth login",
    steps: [ok("DNS", "34.91.x.x", 5), ok("TCP 443", "", 41), ok("TLS", "CA trusted", 22), { name: "Authentication", result: "failed", detail: "getting credentials: exec: executable gke-gcloud-auth-plugin failed: Reauthentication failed", ms: 900 }, skipped("API discovery"), skipped("Permissions")],
  },
  "kind-local": {
    state: "unreachable",
    steps: [ok("DNS", "127.0.0.1", 0), { name: "TCP 6443", result: "failed", detail: "dial tcp 127.0.0.1:6443: connect: connection refused", ms: 1 }, skipped("TLS"), skipped("Authentication"), skipped("API discovery"), skipped("Permissions")],
  },
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const mockSetup: SetupApi = {
  info: async () => structuredClone(mockInfo),
  test: async (id) => {
    await wait(300 + Math.random() * 900);
    return mockTests[id] ?? connected("admin", "v1.30.0", 20);
  },
  addFile: async () => "",
  paste: async () => "~/.kube/clustrail-pasted.yaml",
  complete: async () => undefined,
  skip: async () => undefined,
  connect: async () => undefined,
};
