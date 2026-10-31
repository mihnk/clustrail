import { expect, test, type Page } from "@playwright/test";
import { openDesktop, type FakeBackend } from "./fake-backend";

// The desktop app with its Go side faked at the Wails transport.

const visible = (page: Page, text: string | RegExp) => page.getByText(text).filter({ visible: true }).first();
const palette = async (page: Page, entry: string) => {
  await page.keyboard.press("Control+k");
  await page.keyboard.type(entry);
  await page.keyboard.press("Enter");
};
const sidebar = (page: Page, name: RegExp) => page.locator("nav, aside").getByRole("button", { name }).first();

let backend: FakeBackend;
test.beforeEach(async ({ page }) => {
  backend = await openDesktop(page);
});
test.afterEach(() => {
  expect(backend.errors, "console errors").toEqual([]);
});

test("loads the snapshot, streams pods, shows RBAC limits and pod details", async ({ page }) => {
  await expect(page.getByRole("tab", { name: /^Pods/ })).toBeVisible();
  expect(backend.calls).toEqual(expect.arrayContaining(["Hello", "Snapshot", "AutoConnect"]));
  await expect(page.getByText("MOCK DATA")).toHaveCount(0);

  await page.getByRole("tab", { name: /^Pods/ }).click();
  await expect(visible(page, /can’t list pods in all namespaces on prod-eu-west-1 → showing only payments/)).toBeVisible();
  await visible(page, "checkout-api-7d9f8b6c4-x2kqp").click();
  await expect(visible(page, "CrashLoopBackOff")).toBeVisible();
  expect(backend.calls).toContain("PodDetail");

  // A watch delta adds a row.
  const extra = { ...backend.fixture.snapshot.pods[0], id: "prod-eu-west-1/payments/checkout-api-7d9f8b6c4-new01", name: "checkout-api-7d9f8b6c4-new01", status: "Creating", health: "progressing", reason: "ContainerCreating" };
  backend.podDelta("prod-eu-west-1", [extra]);
  await expect(visible(page, "checkout-api-7d9f8b6c4-new01")).toBeVisible();
  // The page subscribed to the selected cluster on the pods stream and acknowledged what it rendered.
  expect(backend.streamMessages().some((m) => m.op === "sub" && m.key?.cluster === "prod-eu-west-1")).toBe(true);
  await expect.poll(() => backend.streamMessages().some((m) => m.op === "ack")).toBe(true);
  backend.podDelta("prod-eu-west-1", [], [extra.id]);
  await expect(page.getByText("checkout-api-7d9f8b6c4-new01")).toHaveCount(0);
});

