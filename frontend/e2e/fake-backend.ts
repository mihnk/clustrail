import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";

// The desktop app's Go side, faked at the Wails transport (POST /wails/runtime):
// calls are answered from a fixture the Go converters produce
// (go test -run TestWriteUIFixture, see docs/development.md), events are dispatched the way
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
      if (args[1] === "Secret")
        return {
          yaml: "apiVersion: v1\nkind: Secret\nmetadata:\n  name: db\n  namespace: payments\ntype: Opaque\ndata:\n  password: (hidden, 7 bytes)\n",
          resourceVersion: "9", owners: {}, apiVersion: "v1",
          secret: { type: "Opaque", keys: [{ key: "password", bytes: 7 }] },
        };
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
    case "CreateObjects":
      return [{ kind: "CronJob", name: "my-cronjob", namespace: "default", status: args[2] ? "valid" : "created" }];
    case "RevealSecretKey":
      return { value: "hunter2", binary: false };
    case "ListResources": {
      const [cluster, kind] = args as [string, string];
      if (kind === "Secret")
        return {
          cluster, kind, namespaced: true,
          columns: [{ name: "Type", type: "string", priority: 0 }, { name: "Data", type: "integer", priority: 0 }],
          rows: [{ id: `${cluster}/payments/db`, cluster, namespace: "payments", name: "db", created: "2026-10-01T00:00:00Z", cells: ["Opaque", "1"] }],
        };
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
    case "LogFile":
      return { path: "/Users/tester/Library/Caches/clustrail/clustrail.log", size: 20480 };
    case "MemoryStats":
      return { heapMB: 212, budgetMB: 0, objects: { "prod-eu-west-1": 1450 } };
    case "PauseWatches":
      return [];
    case "ForwardablePorts":
      return [{ port: 80, name: "web", detail: "→ http" }];
    case "ClusterWarnings":
      return {
        cluster: args[0],
        scope: "",
        events: [
          { namespace: "payments", kind: "Pod", name: "checkout-api-7d9f8b6c4-x2kqp", reason: "BackOff", message: "Back-off restarting failed container api", count: 14, lastSeen: new Date(Date.now() - 60_000).toISOString(), source: "kubelet" },
          { namespace: "payments", kind: "Deployment", name: "checkout-api", reason: "ProgressDeadlineExceeded", message: "ReplicaSet has timed out progressing.", count: 1, lastSeen: new Date(Date.now() - 600_000).toISOString() },
        ],
      };
    case "Expiry":
      return {
        cluster: args[0],
        items: [
          { source: "secret", what: "TLS Secret", namespace: "web", name: "shop-tls", subject: "shop.example.com", issuer: "R11", dnsNames: ["shop.example.com"], notAfter: "2026-11-04T00:00:00Z", daysLeft: 4 },
          { source: "kubeconfig", what: "Client certificate", subject: "sre-oncall", issuer: "kubernetes", notAfter: "2027-06-01T00:00:00Z", daysLeft: 214 },
        ],
        notes: ["API server certificate: dial tcp: i/o timeout"],
      };
    case "Namespaces":
      return ["default", "payments"];
    case "WarningCount":
      return 2;
    case "AccessMatrix": {
      const verbs = ["get", "list", "watch", "create", "update", "patch", "delete"];
      const resources = [
        { group: "", resource: "pods", label: "pods", namespaced: true },
        { group: "", resource: "secrets", label: "secrets", namespaced: true },
      ];
      return {
        subject: args[1], user: "sre-oncall", groups: ["sre", "system:authenticated"], namespace: args[2], verbs, resources,
        allowed: [verbs.map((v) => (["get", "list", "watch"].includes(v) ? "yes" : "no")), verbs.map(() => "no")],
        bindings: [{ kind: "ClusterRoleBinding", name: "sre-view", role: "ClusterRole/view", via: "group sre" }],
      };
    }
    case "AddDebugContainer": {
      const req = args[0] as { namespace: string; pod: string };
      return { namespace: req.namespace, pod: req.pod, container: "debugger-k2x9q" };
    }
    case "HelmUpgradeSource":
      return {
        chart: "payments-workers", version: "2.4.0", appVersion: "1.9.0", revision: 8,
        values: "replicaCount: 3\nimage:\n  tag: 1.9.0\ndb:\n  password: '[redacted by Clustrail]'\n",
        defaults: "replicaCount: 1\n",
        versions: [{ repo: "acme", version: "2.5.0", appVersion: "1.10.0" }],
      };
    case "PlanHelmUpgrade":
      return {
        chart: "payments-workers", version: "2.4.0", appVersion: "1.9.0", hooks: 0, valueKeys: ["image"],
        objects: [
          { kind: "Deployment", name: "payments-workers", namespace: "payments", change: "changed", before: "spec:\n  image: ghcr.io/acme/payments-workers:1.9.0\n  replicas: 3", after: "spec:\n  image: ghcr.io/acme/payments-workers:1.8.4\n  replicas: 3" },
          { kind: "ServiceMonitor", name: "payments-workers-v2", namespace: "payments", change: "removed", before: "kind: ServiceMonitor" },
          { kind: "Service", name: "payments-workers", namespace: "payments", change: "unchanged", before: "kind: Service", after: "kind: Service" },
        ],
      };
    case "UpgradeRelease":
      return "helm-up-1";
    case "Storage":
      return {
        cluster: args[0], scope: "", usage: "kubelet", notes: [],
        claims: [
          { id: `${args[0]}/payments/data-ledger-db-2`, namespace: "payments", name: "data-ledger-db-2", phase: "Pending", health: "warning", class: "gp3", requested: "100Gi", accessModes: ["ReadWriteOnce"], created: "2026-10-30T00:00:00Z", pods: [{ name: "ledger-db-2", phase: "Pending" }], reason: "ProvisioningFailed ×6 · could not create volume" },
          { id: `${args[0]}/payments/data-ledger-db-0`, namespace: "payments", name: "data-ledger-db-0", phase: "Bound", health: "healthy", volume: "pvc-8f2c", class: "gp3", requested: "100Gi", capacity: "100Gi", accessModes: ["ReadWriteOnce"], created: "2026-03-30T00:00:00Z", pods: [{ name: "ledger-db-0", phase: "Running", node: "node-1", owner: "StatefulSet/ledger-db" }], usedBytes: 93, capacityBytes: 100 },
        ],
        volumes: [{ name: "pvc-8f2c", phase: "Bound", health: "healthy", capacity: "100Gi", class: "gp3", claim: "payments/data-ledger-db-0", reclaimPolicy: "Delete", accessModes: ["ReadWriteOnce"], source: "csi · ebs.csi.aws.com", created: "2026-03-30T00:00:00Z" }],
        classes: [{ name: "gp3", provisioner: "ebs.csi.aws.com", reclaimPolicy: "Delete", bindingMode: "WaitForFirstConsumer", expansion: true, default: true, claims: 2 }],
      };
    case "PodNetworkPolicies":
      return {
        namespace: args[1], pod: args[2], labels: { app: "checkout-api" }, plugin: "Cilium", enforced: "yes", all: ["allow-gateway", "default-deny"],
        ingress: { isolated: true, policies: ["default-deny", "allow-gateway"], rules: [{ policy: "allow-gateway", rule: 1, peers: "Pods app=gateway in namespaces zone=edge", ports: "TCP 8080", pods: 2 }] },
        egress: { isolated: false, policies: [], rules: [] },
      };
    case "CheckConnection":
      return { allowed: false, egress: true, egressVia: "no policy selects the pod", ingress: false, ingressVia: "denied: selected by default-deny and no rule matches" };
    case "ServiceChain":
      return {
        cluster: args[0], namespace: args[1],
        services: [{
          name: "checkout-api", found: true, type: "ClusterIP", clusterIP: "10.96.12.4", selector: "app=checkout-api",
          ports: [{ name: "http", port: 80, targetPort: "http", protocol: "TCP" }], ready: [], notReady: ["10.1.4.17"],
          pods: [{ name: "checkout-api-7d9f8b6c4-9rkzd", phase: "Running", ready: false, reason: "Readiness probe failed: connection refused" }], ingresses: ["shop"],
        }],
        checks: [
          { status: "ok", text: "Selector app=checkout-api matches 1 pod", template: "Selector {v0} matches 1 pod", args: ["app=checkout-api"] },
          { status: "error", text: "service/checkout-api has no ready endpoints", template: "service/{v0} has no ready endpoints", args: ["checkout-api"], hint: "checkout-api-7d9f8b6c4-9rkzd: Readiness probe failed: connection refused" },
        ],
        verdict: { status: "error", text: "service/checkout-api has no ready endpoints", template: "service/{v0} has no ready endpoints", args: ["checkout-api"], hint: "checkout-api-7d9f8b6c4-9rkzd: Readiness probe failed: connection refused" },
      };
    case "TriggerCronJob":
      return "nightly-report-manual-10301200123";
    case "StartPortForward": {
      const req = args[0] as { cluster: string; namespace: string; kind: string; name: string; port: number };
      return { id: "pf-1", ...req, localPort: 54321, pod: "checkout-api-7d9f8b6c4-9rkzd", podPort: 8080, state: "active", started: "2026-10-30T00:00:00Z" };
    }
    default:
      return null;
  }
}

