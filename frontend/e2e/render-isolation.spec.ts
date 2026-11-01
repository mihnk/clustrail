import { expect, test, type Page } from "@playwright/test";
import { openDesktop } from "./fake-backend";

// Issue C1: pods live in their own store. A pod change that alters nothing a
// component shows must not render it: the sidebar watches two counts, the
// tab strip and the Deployments view no pods at all.

const renders = (page: Page) => page.evaluate(() => ({ ...(window as unknown as { __renders: Record<string, number> }).__renders }));

test("a pod change renders only what shows it", async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __renders: Record<string, number> }).__renders = {};
  });
  const backend = await openDesktop(page);
  await page.keyboard.press("Control+k");
  await page.keyboard.type("Deployments");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("tab", { name: /^Deployments/ })).toBeVisible();
  const pod = backend.fixture.snapshot.pods.find((p: { health: string }) => p.health === "healthy");
  await page.waitForTimeout(500);
  const before = await renders(page);

  // Twenty frames that change a pod's CPU only: no count, no deployment changes.
  for (let i = 0; i < 20; i++) {
    backend.podDelta("prod-eu-west-1", [{ ...pod, cpuMilli: 100 + i }]);
    await page.waitForTimeout(40);
  }
  await page.waitForTimeout(300);
  const after = await renders(page);
  expect(after.sidebar, "sidebar renders").toBe(before.sidebar);
  expect(after.toolbar, "tab strip renders").toBe(before.toolbar);
  expect(after.deployments, "Deployments view renders").toBe(before.deployments);

  // A change the sidebar shows (a pod now needs attention) renders it.
  backend.podDelta("prod-eu-west-1", [{ ...pod, health: "failed", status: "CrashLoopBackOff" }]);
  await expect.poll(async () => (await renders(page)).sidebar).toBeGreaterThan(after.sidebar ?? 0);
  expect(backend.errors).toEqual([]);
});
