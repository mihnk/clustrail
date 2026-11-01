import { expect, test, type Page } from "@playwright/test";
import { openDesktop } from "./fake-backend";

const palette = async (page: Page, entry: string) => {
  await page.keyboard.press("Control+k");
  await page.keyboard.type(entry);
  await page.keyboard.press("Enter");
};

// JSON log lines get a column per field; a value filters; a trace is followed across the namespace's pods.
test("structured logs: fields, a filter, and a trace across pods", async ({ page }) => {
  const backend = await openDesktop(page);
  await palette(page, "Deployments");
  await page.locator('button:has-text("Logs") >> visible=true').first().click();
  await expect.poll(() => backend.calls).toContain("StartLogs");
  const json = (o: Record<string, unknown>) => JSON.stringify(o);
  await backend.emit("clustrail:logs", {
    id: "logs-1",
    lines: [
      { pod: "checkout-api-7d9f8b6c4-x2kqp", container: "api", ts: "12:00:01.000", level: "ERROR", msg: json({ level: "error", msg: "charge declined", route: "/v1/charge", trace_id: "4bf92f3577b34da6" }) },
      { pod: "checkout-api-7d9f8b6c4-9rkzd", container: "api", ts: "12:00:02.000", level: "INFO", msg: json({ level: "info", msg: "refund ok", route: "/v1/refund", trace_id: "a3ce929d0e0e4736" }) },
      { pod: "checkout-api-7d9f8b6c4-9rkzd", container: "api", ts: "12:00:03.000", level: "INFO", msg: "plain text line" },
    ],
  });
  await page.getByRole("radio", { name: "Fields" }).click();
  const grid = page.getByRole("grid", { name: "Structured log lines" });
  await expect(grid.getByText("charge declined")).toBeVisible();
  await expect(page.getByText("2 of the last 3 lines are JSON")).toBeVisible();
  // trace_id and route are columns; clicking a value filters on it.
  await grid.getByRole("button", { name: "/v1/refund" }).click();
  await expect(page.getByText("route=/v1/refund")).toBeVisible();
  await expect(grid.getByText("charge declined")).toHaveCount(0);
  await expect(grid.getByText("refund ok")).toBeVisible();
  // The selected line's trace is followed in a new tab over every pod of the namespace.
  await grid.getByText("refund ok").click();
  await page.getByRole("button", { name: "Follow trace_id across pods" }).click();
  await expect.poll(() => backend.argsOf("StartLogs").length).toBe(2);
  const req = backend.argsOf("StartLogs")[1]![0] as { sources: { namespace: string; all?: boolean }[]; sinceSeconds: number };
  expect(req.sources).toEqual([{ namespace: "payments", all: true }]);
  expect(req.sinceSeconds).toBe(3600);
  await expect(page.getByRole("tab", { name: /Trace a3ce929d/ })).toBeVisible();
  expect(backend.errors).toEqual([]);
});
