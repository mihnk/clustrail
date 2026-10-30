import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";

// The desktop app's Go side, faked at the Wails transport (POST /wails/runtime):
// calls are answered from a fixture the Go converters produce
// (go test -run TestWriteUIFixture, see README), events are dispatched the way
// the runtime does.

const fixture = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/desktop.json", import.meta.url)), "utf8"));

type Args = unknown[];

function data() {
  const fx = structuredClone(fixture);
  const clusters = [
    { id: "prod-eu-west-1", name: "prod-eu-west-1", context: "arn:aws:eks:eu-west-1:482100000000:cluster/prod-eu-west-1", env: "prod", protected: true, connection: "connected", latencyMs: 41, summary: "EKS 1.30 · eu-west-1", readOnly: false, metrics: "metrics-server", server: "https://4F3A.gr7.eu-west-1.eks.amazonaws.com", auth: "exec · aws eks", source: "~/.kube/config", version: "v1.30.4-eks-a737599", identity: "sre-oncall" },
    { id: "kind-local", name: "kind-local", context: "kind-local", env: "dev", protected: false, connection: "disconnected", latencyMs: null, summary: null, readOnly: false, metrics: null, server: "https://127.0.0.1:6443", auth: "client cert", source: "~/.kube/config" },
  ];
  clusters.push({ ...clusters[0]!, id: "staging-eu-1", name: "staging-eu-1", env: "stg", protected: false, context: "gke_acme_staging-eu-1" });
  fx.snapshot.deployments.push({ ...fx.snapshot.deployments[0], id: "staging-eu-1/payments/checkout-api", cluster: "staging-eu-1", env: "stg", health: "healthy", readyReplicas: 2, replicas: 2 });
  fx.snapshot.helm = [
    {
      id: "prod-eu-west-1/payments/payments-workers", name: "payments-workers", namespace: "payments", cluster: "prod-eu-west-1", env: "prod", status: "failed", health: "failed",
      chart: "payments-workers", chartVersion: "2.4.0", appVersion: "1.9.0", revision: 8, updatedSeconds: 1560, repoKnown: false,
      history: [
        { rev: 8, status: "failed", chartVersion: "2.4.0", appVersion: "1.9.0", updatedSeconds: 1560, description: 'Upgrade "payments-workers" failed: timed out waiting for the condition' },
        { rev: 7, status: "deployed", chartVersion: "2.3.2", appVersion: "1.8.4", updatedSeconds: 518400, description: "Upgrade complete" },
      ],
      values: "replicaCount: 3\n", notes: "", resources: [{ kind: "Deployment", name: "payments-workers" }],
    },
  ];
  const list = {
    clusters,
    discovered: [{ ...clusters[1], id: "staging-eu-2", name: "staging-eu-2", context: "gke_acme_europe-west4_staging-eu-2", env: "stg" }],
    sources: [{ path: "~/.kube/config", contexts: 3, watched: true, changed: "2m" }],
    forbidden: [{ cluster: "prod-eu-west-1", namespace: "all namespaces", user: "dev-team", resource: "pods", shown: "payments" }],
    controllers: [],
    selected: ["prod-eu-west-1"],
  };
  return { fx, clusters, list };
}

