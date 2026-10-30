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

test("the Turkish interface renders every view, and the language setting switches back", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("langSet")) {
      localStorage.setItem("clustrail.settings.language", JSON.stringify("tr"));
      sessionStorage.setItem("langSet", "1");
    }
  });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("lang", "tr");
  await expect(page.getByText("MOCK DATA").first()).toBeVisible();
  for (const view of ["Cluster'lar", "Pod'lar", "Deployment'lar", "Node'lar", "Helm release'leri", "GitOps", "Bağlantılar", "Ayarlar"]) {
    await page.keyboard.press("Control+k");
    await page.keyboard.type(`${view} sayfasına git`);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("tab", { name: new RegExp(`^${view}`) }).first()).toBeVisible();
  }
  // Settings › Appearance › Language: English reloads the window in English.
  await page.getByRole("radio", { name: "English" }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByText("MOCK DATA").first()).toBeVisible();
  await page.keyboard.press("Control+k");
  await page.keyboard.type("Go to Settings");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Appearance").first()).toBeVisible();
  expect(errors).toEqual([]);
});
