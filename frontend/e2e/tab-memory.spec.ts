import { expect, test, type Page } from "@playwright/test";
import { openDesktop, type FakeBackend } from "./fake-backend";

// Issue E4: opening and closing tabs (logs, shells, YAML) 50 times leaves no
// editor, terminal or stream behind, and the JS heap comes back to where it
// was. Chromium only (CDP for a forced GC and the heap size).

const visible = (page: Page, text: string | RegExp) => page.getByText(text).filter({ visible: true }).first();
const POD = "checkout-api-7d9f8b6c4-9rkzd";

async function closeActiveTab(page: Page, title: RegExp) {
  await page.getByRole("button", { name: title }).filter({ visible: true }).first().click();
}

async function openLogs(page: Page, backend: FakeBackend, n: number) {
  await page.getByRole("tab", { name: /^Pods/ }).click();
  await visible(page, POD).click({ button: "right" });
  await page.getByRole("menuitem", { name: /^Logs/ }).click();
  await expect.poll(() => backend.argsOf("StartLogs").length).toBe(n);
  await closeActiveTab(page, /^Close Logs/);
}

async function openShell(page: Page, backend: FakeBackend, n: number) {
  await page.getByRole("tab", { name: /^Pods/ }).click();
  await visible(page, POD).click({ button: "right" });
  await page.getByRole("menuitem", { name: /^Shell/ }).click();
  // Production: the context name is typed first.
  const dialog = page.getByRole("alertdialog");
  await dialog.getByRole("textbox").last().fill(`prod-eu-west-1/${POD}`);
  await dialog.getByRole("button", { name: /Open shell/ }).click();
  await expect.poll(() => backend.argsOf("StartExec").length).toBe(n);
  await expect(page.locator(".xterm").filter({ visible: true }).first()).toBeVisible();
  await closeActiveTab(page, /^Close (Shell|sh)/);
}

async function openYaml(page: Page, n: number) {
  await page.getByRole("tab", { name: /^Pods/ }).click();
  await visible(page, POD).click({ button: "right" });
  await page.getByRole("menuitem", { name: /YAML/ }).click();
  await expect(page.locator(".monaco-editor").filter({ visible: true }).first()).toBeVisible();
  void n;
  await closeActiveTab(page, /^Close YAML/);
}

test("50 tabs opened and closed leave nothing behind", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "needs the Chrome DevTools Protocol");
  test.setTimeout(240_000);
  const backend = await openDesktop(page);
  await expect(page.getByRole("tab", { name: /^Pods/ })).toBeVisible();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const heapAfterGC = async () => {
    for (let i = 0; i < 3; i++) await cdp.send("HeapProfiler.collectGarbage");
    const { metrics } = await cdp.send("Performance.getMetrics");
    return (metrics.find((m) => m.name === "JSHeapUsedSize")?.value ?? 0) / 1e6;
  };

  // Warm-up: each kind once, so lazily loaded code (Monaco, xterm) is in memory before the baseline.
  let logs = 0;
  let shells = 0;
  let yamls = 0;
  await openLogs(page, backend, ++logs);
  await openShell(page, backend, ++shells);
  await openYaml(page, ++yamls);
  const before = await heapAfterGC();

  const cycles = Number(process.env.TAB_CYCLES ?? 50);
  for (let i = 0; i < cycles; i++) {
    if (i % 3 === 0) await openLogs(page, backend, ++logs);
    else if (i % 3 === 1) await openShell(page, backend, ++shells);
    else await openYaml(page, ++yamls);
  }

  // Every editor and terminal is gone from the page, every stream was stopped.
  await expect(page.locator(".monaco-editor")).toHaveCount(0);
  await expect(page.locator(".xterm")).toHaveCount(0);
  await expect.poll(() => backend.argsOf("StopLogs").length).toBe(logs);
  await expect.poll(() => backend.argsOf("CloseExec").length).toBe(shells);

  const after = await heapAfterGC();
  console.log(`JS heap after GC: ${before.toFixed(1)} MB before, ${after.toFixed(1)} MB after ${cycles} tabs`);
  expect(after - before, "heap growth over 50 tabs (MB)").toBeLessThan(8);
  expect(backend.errors).toEqual([]);
});