// The Wails stream transport (runtime/stream.js): POST /wails/stream/send
// carries open/data/close frames from the page, GET /wails/stream/poll returns
// queued frames as "WS1\0" + flags + count + [conn u32, kind u8, len u32, payload].
const KIND_DATA = 0;
const KIND_OPEN = 1;

class FakeStreams {
  private queue: { conn: number; kind: number; payload: Buffer }[] = [];
  private subs = new Map<string, { conn: number; cluster: string; seq: number }>();
  messages: { op: string; sub?: string; key?: { cluster: string } }[] = [];

  constructor(private pods: (cluster: string) => unknown[]) {}

  frame(conn: number, kind: number, payload: unknown = null) {
    this.queue.push({ conn, kind, payload: payload === null ? Buffer.alloc(0) : Buffer.from(JSON.stringify(payload)) });
  }

  receive(conn: number, kind: number, body: Buffer, batch: string | null) {
    if (kind === KIND_OPEN) return this.frame(conn, KIND_OPEN);
    if (kind !== KIND_DATA) return;
    const frames: Buffer[] = [];
    if (batch !== null) {
      let off = 4;
      for (let i = 0; i < body.readUInt32BE(0); i++) {
        const len = body.readUInt32BE(off);
        frames.push(body.subarray(off + 4, off + 4 + len));
        off += 4 + len;
      }
    } else frames.push(body);
    for (const f of frames) {
      const m = JSON.parse(f.toString()) as { op: string; sub: string; key?: { cluster: string } };
      this.messages.push(m);
      if (m.op === "sub" || m.op === "resync") {
        const cluster = m.op === "sub" ? m.key!.cluster : this.subs.get(m.sub)?.cluster;
        if (!cluster) continue;
        const sub = this.subs.get(m.sub) ?? { conn, cluster, seq: 0 };
        this.subs.set(m.sub, sub);
        this.frame(conn, KIND_DATA, { t: "snap", sub: m.sub, seq: ++sub.seq, final: true, rows: this.pods(cluster), state: "live", tok: 1 });
      } else if (m.op === "unsub") this.subs.delete(m.sub);
    }
  }

