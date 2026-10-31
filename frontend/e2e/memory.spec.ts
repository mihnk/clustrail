import { expect, test } from "@playwright/test";
import { openDesktop } from "./fake-backend";

// Memory under a watch storm: the Pods table keeps its rows across updates
// (lib/rowModel.ts), and a kept row must not keep the render it was made in.
// It did: every render left its data array and callbacks alive, 2-3 GB of
// WebView memory after a minute of 1,000 changes/s. Chromium only (CDP).

const PODS = 10_000;

test("a watch storm does not grow the page's memory", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "needs the Chrome DevTools Protocol");
  test.setTimeout(120_000);
  const fixturePod = (cluster: string, i: number) => ({
    id: `${cluster}/team-${i % 40}/app-${i}`, name: `app-${i}`, namespace: `team-${i % 40}`, cluster, env: "prod", node: `node-${i % 250}`,
    health: "healthy", status: "Running", reason: "", readyContainers: 1, totalContainers: 1, restarts: 0, cpuMilli: 10 + (i % 900), memoryMiB: 64 + (i % 1500),
    ageSeconds: 60 + i, owner: { kind: "ReplicaSet", name: "app" }, labels: { app: "app" },
  });
  const rows = Array.from({ length: PODS }, (_, i) => fixturePod("prod-eu-west-1", i));
  const backend = await openDesktop(page, { pods: (c) => (c === "prod-eu-west-1" ? rows : []) });
  await page.getByRole("tab", { name: /^Pods/ }).click();
  await expect(page.getByRole("grid", { name: "Pods" }).first()).toHaveAttribute("aria-rowcount", /\d{4,}/);

  // 1,000 changes/s in 20 ms batches, like the Go sender.
  let n = 0;
  const storm = setInterval(() => {
    const up = [];
    for (let i = 0; i < 20; i++) {
      const k = (n++ * 7919) % PODS;
      rows[k] = { ...rows[k]!, restarts: rows[k]!.restarts + 1 };
      up.push(rows[k]);
    }
    backend.podDelta("prod-eu-west-1", up);
  }, 20);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const heapAfterGC = async () => {
    await cdp.send("HeapProfiler.collectGarbage");
    const { metrics } = await cdp.send("Performance.getMetrics");
    return (metrics.find((m) => m.name === "JSHeapUsedSize")?.value ?? 0) / 1e6;
  };
  try {
    await page.waitForTimeout(10_000); // warm up: rows, caches, JIT
    const before = await heapAfterGC();
    await page.waitForTimeout(20_000);
    const after = await heapAfterGC();
    // Without the fix: +180 MB in these 20 s; with it: +3 MB.
    expect(after - before, `JS heap after GC: ${before.toFixed(0)} MB → ${after.toFixed(0)} MB`).toBeLessThan(30);
  } finally {
    clearInterval(storm);
  }
  expect(backend.errors, "console errors").toEqual([]);
});