test("streams logs from the backend", async ({ page }) => {
  await palette(page, "Deployments");
  await page.locator('button:has-text("Logs") >> visible=true').first().click();
  await expect.poll(() => backend.calls).toContain("StartLogs");
  await backend.emit("clustrail:logs", {
    id: "logs-1",
    lines: [
      { pod: "checkout-api-7d9f8b6c4-x2kqp", container: "api", ts: "12:00:01.000", level: "ERROR", msg: "java.lang.OutOfMemoryError: Java heap space" },
      { pod: "checkout-api-7d9f8b6c4-9rkzd", container: "api", ts: "12:00:02.000", level: "INFO", msg: "POST /v1/checkout 200 84ms" },
    ],
    states: [{ pod: "checkout-api-7d9f8b6c4-x2kqp", container: "api", state: "reconnecting", note: "CrashLoopBackOff" }],
  });
  await expect(page.getByText("java.lang.OutOfMemoryError: Java heap space")).toBeVisible();

  // The stream follows the Deployment by its selector; pods that start later join it.
  const req = backend.argsOf("StartLogs")[0]![0] as { sources: { namespace: string; workload?: string }[]; followNew: boolean; maxPods: number };
  expect(req.sources).toEqual([{ namespace: "payments", workload: "Deployment/checkout-api" }]);
  expect(req.followNew).toBe(true);
  expect(req.maxPods).toBe(30);
  await backend.emit("clustrail:logs", {
    id: "logs-1",
    lines: [{ namespace: "payments", pod: "checkout-api-5b8c7f9d2-p4wnc", container: "", ts: "12:00:03.000", level: "", msg: "checkout-api-5b8c7f9d2-p4wnc joined", event: "joined" }],
    pods: [
      { namespace: "payments", pod: "checkout-api-7d9f8b6c4-x2kqp", state: "left", reason: "pod deleted", left: "2026-10-30T12:00:04Z", initial: true },
      { namespace: "payments", pod: "checkout-api-7d9f8b6c4-9rkzd", state: "following", initial: true },
      { namespace: "payments", pod: "checkout-api-5b8c7f9d2-p4wnc", state: "following", joined: "2026-10-30T12:00:03Z", revision: "5b8c7f9d2", initial: false },
    ],
    matched: 2,
    skipped: 0,
  });
  await expect(visible(page, "checkout-api-5b8c7f9d2-p4wnc joined")).toBeVisible();
  await expect(visible(page, "following 2 of 2 pods")).toBeVisible();
  await expect(visible(page, /^left /)).toBeVisible();

  // Another source: a label selector, previewed against the pods Clustrail watches.
  await page.getByRole("button", { name: "Add source" }).click();
  await page.getByRole("radio", { name: "Label selector" }).click();
  await page.getByLabel("Selector").fill("app in (checkout-api");
  await expect(visible(page, /invalid term/)).toBeVisible();
  await page.getByLabel("Selector").fill("app=checkout-api");
  await expect(visible(page, /pods\s*match now/)).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Add source" }).click();
  await expect.poll(() => backend.argsOf("StartLogs").length).toBe(2);
  const again = backend.argsOf("StartLogs")[1]![0] as { sources: unknown[] };
  expect(again.sources).toEqual([
    { namespace: "payments", workload: "Deployment/checkout-api" },
    { namespace: "payments", selector: "app=checkout-api" },
  ]);
});

test("warning events, certificates and access checks", async ({ page }) => {
  // The sidebar counts the last 15 minutes.
  await expect(page.getByTitle("Warning events in the last 15 minutes")).toHaveText("2");
  await sidebar(page, /^Warning events/).click();
  await expect(visible(page, "Back-off restarting failed container api")).toBeVisible();
  await expect(visible(page, "×14")).toBeVisible();
  await page.getByRole("button", { name: /ProgressDeadlineExceeded/ }).first().click();
  await expect(page.getByText("Back-off restarting failed container api")).toHaveCount(0);

  await sidebar(page, /^Certificates/).click();
  await expect(visible(page, "4 days left")).toBeVisible();
  await expect(visible(page, "web/shop-tls")).toBeVisible();
  await expect(page.getByText("Client certificate")).toHaveCount(0);
  await page.getByRole("radio", { name: "All" }).click();
  await expect(visible(page, "Client certificate")).toBeVisible();
  await expect(visible(page, /i\/o timeout/)).toBeVisible();

  await sidebar(page, /^Access/).click();
  await page.getByRole("button", { name: "Check access" }).click();
  await expect(visible(page, "sre-view")).toBeVisible();
  await expect(page.getByLabel("list pods: allowed")).toBeVisible();
  await expect(page.getByLabel("delete secrets: denied")).toBeVisible();
  // The context sets no namespace, so the check starts in default.
  expect(backend.argsOf("AccessMatrix")[0]).toEqual(["prod-eu-west-1", { kind: "", name: "" }, "default"]);
});

test("runs a CronJob now", async ({ page }) => {
  await page.keyboard.press("Control+j");
  // The kind picker lists what the cluster serves; typing before it opens would go elsewhere.
  await expect(visible(page, "certificates.cert-manager.io")).toBeVisible();
  await page.keyboard.type("cj");
  await page.keyboard.press("Enter");
  await visible(page, "0 2 * * *").click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: /Suspend/ })).toBeVisible();
  await page.getByRole("menuitem", { name: /Run now/ }).click();
  // Production and protected: typed confirmation.
  const confirm = page.getByRole("alertdialog");
  await expect(confirm.getByText(/create job --from=cronjob\/nightly-report/)).toBeVisible();
  await confirm.getByRole("textbox").fill("prod-eu-west-1/nightly-report");
  await confirm.getByRole("button", { name: "Run now" }).click();
  await expect.poll(() => backend.argsOf("TriggerCronJob")[0]).toEqual(["prod-eu-west-1", "payments", "nightly-report"]);
  await expect(visible(page, "Job started")).toBeVisible();
});

