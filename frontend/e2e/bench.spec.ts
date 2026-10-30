import { writeFileSync } from "node:fs";
import { test } from "@playwright/test";
import { openDesktop } from "./fake-backend";

// The in-app benchmark (features/bench/runner.ts) in Chromium, with the Go side
// faked: separates the UI's own cost from WebKitGTK/Xvfb rendering in the native
// runs. Opt-in: CLUSTRAIL_BENCH_PODS=10000 npx playwright test e2e/bench.spec.ts

const pods = Number(process.env.CLUSTRAIL_BENCH_PODS ?? 0);
const scenario = process.env.CLUSTRAIL_BENCH_SCENARIO ?? "table";
const rate = Number(process.env.CLUSTRAIL_BENCH_RATE ?? 1000);
test.skip(!pods, "set CLUSTRAIL_BENCH_PODS to run");
test.setTimeout(300_000);

function synthetic(n: number) {
  const apps = ["api", "web", "worker", "checkout", "payments", "ledger", "search", "auth"];
  const statuses: [string, string][] = [["Running", "healthy"], ["Running", "healthy"], ["Running", "healthy"], ["CrashLoop", "failed"], ["Pending", "warning"]];
  return Array.from({ length: n }, (_, i) => {
    const app = apps[i % apps.length]!;
    const ns = `team-${String(i % 40).padStart(3, "0")}`;
    const name = `${app}-${(i * 7919).toString(36)}-${String(i).padStart(5, "0")}`;
    const [status, health] = statuses[i % statuses.length]!;
    return {
      id: `synthetic-01/${ns}/${name}`, name, namespace: ns, cluster: "synthetic-01", env: "dev", node: `node-${String(i % 250).padStart(4, "0")}`,
      health, status, reason: "", readyContainers: 1, totalContainers: 1, restarts: i % 13, cpuMilli: 10 + (i % 900), memoryMiB: 64 + (i % 1500),
      ageSeconds: 60 + i * 37, owner: { kind: "ReplicaSet", name: `${app}-x` }, labels: { app },
    };
  });
}

function checksum(rows: { id: string; status: string; restarts: number; readyContainers: number; totalContainers: number }[]) {
  let sum = 0;
  for (const r of rows) {
    const s = `${r.id}|${r.status}|${r.restarts}|${r.readyContainers}/${r.totalContainers}`;
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    sum = (sum + h) >>> 0;
  }
  return { count: rows.length, sum };
}

test(`in-app ${scenario} benchmark (Chromium)`, async ({ page }) => {
  const cluster = { id: "synthetic-01", name: "synthetic-01", context: "synthetic-01", env: "dev", protected: false, connection: "connected", latencyMs: 0, summary: "synthetic", readOnly: false, metrics: null, source: "CLUSTRAIL_SYNTHETIC" };
  const rows = synthetic(pods);
  let result = "";
  let paused = false;
  const diag = { process: { cpuPercent: 0, heapAllocMB: 0, heapInuseMB: 0, sysMB: 0, totalAllocMB: 0, numGC: 0, gcPauseMs: 0, gcCPU: 0, goroutines: 0 }, watches: 1, consumers: 1, rows: pods, pending: 0, events: 0, frames: 0, bytes: 0, snapshots: 1, sendFull: 0, resyncs: 0, maxBatch: 0, queue: {}, encode: {}, round: {}, ui: {}, visible: {}, size: {}, at: 0 };
  const backend = await openDesktop(page, {
    clusters: [cluster],
    pods: (c) => (c === "synthetic-01" ? rows : []),
    answers: {
      BenchConfig: () => ({ scenario, synthetic: `pods=${pods},rate=${rate}`, seconds: process.env.CLUSTRAIL_BENCH_SECONDS ?? "" }),
      SetSyntheticPaused: (args) => ((paused = !!args[0]), null),
      PodChecksum: () => checksum(rows),
      Diagnostics: () => diag,
      ResetDiagnostics: () => null,
      ReportBench: (args) => ((result = String(args[0])), null),
      Snapshot: () => ({ clusters: [cluster], pods: [], deployments: [], nodes: [], helm: [], gitops: [] }),
    },
  });
  // Storm: the fake stream changes rows at the given rate, in 20 ms batches like the Go sender.
  if (scenario === "storm") {
    let n = 0;
    const timer = setInterval(() => {
      if (paused) return;
      const up = [];
      for (let i = 0; i < rate / 50; i++) {
        const k = (n++ * 7919) % rows.length;
        const r = { ...rows[k]!, restarts: rows[k]!.restarts + 1, status: n % 3 ? "Running" : "CrashLoop", health: n % 3 ? "healthy" : "failed" };
        rows[k] = r;
        up.push(r);
      }
      backend.podDelta("synthetic-01", up);
    }, 20);
    page.on("close", () => clearInterval(timer));
  }
  const cdp = await page.context().newCDPSession(page);
  if (process.env.CLUSTRAIL_BENCH_PROFILE) {
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
    await cdp.send("Profiler.start");
  }
  await test.expect.poll(() => result, { timeout: 280_000, intervals: [1000] }).not.toBe("");
  if (process.env.CLUSTRAIL_BENCH_PROFILE) {
    const { profile } = await cdp.send("Profiler.stop");
    writeFileSync(process.env.CLUSTRAIL_BENCH_PROFILE, JSON.stringify(profile));
  }
  writeFileSync(process.env.CLUSTRAIL_BENCH_OUT ?? "bench-chromium.json", result);
});