  /** Sends a delta on every subscription of the cluster. */
  delta(cluster: string, up: unknown[], del: string[] = []) {
    for (const [sub, s] of this.subs) if (s.cluster === cluster) this.frame(s.conn, KIND_DATA, { t: "delta", sub, seq: ++s.seq, up, del, tok: 2 });
  }

  /** Drains the queue as one poll response, or null when there is nothing. */
  poll(): Buffer | null {
    if (!this.queue.length) return null;
    const frames = this.queue.splice(0);
    const head = Buffer.alloc(9);
    head.write("WS1\0", 0, "latin1");
    head.writeUInt8(0, 4);
    head.writeUInt32BE(frames.length, 5);
    const parts: Buffer[] = [head];
    for (const f of frames) {
      const h = Buffer.alloc(9);
      h.writeUInt32BE(f.conn, 0);
      h.writeUInt8(f.kind, 4);
      h.writeUInt32BE(f.payload.length, 5);
      parts.push(h, f.payload);
    }
    return Buffer.concat(parts);
  }
}

export interface FakeBackend {
  /** Backend methods called so far, in order. */
  calls: string[];
  /** The arguments of each call of a method, in order. */
  argsOf: (method: string) => unknown[][];
  fixture: typeof fixture;
  /** Dispatches a backend event (clustrail:delta, clustrail:logs, …). */
  emit: (name: string, data: unknown) => Promise<void>;
  /** Console errors and page errors seen so far. */
  errors: string[];
  /** The id of the latest list watch started for a kind. */
  watchOf: (kind: string) => string | undefined;
  /** Pushes a pod delta through the pods stream. */
  podDelta: (cluster: string, up: unknown[], del?: string[]) => void;
  /** Messages the page sent on the pods stream (sub, unsub, resync, ack). */
  streamMessages: () => { op: string; sub?: string; key?: { cluster: string } }[];
}

const EVENT_LIST = "clustrail:list";

