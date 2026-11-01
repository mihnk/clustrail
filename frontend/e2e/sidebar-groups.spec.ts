import { expect, test } from "@playwright/test";
import { openDesktop } from "./fake-backend";

// The sidebar groups kinds like Lens; kinds no cluster serves are left out,
// custom resources come from the CRD flag and fold by API group.
test("sidebar groups and custom resources", async ({ page }) => {
  const backend = await openDesktop(page);
  const nav = page.getByRole("complementary", { name: "Navigation" });
  const config = nav.getByRole("region", { name: "Config" });
  await expect(config.getByRole("button", { name: /^HorizontalPodAutoscalers/ })).toBeVisible();
  await expect(config.getByRole("button", { name: /^PodDisruptionBudgets/ })).toBeVisible();
  // The fake cluster serves no Leases or RuntimeClasses.
  await expect(config.getByRole("button", { name: /^Leases/ })).toHaveCount(0);
  await expect(config.getByRole("button", { name: /^RuntimeClasses/ })).toHaveCount(0);
  await expect(nav.getByRole("region", { name: "Workloads" }).getByRole("button", { name: /^ReplicaSets/ })).toBeVisible();

  await config.getByRole("button", { name: /^HorizontalPodAutoscalers/ }).click();
  await expect.poll(() => backend.argsOf("ListResources").some((a) => a[1] === "autoscaling/HorizontalPodAutoscaler") || backend.argsOf("StartListWatch").some((a) => JSON.stringify(a).includes("autoscaling/HorizontalPodAutoscaler"))).toBe(true);

  // Access control and custom resources start folded.
  const access = nav.getByRole("region", { name: "Access control" });
  await expect(access.getByRole("button", { name: /^ClusterRoles/ })).toHaveCount(0);
  await access.getByRole("button", { name: "Access control" }).click();
  await expect(access.getByRole("button", { name: /^ClusterRoles/ })).toBeVisible();

  const custom = nav.getByRole("region", { name: "Custom resources" });
  await custom.getByRole("button", { name: /Custom resources/ }).click();
  await expect(custom.getByRole("button", { name: /^Definitions/ })).toBeVisible();
  await expect(custom.getByRole("button", { name: /^argoproj\.io/ })).toBeVisible();
  await custom.getByRole("button", { name: /^cert-manager\.io/ }).click();
  await custom.getByRole("button", { name: "Certificate", exact: true }).click();
  await expect.poll(() => JSON.stringify([backend.argsOf("ListResources"), backend.argsOf("StartListWatch")]).includes("cert-manager.io/Certificate")).toBe(true);

  // Folds are remembered.
  await page.reload();
  await expect(nav.getByRole("region", { name: "Access control" }).getByRole("button", { name: /^ClusterRoles/ })).toBeVisible();
  await expect(nav.getByRole("region", { name: "Custom resources" }).getByRole("button", { name: "Certificate", exact: true })).toBeVisible();
});
