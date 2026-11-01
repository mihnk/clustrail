import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { openDesktop } from "./fake-backend";

// CPU the page spends under a watch storm (10,000 pods, 1,000 changes/s for
// 10 s), with the Pods table in front and with an unrelated view in front.
// A measurement, opt-in: CLUSTRAIL_STORM=1 npx playwright test e2e/storm.spec.ts
// (CLUSTRAIL_STORM_OUT=file.json keeps the numbers). Chromium (CDP).

const PODS = Number(process.env.CLUSTRAIL_STORM_PODS ?? 10_000);
test.skip(!process.env.CLUSTRAIL_STORM, "set CLUSTRAIL_STORM=1 to run");

test("CPU under a watch storm", async ({ page }) => {
  test.setTimeout(180_000);
  const pod = (i: number) => ({
    id: `prod-eu-west-1/team-${i % 40}/app-${i}`, name: `app-${i}`, namespace: `team-${i % 40}`, cluster: "prod-eu-west-1", env: "prod", node: `node-${i % 250}`,
    health: "healthy", status: "Running", reason: "", readyContainers: 1, totalContainers: 1, restarts: 0, cpuMilli: 10 + (i % 900), memoryMiB: 64,
    ageSeconds: 60 + i, owner: { kind: "ReplicaSet", name: "app" }, labels: { app: "app" },
  });
  const rows = Array.from({ length: PODS }, (_, i) => pod(i));
  const backend = await openDesktop(page, { pods: (c) => (c === "prod-eu-west-1" ? rows : []) });
  await page.getByRole("tab", { name: /^Pods/ }).click();
  await expect(page.getByRole("grid", { name: "Pods" }).first()).toHaveAttribute("aria-rowcount", /\d{4,}/);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const metrics = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));

  const storm = async (label: string) => {
    let n = 0;
    const acks0 = backend.streamMessages().filter((m) => m.op === "ack").length;
    const m0 = await metrics();
    const timer = setInterval(() => {
      const up = [];
      for (let i = 0; i < 20; i++) {
        const k = (n++ * 7919) % PODS;
        rows[k] = { ...rows[k]!, cpuMilli: rows[k]!.cpuMilli + 1 };
        up.push(rows[k]);
      }
      backend.podDelta("prod-eu-west-1", up);
    }, 20);
    await page.waitForTimeout(10_000);
    clearInterval(timer);
    await page.waitForTimeout(500);
    const m1 = await metrics();
    // Frames the page rendered (acked after paint) and receive → paint for each, on the page's clock.
    const acks = backend.streamMessages().filter((m) => m.op === "ack").slice(acks0) as { ui?: number }[];
    const ui = acks.map((a) => a.ui ?? 0).sort((a, b) => a - b);
    const pct = (q: number) => (ui.length ? Math.round(ui[Math.min(ui.length - 1, Math.floor(q * ui.length))]!) : 0);
    return {
      view: label,
      renderedFrames: acks.length,
      receiveToPaintP50: pct(0.5),
      receiveToPaintP95: pct(0.95),
      scriptMs: Math.round((m1.ScriptDuration! - m0.ScriptDuration!) * 1000),
      taskMs: Math.round((m1.TaskDuration! - m0.TaskDuration!) * 1000),
      layoutMs: Math.round((m1.LayoutDuration! - m0.LayoutDuration!) * 1000),
      recalcStyleMs: Math.round((m1.RecalcStyleDuration! - m0.RecalcStyleDuration!) * 1000),
    };
  };
  const inFront = await storm("Pods in front");
  await page.keyboard.press("Control+k");
  await page.keyboard.type("Deployments");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("tab", { name: /^Deployments/ })).toBeVisible();
  const behind = await storm("Deployments in front");
  const out = JSON.stringify({ pods: PODS, rate: 1000, seconds: 10, results: [inFront, behind] }, null, 2);
  console.log(out);
  if (process.env.CLUSTRAIL_STORM_OUT) writeFileSync(process.env.CLUSTRAIL_STORM_OUT, out);
});