export interface FakeOptions {
  /** Extra or replaced answers, by method name. */
  answers?: Record<string, (args: Args) => unknown>;
  /** Pods the stream serves per cluster (default: the fixture's). */
  pods?: (cluster: string) => unknown[];
  /** Clusters as the backend lists them (default: the fixture's). */
  clusters?: unknown[];
  /** Contexts whose kubeconfig now names another API server, by id. */
  targetChanged?: Record<string, { from: string; to: string }>;
  /** Changes the fake data before the page loads (screenshots use richer data). */
  patch?: (d: ReturnType<typeof data>) => void;
}

/** Opens the app in desktop mode against the fake backend, with fresh local storage. */
export async function openDesktop(page: Page, opts: FakeOptions = {}): Promise<FakeBackend> {
  const d = data();
  if (opts.clusters) {
    d.list.clusters = opts.clusters as typeof d.list.clusters;
    d.list.selected = (opts.clusters as { id: string }[]).map((c) => c.id);
    d.list.forbidden = [];
    (d as { clusters: unknown[] }).clusters = opts.clusters;
  }
  opts.patch?.(d);
  for (const c of d.clusters as { id: string; targetChanged?: unknown }[]) if (opts.targetChanged?.[c.id]) c.targetChanged = opts.targetChanged[c.id];
  const calls: string[] = [];
  const callArgs: { method: string; args: unknown[] }[] = [];
  const errors: string[] = [];
  let lists = 0;
  const watches = new Map<string, string>();
  const emit = (name: string, data: unknown) =>
    page.evaluate(([n, x]) => (window as unknown as { _wails: { dispatchWailsEvent: (e: unknown) => void } })._wails.dispatchWailsEvent({ name: n, data: x }), [name, data] as const).catch(() => {});
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.route("**/wails/runtime", async (route) => {
    const body = route.request().postDataJSON() as { object: number; args: { methodName: string; args?: Args } };
    if (body.object !== 0) return route.fulfill({ status: 200, contentType: "application/json", body: "null" });
    const method = body.args.methodName.split(".").pop()!;
    const args = body.args.args ?? [];
    calls.push(method);
    callArgs.push({ method, args });
    if (method === "GetObject" && args[3] === "my-cronjob") return route.fulfill({ status: 500, contentType: "text/plain", body: 'cronjobs "my-cronjob" not found' });
    if (method === "StartListWatch") {
      // A watch: the id comes back first, then the backend's first update (a reset with every row).
      const id = `list-${++lists}`;
      const l = answer(d, "ListResources", args) as { columns: unknown[]; namespaced: boolean; shown?: string; rows: unknown[] };
      watches.set(String(args[1]), id);
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(id) });
      setTimeout(() => void emit(EVENT_LIST, { id, cluster: args[0], reset: true, columns: l.columns, namespaced: l.namespaced, shown: l.shown, upserts: l.rows, deletes: [], mode: "watch" }), 50);
      return;
    }
    const res = opts.answers?.[method] ? opts.answers[method]!(args) : answer(d, method, args);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(res ?? null) });
  });
  const streams = new FakeStreams(opts.pods ?? ((cluster) => (d.fx.snapshot.pods as { cluster: string }[]).filter((p) => p.cluster === cluster)));
  await page.route("**/wails/stream/send", async (route) => {
    const req = route.request();
    const h = req.headers();
    streams.receive(Number(h["x-wails-stream-conn"]), Number(h["x-wails-stream-kind"]), req.postDataBuffer() ?? Buffer.alloc(0), h["x-wails-stream-batch"] ?? null);
    await route.fulfill({ status: 200, body: "" });
  });
  await page.route("**/wails/stream/poll", async (route) => {
    // Held briefly like the real poll, so the page does not spin.
    for (let i = 0; i < 10; i++) {
      const body = streams.poll();
      if (body) return route.fulfill({ status: 200, contentType: "application/octet-stream", body });
      await new Promise((r) => setTimeout(r, 20));
    }
    await route.fulfill({ status: 204, body: "" });
  });
  await page.goto("/?backend=1");
  await page.evaluate(() => localStorage.clear());
  await page.goto("/?backend=1");
  return {
    calls,
    argsOf: (method: string) => callArgs.filter((c) => c.method === method).map((c) => c.args),
    errors,
    fixture: d.fx,
    emit,
    watchOf: (kind) => watches.get(kind),
    podDelta: (cluster, up, del = []) => streams.delta(cluster, up, del),
    streamMessages: () => streams.messages,
  };
}