test("tests a connection step by step", async ({ page }) => {
  await palette(page, "Connections");
  await page.locator('[role=option]:has-text("kind-local") >> visible=true').first().click();
  await expect(page.getByText("connect: connection refused")).toBeVisible();
});

test("compares a workload across clusters", async ({ page }) => {
  await palette(page, "Clusters");
  await page.locator('[role=tabpanel]:not([hidden]) [role=checkbox][aria-label*="staging-eu-1"]').first().click();
  await page.locator('button:has-text("Compare workload") >> visible=true').first().click();
  await page.getByRole("menuitem", { name: /checkout-api/ }).click();
  await expect(visible(page, "spec.replicas")).toBeVisible();
  await expect(visible(page, /limits\.memory/)).toBeVisible();
});

test("plans a Helm rollback from the stored manifests", async ({ page }) => {
  await palette(page, "Helm releases");
  await visible(page, "payments-workers").click();
  await expect(visible(page, "timed out waiting for the condition")).toBeVisible();
  await expect(visible(page, /Deployment payments-workers image 1\.9\.0 → 1\.8\.4/)).toBeVisible();
  await expect(visible(page, /ServiceMonitor payments-workers-v2/)).toBeVisible();
  await expect(visible(page, /post-rollback Job db-migrate-check/)).toBeVisible();
  await expect(visible(page, /Helm SDK 4\.3/)).toBeVisible();
  await page.getByRole("tab", { name: "Manifest" }).click();
  await expect(visible(page, /ghcr\.io\/acme\/payments-workers:1\.9\.0/)).toBeVisible();
});

test("lists any kind, finds CRDs with ⌘J and dry-runs a new object", async ({ page }) => {
  await sidebar(page, /^Services/).click();
  await expect(visible(page, "10.96.12.4")).toBeVisible();
  await expect(visible(page, /showing only/)).toBeVisible();
  await expect(page.getByText("Selector", { exact: true }).filter({ visible: true })).toHaveCount(0);
  await visible(page, "10.96.12.4").click();
  await expect(visible(page, "app=checkout-api")).toBeVisible();
  await expect(visible(page, "live (watch)")).toBeVisible();

  // Watch updates add and remove rows without a reload.
  await backend.emit("clustrail:list", {
    id: backend.watchOf("Service"), cluster: "prod-eu-west-1", namespaced: true, mode: "watch", deletes: [],
    upserts: [{ id: "prod-eu-west-1/payments/ledger", cluster: "prod-eu-west-1", namespace: "payments", name: "ledger", created: "2026-10-29T00:00:00Z", cells: ["ClusterIP", "10.96.40.2", "8080/TCP", "app=ledger"] }],
  });
  await expect(visible(page, "10.96.40.2")).toBeVisible();
  await backend.emit("clustrail:list", { id: backend.watchOf("Service"), cluster: "prod-eu-west-1", namespaced: true, mode: "watch", upserts: [], deletes: ["prod-eu-west-1/payments/ledger"] });
  await expect(page.getByText("10.96.40.2")).toHaveCount(0);

  await page.keyboard.press("Control+j");
  await expect(visible(page, "certificates.cert-manager.io")).toBeVisible();
  await page.keyboard.type("cj");
  await page.keyboard.press("Enter");
  await expect(visible(page, "0 2 * * *")).toBeVisible();

  await page.getByRole("button", { name: "Create…" }).click();
  await expect(visible(page, /New CronJob/)).toBeVisible();
  await page.getByRole("button", { name: "Dry run" }).click();
  await expect(visible(page, "CronJob/my-cronjob")).toBeVisible();
  await expect(visible(page, "valid")).toBeVisible();
});

