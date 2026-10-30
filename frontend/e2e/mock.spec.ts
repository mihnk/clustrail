import { expect, test } from "@playwright/test";

// The browser preview (no Go side): every view renders on mock data without errors.

test("every view opens without console errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto("/");
  await expect(page.getByText("MOCK DATA").first()).toBeVisible();
  for (const view of ["Clusters", "Pods", "Deployments", "Nodes", "Helm releases", "GitOps", "Connections", "Settings", "Services"]) {
    await page.keyboard.press("Control+k");
    await page.keyboard.type(`Go to ${view}`);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("tab", { name: new RegExp(`^${view}`) }).first()).toBeVisible();
  }
  expect(errors).toEqual([]);
});