function answer(d: ReturnType<typeof data>, method: string, args: Args): unknown {
  const { fx, clusters, list } = d;
  switch (method) {
    case "Hello":
      return { version: "0.9.0-test", user: "tester" };
    case "Clusters":
      return list;
    case "Snapshot":
      return { clusters, ...fx.snapshot };
    case "PodDetail":
      return fx.podDetail;
    case "GetObject":
      if (args[1] === "ConfigMap") return { yaml: 'apiVersion: v1\nkind: ConfigMap\ndata:\n  A: "1"\n', resourceVersion: "1", owners: {}, apiVersion: "v1" };
      return {
        ...fx.liveObject,
        resourceVersion: "48211907",
        yaml: args[0] === "staging-eu-1" ? fx.liveObject.yaml.replace("replicas: 3", "replicas: 2").replace("memory: 256Mi", "memory: 512Mi") : fx.liveObject.yaml,
      };
    case "ApplyYAML":
      return { dryRun: args[3], resourceVersion: "48211908", warnings: [] };
    case "StartLogs":
      return "logs-1";
    case "StartExec":
      return "exec-1";
    case "HelmRevision": {
      const rev = args[3] as number;
      const img = rev === 8 ? "1.9.0" : "1.8.4";
      return {
        rev,
        manifest:
          `---\n# Source: w/templates/deploy.yaml\napiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: payments-workers\nspec:\n  template:\n    spec:\n      containers:\n      - name: w\n        image: ghcr.io/acme/payments-workers:${img}\n` +
          (rev === 8 ? `---\napiVersion: monitoring.coreos.com/v1\nkind: ServiceMonitor\nmetadata:\n  name: payments-workers-v2\n` : ""),
        values: "replicaCount: 3\n",
        computed: "replicaCount: 3\nimage:\n  tag: latest\n",
        hooks: rev === 7 ? [{ name: "db-migrate-check", kind: "Job", events: ["post-rollback"] }] : [],
      };
    }
    case "DeploymentRelations":
      return [{ label: "Selected by", objects: [{ kind: "svc", name: "checkout-api" }], via: "Service selector app=checkout-api" }];
    case "TestConnection":
      return [
        { name: "DNS", result: "ok", detail: "127.0.0.1", ms: 0 },
        { name: "TCP 6443", result: "failed", detail: "connect: connection refused", ms: 1 },
        { name: "TLS", result: "skipped", detail: "skipped" },
        { name: "Authentication", result: "skipped", detail: "skipped" },
        { name: "API discovery", result: "skipped", detail: "skipped" },
        { name: "Permissions", result: "skipped", detail: "skipped" },
      ];
    case "ResourceKinds":
      return [
        { kind: "CronJob", group: "batch", version: "v1", resource: "cronjobs", namespaced: true, shortNames: ["cj"], delete: true },
        { kind: "Service", group: "", version: "v1", resource: "services", namespaced: true, shortNames: ["svc"], delete: true },
        { kind: "Certificate", group: "cert-manager.io", version: "v1", resource: "certificates", namespaced: true, shortNames: ["cert"], delete: true },
      ];
    case "ListResources": {
      const [cluster, kind] = args as [string, string];
      if (kind === "batch/CronJob")
        return {
          cluster, kind, namespaced: true,
          columns: [{ name: "Schedule", type: "string", priority: 0 }, { name: "Suspend", type: "boolean", priority: 0 }, { name: "Active", type: "integer", priority: 0 }],
          rows: [{ id: `${cluster}/payments/nightly-report`, cluster, namespace: "payments", name: "nightly-report", created: "2026-10-01T00:00:00Z", cells: ["0 2 * * *", "False", "0"] }],
        };
      return {
        cluster, kind, namespaced: true, shown: "payments",
        columns: [
          { name: "Type", type: "string", priority: 0 },
          { name: "Cluster-IP", type: "string", priority: 0 },
          { name: "Ports", type: "string", priority: 0 },
          { name: "Selector", type: "string", priority: 1, description: "Route service traffic to pods." },
        ],
        rows: [{ id: `${cluster}/payments/checkout-api`, cluster, namespace: "payments", name: "checkout-api", created: "2026-10-01T00:00:00Z", labels: { app: "checkout-api" }, cells: ["ClusterIP", "10.96.12.4", "80/TCP", "app=checkout-api"] }],
      };
    }
    case "PortForwards":
      return [];
    case "ForwardablePorts":
      return [{ port: 80, name: "web", detail: "→ http" }];
    case "StartPortForward": {
      const req = args[0] as { cluster: string; namespace: string; kind: string; name: string; port: number };
      return { id: "pf-1", ...req, localPort: 54321, pod: "checkout-api-7d9f8b6c4-9rkzd", podPort: 8080, state: "active", started: "2026-10-30T00:00:00Z" };
    }
    default:
      return null;
  }
}

export interface FakeBackend {
  /** Backend methods called so far, in order. */
  calls: string[];
  fixture: typeof fixture;
  /** Dispatches a backend event (clustrail:delta, clustrail:logs, …). */
  emit: (name: string, data: unknown) => Promise<void>;
  /** Console errors and page errors seen so far. */
  errors: string[];
}

/** Opens the app in desktop mode against the fake backend, with fresh local storage. */
export async function openDesktop(page: Page): Promise<FakeBackend> {
  const d = data();
  const calls: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.route("**/wails/runtime", async (route) => {
    const body = route.request().postDataJSON() as { object: number; args: { methodName: string; args?: Args } };
    if (body.object !== 0) return route.fulfill({ status: 200, contentType: "application/json", body: "null" });
    const method = body.args.methodName.split(".").pop()!;
    const args = body.args.args ?? [];
    calls.push(method);
    if (method === "GetObject" && args[3] === "my-cronjob") return route.fulfill({ status: 500, contentType: "text/plain", body: 'cronjobs "my-cronjob" not found' });
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(answer(d, method, args)) });
  });
  await page.goto("/?backend=1");
  await page.evaluate(() => localStorage.clear());
  await page.goto("/?backend=1");
  return {
    calls,
    errors,
    fixture: d.fx,
    emit: (name, data) => page.evaluate(([n, x]) => (window as unknown as { _wails: { dispatchWailsEvent: (e: unknown) => void } })._wails.dispatchWailsEvent({ name: n, data: x }), [name, data] as const),
  };
}
