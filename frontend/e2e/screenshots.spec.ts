import { test, type Page } from "@playwright/test";
import { openDesktop, type FakeBackend, type FakeOptions } from "./fake-backend";

// Screenshots for the README and the website, taken against the faked backend
// with sample data. Opt-in:
//   CLUSTRAIL_SCREENSHOTS=$PWD/../docs/images npx playwright test e2e/screenshots.spec.ts

const out = process.env.CLUSTRAIL_SCREENSHOTS ?? "";
test.skip(!out, "set CLUSTRAIL_SCREENSHOTS to an output directory to run");
test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

const shot = async (page: Page, name: string) => {
  await page.mouse.move(0, 899);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/${name}.png`, animations: "disabled", caret: "hide" });
};
const visible = (page: Page, text: string | RegExp) => page.getByText(text).filter({ visible: true }).first();
const palette = async (page: Page, entry: string) => {
  await page.keyboard.press("Control+k");
  await page.keyboard.type(entry);
  await page.keyboard.press("Enter");
};
const sidebar = (page: Page, name: RegExp) => page.locator("nav, aside").getByRole("button", { name }).first();

const NODES: Record<string, string[]> = {
  "prod-eu-west-1": ["ip-10-42-3-17.eu-west-1.compute.internal", "ip-10-42-5-88.eu-west-1.compute.internal", "ip-10-42-7-203.eu-west-1.compute.internal"],
  "staging-eu-1": ["gke-staging-eu-1-pool-a-3f1c", "gke-staging-eu-1-pool-a-9d2e"],
};
// app, namespace, replicas, owner kind, containers, cpu, memory
const APPS: [string, string, number, string, number, number, number][] = [
  ["checkout-api", "payments", 3, "Deployment", 2, 180, 228],
  ["payments-workers", "payments", 2, "Deployment", 1, 95, 310],
  ["ledger-db", "payments", 3, "StatefulSet", 1, 240, 1180],
  ["storefront", "web", 4, "Deployment", 1, 60, 142],
  ["shop-gateway", "web", 2, "Deployment", 2, 120, 96],
  ["search-indexer", "search", 2, "Deployment", 1, 410, 860],
  ["prometheus", "monitoring", 1, "StatefulSet", 2, 520, 2240],
  ["grafana", "monitoring", 1, "Deployment", 1, 30, 180],
  ["ingress-nginx-controller", "ingress-nginx", 2, "Deployment", 1, 140, 210],
  ["coredns", "kube-system", 2, "Deployment", 1, 12, 34],
];

function suffix(seed: number, n = 5) {
  const abc = "bcdfghjklmnpqrstvwxz2456789";
  let s = "";
  for (let i = 0; i < n; i++) s += abc[(seed * 7919 + i * 104729) % abc.length];
  return s;
}

/** Pods for one cluster: mostly healthy, with the fixture's failing checkout-api pod on production. */
function podsOf(base: Record<string, unknown>, cluster: string) {
  const env = cluster.startsWith("prod") ? "prod" : "stg";
  const nodes = NODES[cluster]!;
  const rows: Record<string, unknown>[] = [];
  let seed = cluster.length * 31;
  for (const [app, ns, replicas, kind, containers, cpu, mem] of APPS) {
    const rs = suffix(seed++, 9).slice(0, 9).replace(/[^a-z0-9]/g, "a");
    for (let i = 0; i < replicas; i++) {
      seed++;
      const name = kind === "StatefulSet" ? `${app}-${i}` : `${app}-${app === "checkout-api" && env === "prod" ? "7d9f8b6c4" : rs}-${app === "checkout-api" && env === "prod" ? ["x2kqp", "9rkzd", "h2pqs"][i] : suffix(seed)}`;
      const row: Record<string, unknown> = {
        ...base,
        id: `${cluster}/${ns}/${name}`, uid: `uid-${cluster}-${name}`, name, namespace: ns, cluster, env, node: nodes[seed % nodes.length],
        health: "healthy", status: "Running", reason: "Running", readyContainers: containers, totalContainers: containers,
        restarts: seed % 9 === 0 ? 1 : 0, cpuMilli: Math.round(cpu * (0.8 + (seed % 5) / 10)), memoryMiB: Math.round(mem * (0.85 + (seed % 4) / 10)),
        ageSeconds: 3600 * (6 + (seed % 90)), owner: { kind, name: app }, labels: { app },
      };
      if (app === "checkout-api" && env === "prod" && i === 0) Object.assign(row, { health: "failed", status: "CrashLoop", reason: "CrashLoopBackOff", readyContainers: 1, restarts: 14, cpuMilli: null, memoryMiB: null });
      if (app === "search-indexer" && env === "stg" && i === 1) Object.assign(row, { health: "warning", status: "Pending", reason: "Unschedulable", readyContainers: 0, restarts: 0, cpuMilli: null, memoryMiB: null, node: "" });
      if (app === "payments-workers" && env === "prod" && i === 1) Object.assign(row, { health: "warning", status: "Running", reason: "Running", readyContainers: 0, restarts: 3 });
      rows.push(row);
    }
  }
  return rows;
}

let pods: Record<string, Record<string, unknown>[]> = {};
const rich: FakeOptions = {
  patch: (d) => {
    const base = (d.fx.snapshot.pods as Record<string, unknown>[])[0]!;
    pods = { "prod-eu-west-1": podsOf(base, "prod-eu-west-1"), "staging-eu-1": podsOf(base, "staging-eu-1") };
    d.fx.snapshot.pods = [...pods["prod-eu-west-1"]!, ...pods["staging-eu-1"]!];
    d.list.selected = ["prod-eu-west-1", "staging-eu-1"];
    d.list.forbidden = [];
  },
  pods: (cluster) => pods[cluster] ?? [],
};

async function open(page: Page): Promise<FakeBackend> {
  const backend = await openDesktop(page, rich);
  await page.getByRole("tab", { name: /^Pods/ }).waitFor();
  return backend;
}

test("pods across clusters, a failing pod in the inspector", async ({ page }) => {
  await open(page);
  await page.getByRole("tab", { name: /^Pods/ }).click();
  await visible(page, "checkout-api-7d9f8b6c4-x2kqp").click();
  await visible(page, "CrashLoopBackOff").waitFor();
  await shot(page, "pods");
});

test("logs from every pod of a Deployment", async ({ page }) => {
  const backend = await open(page);
  await palette(page, "Deployments");
  await page.locator('button:has-text("Logs") >> visible=true').first().click();
  await test.expect.poll(() => backend.calls).toContain("StartLogs");
  const pods = ["checkout-api-7d9f8b6c4-9rkzd", "checkout-api-7d9f8b6c4-h2pqs", "checkout-api-7d9f8b6c4-x2kqp"];
  const msgs: [number, string, string][] = [
    [0, "INFO", "POST /v1/checkout 200 84ms cart=7f21 items=3"],
    [1, "INFO", "GET /v1/cart/7f21 200 12ms"],
    [0, "INFO", "POST /v1/payments/authorize 201 143ms provider=adyen"],
    [2, "WARN", "heap usage 91% (233Mi of 256Mi), GC pause 412ms"],
    [1, "INFO", "POST /v1/checkout 200 91ms cart=a03c items=1"],
    [2, "WARN", "heap usage 97% (248Mi of 256Mi), GC pause 1.8s"],
    [0, "INFO", "GET /healthz 200 1ms"],
    [2, "ERROR", "java.lang.OutOfMemoryError: Java heap space"],
    [2, "ERROR", "    at com.acme.checkout.PriceCache.load(PriceCache.java:118)"],
    [1, "INFO", "POST /v1/checkout 200 77ms cart=19be items=2"],
    [0, "WARN", "upstream pricing slow: 820ms (budget 500ms)"],
    [1, "INFO", "GET /healthz 200 1ms"],
    [0, "INFO", "POST /v1/checkout 200 102ms cart=c4d0 items=5"],
    [1, "INFO", "POST /v1/payments/authorize 201 131ms provider=adyen"],
  ];
  // A quieter stretch before the failure, so the window is full.
  const before: [number, string, string][] = Array.from({ length: 16 }, (_, i) => [
    i % 2,
    i % 7 === 3 ? "DEBUG" : "INFO",
    i % 7 === 3 ? `pricing cache refreshed: ${1180 + i * 13} entries in ${40 + i}ms` : i % 3 === 0 ? "GET /healthz 200 1ms" : `POST /v1/checkout 200 ${70 + ((i * 17) % 40)}ms cart=${(0x1a2b + i * 4099).toString(16).slice(-4)} items=${1 + (i % 4)}`,
  ]);
  msgs.unshift(...before);
  await backend.emit("clustrail:logs", {
    id: "logs-1",
    lines: msgs.map(([p, level, msg], i) => ({ namespace: "payments", pod: pods[p], container: "api", ts: `12:0${Math.floor((i * 2 + 1) / 60)}:${String((i * 2 + 1) % 60).padStart(2, "0")}.${String((117 * i) % 1000).padStart(3, "0")}`, level, msg })),
    pods: pods.map((pod) => ({ namespace: "payments", pod, state: "following", initial: true })),
    states: [{ pod: pods[2], container: "api", state: "reconnecting", note: "CrashLoopBackOff" }],
    matched: 3,
    skipped: 0,
  });
  await visible(page, "java.lang.OutOfMemoryError: Java heap space").waitFor();
  await shot(page, "logs");
});

test("service chain", async ({ page }) => {
  await open(page);
  await sidebar(page, /^Services/).click();
  await visible(page, "10.96.12.4").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Service chain" }).click();
  await visible(page, /Likely cause/).waitFor();
  await shot(page, "service-chain");
});

test("Helm upgrade preview", async ({ page }) => {
  await open(page);
  await palette(page, "Helm releases");
  await visible(page, "payments-workers").click({ button: "right" });
  await page.getByRole("menuitem", { name: /Upgrade/ }).click();
  await page.getByRole("textbox", { name: "Values" }).fill("replicaCount: 3\nimage:\n  tag: 1.8.4\ndb:\n  password: '[redacted by Clustrail]'\n");
  await page.getByRole("button", { name: "Preview changes" }).click();
  await visible(page, "1 changed").waitFor();
  await shot(page, "helm-upgrade");
});

test("typed confirmation on a protected production context", async ({ page }) => {
  await open(page);
  await page.keyboard.press("Control+j");
  await visible(page, "certificates.cert-manager.io").waitFor();
  await page.keyboard.type("cj");
  await page.keyboard.press("Enter");
  await visible(page, "0 2 * * *").click({ button: "right" });
  await page.getByRole("menuitem", { name: /Run now/ }).click();
  const confirm = page.getByRole("alertdialog");
  await confirm.getByText(/create job --from=cronjob\/nightly-report/).waitFor();
  await confirm.getByRole("textbox").fill("prod-eu-west-1/nightly-");
  await shot(page, "protected");
});

test("network policies of a pod", async ({ page }) => {
  await open(page);
  await page.getByRole("tab", { name: /^Pods/ }).click();
  await visible(page, "checkout-api-7d9f8b6c4-9rkzd").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Network policies" }).click();
  await visible(page, /runs Cilium/).waitFor();
  await page.getByLabel("To pod (namespace/name) or IP").fill("payments/ledger-db-0");
  await page.getByLabel("Port").fill("5432");
  await page.getByRole("button", { name: "Check", exact: true }).click();
  await visible(page, "Denied").waitFor();
  await shot(page, "network-policies");
});

test("pods in the light theme", async ({ page }) => {
  await open(page);
  await page.evaluate(() => localStorage.setItem("clustrail.theme", JSON.stringify("light")));
  await page.reload();
  await page.getByRole("tab", { name: /^Pods/ }).click();
  await visible(page, "checkout-api-7d9f8b6c4-x2kqp").click();
  await visible(page, "CrashLoopBackOff").waitFor();
  await shot(page, "pods-light");
});
