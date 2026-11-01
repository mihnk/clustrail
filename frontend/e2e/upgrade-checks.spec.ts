import { expect, test } from "@playwright/test";
import { openDesktop } from "./fake-backend";

// API removals: findings come from Helm manifests, last-applied and the API
// server's count; the target version picks which ones count.
test("API removals by target version", async ({ page }) => {
  const backend = await openDesktop(page, {
    answers: {
      APIRemovals: (args) => ({
        cluster: args[0], server: "1.30", minor: 30, releases: 4, objects: 120, apiServerStarted: "2026-10-23T08:00:00Z",
        notes: ["API server metrics: not allowed (needs get on the /metrics URL)"],
        findings: [
          { source: "helm", apiVersion: "autoscaling/v2beta2", kind: "HorizontalPodAutoscaler", removed: "1.26", replacement: "autoscaling/v2", namespace: "payments", name: "billing-workers", release: "billing", revision: 14 },
          { source: "applied", apiVersion: "flowcontrol.apiserver.k8s.io/v1beta3", kind: "FlowSchema", removed: "1.32", replacement: "flowcontrol.apiserver.k8s.io/v1", name: "batch-jobs" },
          { source: "apiserver", apiVersion: "networking.k8s.io/v1beta1", resource: "ipaddresses", kind: "IPAddress", removed: "1.37" },
          { source: "apiserver", apiVersion: "example.io/v1alpha1", resource: "widgets", removed: "" },
        ],
      }),
    },
  });
  await page.keyboard.press("Control+k");
  await page.keyboard.type("API removals");
  await page.keyboard.press("Enter");
  const findings = page.getByRole("region", { name: "Findings" });
  // Default target: one minor above the cluster (1.31). Only the HPA counts: already removed.
  await expect(findings.getByText("payments/billing-workers")).toBeVisible();
  await expect(findings.getByText("batch-jobs")).toHaveCount(0);
  await expect(page.getByText("Helm reads this manifest to find the release's current objects", { exact: false })).toBeVisible();
  await expect(findings.getByText(/Deprecated, no removal release set:/)).toContainText("example.io/v1alpha1 widgets");
  await expect(findings.getByText(/Not checked: prod-eu-west-1: API server metrics: not allowed/)).toBeVisible();

  await page.getByRole("radio", { name: "1.32" }).click();
  await expect(findings.getByText("batch-jobs")).toBeVisible();
  await expect(findings.getByText("ipaddresses")).toHaveCount(0);
  await findings.getByText("batch-jobs").click();
  await expect(page.getByText("Removed in 1.32; this cluster runs 1.30")).toBeVisible();
  await expect(page.getByText(/Change apiVersion to flowcontrol.apiserver.k8s.io\/v1 in the file/)).toBeVisible();
  expect(backend.argsOf("APIRemovals")[0]).toEqual(["prod-eu-west-1"]);
  expect(backend.errors).toEqual([]);
});

test("quotas: full first, LimitRange defaults and refusals", async ({ page }) => {
  const backend = await openDesktop(page, {
    answers: {
      Quotas: (args) => ({
        cluster: args[0],
        notes: [],
        quotas: [
          { namespace: "payments", name: "compute", scopes: [], items: [
            { resource: "pods", used: "50", hard: "50", ratio: 1, full: true },
            { resource: "requests.cpu", used: "7500m", hard: "8", ratio: 0.9375, full: false },
          ] },
          { namespace: "search", name: "compute", scopes: ["NotBestEffort"], items: [{ resource: "requests.cpu", used: "3", hard: "12", ratio: 0.25, full: false }] },
        ],
        limits: [
          { namespace: "payments", name: "defaults", items: [{ type: "Container", resource: "cpu", defaultRequest: "100m", default: "500m", max: "2" }] },
          { namespace: "tools", name: "small", items: [{ type: "Container", resource: "memory", defaultRequest: "64Mi", default: "128Mi" }] },
        ],
        rules: [
          { namespace: "payments", kind: "defaults", resource: "requests.cpu", quota: "compute", value: "100m" },
          { namespace: "search", kind: "needs", resource: "limits.memory", quota: "compute" },
        ],
      }),
    },
  });
  await page.keyboard.press("Control+k");
  await page.keyboard.type("Quotas and limits");
  await page.keyboard.press("Enter");
  await expect(page.getByText("2 namespaces with a quota · 1 full · 1 clusters")).toBeVisible();
  const detail = page.getByRole("complementary", { name: "Selected namespace" });
  // The fullest namespace is selected first.
  await expect(detail.getByText(/pods 50 \/ 50: the API server refuses anything that adds to it/)).toBeVisible();
  await expect(detail.getByText("A container without a cpu request gets 100m (LimitRange).")).toBeVisible();
  await expect(detail.getByText("A container with a cpu request or limit above 2 is refused.")).toBeVisible();
  await expect(page.getByText("Containers must set a memory limit: a pod without one is refused (quota compute).")).toBeVisible();

  await page.getByRole("button", { name: "tools", exact: true }).click();
  await expect(detail.getByText("tools", { exact: true })).toBeVisible();
  await expect(detail.getByRole("button", { name: "Open the quota" })).toHaveCount(0);
  await page.getByLabel("Filter namespaces").fill("sea");
  const list = page.getByRole("region", { name: "Quotas" });
  await expect(list.getByText("payments", { exact: true })).toHaveCount(0);
  await expect(list.getByText("search", { exact: true })).toBeVisible();
  expect(backend.errors).toEqual([]);
});