test("port-forwards a Service and restores tabs on the next launch", async ({ page }) => {
  await sidebar(page, /^Services/).click();
  await visible(page, "10.96.12.4").click({ button: "right" });
  await page.getByRole("menuitem", { name: /Port forward/ }).click();
  await expect(visible(page, /→ http/)).toBeVisible();
  await page.getByRole("button", { name: "Start forward" }).click();
  await expect(visible(page, "Forwarding localhost:54321")).toBeVisible();
  await backend.emit("clustrail:portforwards", [
    { id: "pf-1", cluster: "prod-eu-west-1", namespace: "payments", kind: "Service", name: "checkout-api", port: 80, localPort: 54321, pod: "checkout-api-7d9f8b6c4-9rkzd", podPort: 8080, state: "active", started: "2026-10-30T00:00:00Z" },
  ]);
  await expect(visible(page, "1 forward")).toBeVisible();

  await page.reload();
  await expect(visible(page, "10.96.12.4")).toBeVisible();
});

test("settings drive the backend: poll mode, cache budget and the log file", async ({ page }) => {
  await palette(page, "Settings");
  expect(backend.calls).toEqual(expect.arrayContaining(["SetUpdateMethod", "SetCacheBudget", "SetMetricsInterval"]));
  await expect(visible(page, "/Users/tester/Library/Caches/clustrail/clustrail.log · 20 KB")).toBeVisible();
  await expect(visible(page, /Go heap 212 MB/)).toBeVisible();
  const before = backend.calls.filter((c) => c === "SetUpdateMethod").length;
  await page.getByRole("radio", { name: "Poll 30s" }).click();
  await expect.poll(() => backend.calls.filter((c) => c === "SetUpdateMethod").length).toBe(before + 1);
  await page.getByRole("switch", { name: "Enforce cache budget" }).click();
  await expect.poll(() => backend.calls.filter((c) => c === "SetCacheBudget").length).toBeGreaterThan(1);
});

test("starts and names a new investigation", async ({ page }) => {
  await sidebar(page, /^New investigation/).click();
  const title = page.getByRole("textbox", { name: "Investigation title" });
  await expect(title).toHaveValue("Investigation 2");
  await title.fill("DNS timeouts");
  await title.press("Enter");
  await expect(page.getByRole("tab", { name: /DNS timeouts/ })).toBeVisible();
  await expect(visible(page, /new pins land here/)).toBeVisible();
});

test("shows Secret keys and reveals a value only on request", async ({ page }) => {
  await sidebar(page, /^Secrets/).click();
  await visible(page, "Opaque").click();
  await page.getByRole("tab", { name: "Data" }).click();
  await expect(visible(page, "password")).toBeVisible();
  await expect(page.getByText("hunter2")).toHaveCount(0);
  expect(backend.calls).not.toContain("RevealSecretKey");
  await page.getByRole("button", { name: "Show" }).click();
  await expect(visible(page, "hunter2")).toBeVisible();
  await page.getByRole("button", { name: "Hide" }).click();
  await expect(page.getByText("hunter2")).toHaveCount(0);
});

