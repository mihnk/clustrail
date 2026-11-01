import { expect, test } from "@playwright/test";
import { openDesktop } from "./fake-backend";

// Local crash and freeze reports (issue D7).

const report = (p: Record<string, unknown> = {}) => ({
  id: "20261101-140211-panic-1a2b", kind: "panic", at: Date.now() - 3600_000, title: "Internal error in row updates",
  detail: "runtime error: index out of range [3] with length 3", text: "Clustrail 0.9.0 (darwin/arm64)\npanic: index out of range\n\ngoroutine 418 [running]:", offered: false, ...p,
});

test("the crash from last time is offered once at start", async ({ page }) => {
  const backend = await openDesktop(page, { answers: { PendingCrash: () => report() } });
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Clustrail recovered from an internal error last time")).toBeVisible();
  await expect(dialog.getByText(/nothing was sent anywhere/)).toBeVisible();
  await dialog.getByText("Show the report").click();
  await expect(dialog.getByText(/goroutine 418/)).toBeVisible();
  await dialog.getByRole("button", { name: "Continue" }).click();
  await expect(dialog).toHaveCount(0);
  expect(backend.argsOf("AckCrash")).toEqual([["20261101-140211-panic-1a2b"]]);
});

test("Settings lists the reports and deletes one", async ({ page }) => {
  const backend = await openDesktop(page, {
    answers: { CrashReports: () => [report({ offered: true }), report({ id: "20261101-142000-freeze-0c0c", kind: "freeze", title: "Window froze for 2.4 s", detail: "Pods · 48,000 rows", offered: true })] },
  });
  await page.keyboard.press("Control+k");
  await page.keyboard.type("Settings");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Window froze for 2.4 s")).toBeVisible();
  await expect(page.getByText("Internal error in row updates")).toBeVisible();
  await page.getByRole("button", { name: "Delete report" }).first().click();
  await expect(page.getByText("Internal error in row updates")).toHaveCount(0);
  expect(backend.argsOf("DeleteCrashReport")).toEqual([["20261101-140211-panic-1a2b"]]);
});

test("a window that stops answering for more than a second is reported", async ({ page }) => {
  const backend = await openDesktop(page, { answers: { ReportFreeze: (args) => report({ id: "20261101-150000-freeze-0001", kind: "freeze", title: `Window froze for ${((args[0] as number) / 1000).toFixed(1)} s`, offered: true }) } });
  await expect(page.getByRole("tab", { name: /^Pods/ })).toBeVisible();
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const end = performance.now() + 1600;
    while (performance.now() < end) {
      // the main thread is busy: timers cannot run
    }
  });
  await expect.poll(() => backend.argsOf("ReportFreeze").length).toBe(1);
  expect(backend.argsOf("ReportFreeze")[0]![0] as number).toBeGreaterThan(1000);
  await expect(page.getByText(/The window froze for/)).toBeVisible();
});
