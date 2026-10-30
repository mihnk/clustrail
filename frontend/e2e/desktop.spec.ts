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

test("loads the snapshot, shows RBAC limits and pod details", async ({ page }) => {
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
  await backend.emit("clustrail:delta", { cluster: "prod-eu-west-1", kind: "pods", upserts: [extra], deletes: [] });
  await expect(visible(page, "checkout-api-7d9f8b6c4-new01")).toBeVisible();
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