test("adds a debug container and opens a shell in it", async ({ page }) => {
  await page.getByRole("tab", { name: /^Pods/ }).click();
  await visible(page, "checkout-api-7d9f8b6c4-9rkzd").click({ button: "right" });
  await page.getByRole("menuitem", { name: /Debug container/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("An ephemeral container cannot be removed", { exact: false })).toBeVisible();
  await expect(dialog.getByText(/kubectl --context .* debug -n payments checkout-api-7d9f8b6c4-9rkzd -it --image=nicolaka\/netshoot:v0.13/)).toBeVisible();
  // Quoted like a shell: three arguments, shown quoted in the kubectl line.
  await dialog.getByLabel("Command").fill("sh -c 'nslookup checkout-api; sh");
  await expect(dialog.getByText("Unterminated quote")).toBeVisible();
  await dialog.getByLabel("Command").fill("sh -c 'nslookup checkout-api; sh'");
  await expect(dialog.getByText("-- sh -c 'nslookup checkout-api; sh'", { exact: false })).toBeVisible();
  const add = dialog.getByRole("button", { name: "Add debug container" });
  // Production: the context name must be typed first.
  await expect(add).toBeDisabled();
  await dialog.getByRole("textbox").last().fill("prod-eu-west-1");
  await add.click();
  await expect.poll(() => backend.argsOf("AddDebugContainer")[0]).toEqual([
    { cluster: "prod-eu-west-1", namespace: "payments", pod: "checkout-api-7d9f8b6c4-9rkzd", image: "nicolaka/netshoot:v0.13", target: "api", profile: "general", command: ["sh", "-c", "nslookup checkout-api; sh"] },
  ]);
  await expect.poll(() => backend.argsOf("StartExec").length).toBe(1);
  expect(backend.argsOf("StartExec")[0]![0]).toMatchObject({ pod: "checkout-api-7d9f8b6c4-9rkzd", container: "debugger-k2x9q", command: ["sh", "-c", "nslookup checkout-api; sh"] });
});

test("upgrades a Helm release after previewing what changes", async ({ page }) => {
  await palette(page, "Helm releases");
  await visible(page, "payments-workers").click({ button: "right" });
  await page.getByRole("menuitem", { name: /Upgrade/ }).click();
  const values = page.getByRole("textbox", { name: "Values" });
  await expect(values).toHaveValue(/\[redacted by Clustrail\]/);
  // Nothing can be upgraded before a preview.
  const upgrade = page.getByRole("button", { name: "Upgrade…" });
  await expect(upgrade).toBeDisabled();
  await values.fill("replicaCount: 3\nimage:\n  tag: 1.8.4\ndb:\n  password: '[redacted by Clustrail]'\n");
  await page.getByRole("button", { name: "Preview changes" }).click();
  await expect(visible(page, "1 changed")).toBeVisible();
  await expect(visible(page, /\+\s+image: ghcr\.io\/acme\/payments-workers:1\.8\.4/)).toBeVisible();
  await expect(visible(page, "1 object is deleted by this upgrade: ServiceMonitor/payments-workers-v2.")).toBeVisible();
  expect(backend.argsOf("PlanHelmUpgrade")[0]![0]).toMatchObject({ cluster: "prod-eu-west-1", namespace: "payments", name: "payments-workers", wait: true, atomic: true, timeoutSec: 300 });
  // Editing after the preview asks for a new one.
  await values.fill("replicaCount: 4\n");
  await expect(upgrade).toBeDisabled();
  await page.getByRole("button", { name: "Preview changes" }).click();
  await expect(upgrade).toBeEnabled();
  await upgrade.click();
  const confirm = page.getByRole("alertdialog");
  await confirm.getByRole("textbox").fill("prod-eu-west-1/payments-workers");
  await confirm.getByRole("button", { name: "Upgrade" }).click();
  await expect.poll(() => backend.argsOf("UpgradeRelease").length).toBe(1);
  expect((backend.argsOf("UpgradeRelease")[0]![0] as { values: string }).values).toBe("replicaCount: 4\n");
});

test("storage: pending claims, usage and who mounts what", async ({ page }) => {
  await palette(page, "Storage");
  await expect(visible(page, "ProvisioningFailed ×6 · could not create volume")).toBeVisible();
  await expect(visible(page, "93%")).toBeVisible();
  await expect(visible(page, "1 not bound")).toBeVisible();
  await visible(page, "data-ledger-db-0").click();
  await expect(visible(page, "StatefulSet/ledger-db")).toBeVisible();
  await page.getByRole("radio", { name: "Storage classes" }).click();
  await expect(visible(page, "WaitForFirstConsumer")).toBeVisible();
});

test("network policies of a pod, and a connection check", async ({ page }) => {
  await page.getByRole("tab", { name: /^Pods/ }).click();
  await visible(page, "checkout-api-7d9f8b6c4-9rkzd").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Network policies" }).click();
  await expect(visible(page, "Pods app=gateway in namespaces zone=edge")).toBeVisible();
  await expect(visible(page, /runs Cilium, which enforces them/)).toBeVisible();
  await expect(visible(page, "open: no policy selects it")).toBeVisible();
  await page.getByLabel("To pod (namespace/name) or IP").fill("payments/checkout-api-7d9f8b6c4-h2pqs");
  await page.getByLabel("Port").fill("5432");
  await page.getByRole("button", { name: "Check", exact: true }).click();
  await expect(visible(page, "Denied")).toBeVisible();
  expect(backend.argsOf("CheckConnection")[0]).toEqual(["prod-eu-west-1", "payments", "checkout-api-7d9f8b6c4-9rkzd", "payments", "checkout-api-7d9f8b6c4-h2pqs", "", 5432, "TCP"]);
});

test("service chain explains why a Service has nothing to route to", async ({ page }) => {
  await sidebar(page, /^Services/).click();
  await visible(page, "10.96.12.4").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Service chain" }).click();
  await expect(visible(page, "Likely cause: service/checkout-api has no ready endpoints")).toBeVisible();
  await expect(page.getByRole("status").getByText(/Readiness probe failed: connection refused/)).toBeVisible();
  await expect(visible(page, "Selector app=checkout-api matches 1 pod")).toBeVisible();
  await expect(visible(page, "0 ready · 1 not ready")).toBeVisible();
  expect(backend.argsOf("ServiceChain")[0]).toEqual(["prod-eu-west-1", "payments", "Service", "checkout-api"]);
});

test("a context that now points to another server locks changes until confirmed", async ({ page, context }) => {
  await page.close();
  const p = await context.newPage();
  const b = await openDesktop(p, { targetChanged: { "prod-eu-west-1": { from: "https://10.0.0.1:6443", to: "https://10.9.9.9:6443" } } });
  await expect(p.locator("nav, aside").getByTitle(/Points to another API server/).first()).toBeVisible();
  await palette(p, "Connections");
  await expect(p.getByText(/now points to https:\/\/10\.9\.9\.9:6443 \(was https:\/\/10\.0\.0\.1:6443\)/)).toBeVisible();
  await p.getByRole("button", { name: "Keep PROD · protected and allow changes" }).click();
  await expect(p.getByText("New server confirmed")).toBeVisible();
  expect(b.argsOf("ConfirmTarget")).toEqual([["prod-eu-west-1"]]);
  expect(b.errors).toEqual([]);
});

test("a view that crashes stays in its tab, is logged and can be reloaded", async ({ page, context }) => {
  await page.close();
  const p = await context.newPage();
  let broken = true;
  const b = await openDesktop(p, {
    // A malformed answer makes the service chain view throw while rendering.
    answers: { ServiceChain: () => (broken ? { services: null, checks: null } : { services: [], checks: [] }) },
  });
  await sidebar(p, /^Services/).click();
  await visible(p, "10.96.12.4").click({ button: "right" });
  await p.getByRole("menuitem", { name: "Service chain" }).click();
  await expect(visible(p, "This view stopped working")).toBeVisible();
  await expect.poll(() => b.argsOf("LogClientError").length).toBeGreaterThan(0);
  expect(String(b.argsOf("LogClientError")[0]![0])).toContain("chain tab:");
  // Other tabs keep working.
  await p.getByRole("tab", { name: /^Pods/ }).click();
  await expect(visible(p, "checkout-api-7d9f8b6c4-x2kqp")).toBeVisible();
  // Reload view renders it again from fresh state.
  broken = false;
  await p.getByRole("tab", { name: /Chain · checkout-api/ }).click();
  await p.getByRole("button", { name: "Reload view" }).click();
  await expect(p.getByText("This view stopped working")).toHaveCount(0);
  await expect(visible(p, "Checks, in the order a request meets them")).toBeVisible();
  // React reports the caught error on the console; nothing else may.
  expect(b.errors.filter((e) => !/stopped working|Cannot read properties of null|chain tab|services/i.test(e))).toEqual([]);
});
