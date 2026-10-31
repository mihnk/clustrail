// Benchmarks that run inside the desktop app (CLUSTRAIL_BENCH), so they measure
// the real WebView, the real Wails stream and the Go pipeline together.
// Results go back to Go (ReportBench), which writes them to a file and quits.
import { backend, type BackendDiagnostics } from "@/backend/client";
import { podStream } from "@/backend/podStream";
import type { PodRow } from "@/data/types";
import { afterPaint, FrameMonitor, sleep, stats, timed, traceRafCallers, wakeCounts } from "./monitor";
import { t } from "@/i18n";

type Open = (view: "pods") => void;

const visibleEl = <T extends HTMLElement>(sel: string) => [...document.querySelectorAll<T>(sel)].find((e) => e.offsetParent !== null) ?? null;
// Selectors use the UI language's labels, so a run works in any language.
const grid = () => visibleEl<HTMLElement>(`[role=grid][aria-label="${t("Pods")}"]`);
const scroller = () => grid()?.querySelector<HTMLElement>('[tabindex="0"]') ?? null;
const rowCount = () => Number(grid()?.getAttribute("aria-rowcount") ?? 0);

async function waitFor(cond: () => boolean, timeoutMs: number, what: string) {
  const end = performance.now() + timeoutMs;
  while (!cond()) {
    if (performance.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

function checksum(rows: PodRow[], cluster: string) {
  let sum = 0;
  let count = 0;
  for (const r of rows) {
    if (r.cluster !== cluster) continue;
    count++;
    const s = `${r.id}|${r.status}|${r.restarts}|${r.readyContainers}/${r.totalContainers}`;
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    sum = (sum + h) >>> 0;
  }
  return { count, sum };
}

function setInput(el: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

async function scrollTest(seconds: number, mode: "steady" | "jump") {
  const el = scroller();
  if (!el) throw new Error("pods table not found");
  const mon = new FrameMonitor();
  mon.start();
  const end = performance.now() + seconds * 1000;
  let dir = 1;
  while (performance.now() < end) {
    await new Promise((r) => requestAnimationFrame(r));
    const max = el.scrollHeight - el.clientHeight;
    if (mode === "jump") el.scrollTop = Math.random() * max;
    else {
      // About 2,400 px/s at 60 Hz: a fast wheel or trackpad scroll.
      el.scrollTop += dir * 40;
      if (el.scrollTop >= max - 1 || el.scrollTop <= 0) dir = -dir;
    }
  }
  const out = mon.stop();
  el.scrollTop = 0;
  return out;
}

async function searchTest(rounds: number) {
  const input = grid() && visibleEl<HTMLInputElement>(`input[placeholder="${t("Filter name, label, node…")}"]`);
  if (!input) throw new Error("pods filter not found");
  const queries = ["checkout", "team-01", "crash", "node-001", "zzzz-none", ""];
  const samples: number[] = [];
  let timeouts = 0;
  for (let r = 0; r < rounds; r++) {
    for (const q of queries) {
      const before = rowCount();
      const start = performance.now();
      setInput(input, q);
      // The table filters with a deferred value: wait for its row count to change (or 1 s).
      const end = start + 1000;
      while (rowCount() === before && performance.now() < end) await new Promise((res) => requestAnimationFrame(res));
      if (rowCount() === before) timeouts++;
      samples.push((await afterPaint()) - start);
    }
  }
  return { ms: stats(samples), unchangedCount: timeouts, queries };
}

async function sortTest(rounds: number) {
  const out: Record<string, ReturnType<typeof stats>> = {};
  for (const label of ["Status", "Restarts", "Age"]) {
    const header = [...document.querySelectorAll<HTMLElement>(`[role=grid][aria-label="${t("Pods")}"] [role=columnheader]`)].find((h) => h.textContent?.trim() === t(label));
    const button = header?.querySelector("button");
    if (!header || !button) continue;
    const samples: number[] = [];
    for (let i = 0; i < rounds; i++) samples.push(await timed(() => button.click()));
    out[label] = stats(samples);
  }
  return out;
}

async function inspectorTest(samples: number) {
  const open: number[] = [];
  for (let i = 0; i < samples; i++) {
    const rows = [...(scroller()?.querySelectorAll<HTMLElement>('[role=row]') ?? [])];
    const row = rows[(i * 3) % Math.max(1, rows.length)];
    const cell = row?.querySelector<HTMLElement>('[role=gridcell]:nth-child(3)') ?? row;
    if (!cell) break;
    const start = performance.now();
    cell.click();
    await waitFor(() => !!document.querySelector(`[aria-label="${t("Pod inspector")}"]`), 2000, "inspector");
    open.push((await afterPaint()) - start);
    document.querySelector<HTMLElement>(`[aria-label="${t("Pod inspector")}"] button[aria-label="${t("Close inspector")}"]`)?.click();
    await afterPaint();
  }
  return stats(open);
}

async function sampleBackend(seconds: number, every = 2) {
  const samples: { t: number; heapMB: number; cpu: number; pending: number; events: number; goroutines: number; rows: number }[] = [];
  const t0 = performance.now();
  while (performance.now() - t0 < seconds * 1000) {
    const d = await backend!.diagnostics();
    samples.push({ t: Math.round((performance.now() - t0) / 100) / 10, heapMB: Math.round(d.process.heapInuseMB), cpu: Math.round(d.process.cpuPercent), pending: d.pending, events: d.events, goroutines: d.process.goroutines, rows: d.rows });
    await sleep(every * 1000);
  }
  return samples;
}

/** One idle phase: CPU, wakeups and callbacks per second, from differences of cumulative counters. */
async function idlePhase(name: string, seconds: number) {
  const api = backend!;
  const before = await api.diagnostics();
  const page0 = { ...wakeCounts };
  // DOM changes while nothing happens, by where they happen: each one costs
  // style, layout and paint (and wakes the Wails window-region observer).
  const mutations: Record<string, number> = {};
  let mutationCount = 0;
  const where = (n: Node) => {
    const el = n instanceof Element ? n : n.parentElement;
    if (!el) return "?";
    const label = el.closest("[aria-label],[role]");
    const tag = (e: Element) => e.tagName.toLowerCase() + (e.getAttribute("aria-label") ? `[${e.getAttribute("aria-label")}]` : e.getAttribute("role") ? `[role=${e.getAttribute("role")}]` : "");
    return label && label !== el ? `${tag(label)} > ${tag(el)}` : tag(el);
  };
  const observer = new MutationObserver((list) => {
    for (const m of list) {
      mutationCount++;
      const k = `${m.type}${m.attributeName ? ":" + m.attributeName : ""} ${where(m.target)}`;
      mutations[k] = (mutations[k] ?? 0) + 1;
    }
  });
  observer.observe(document.documentElement, { attributes: true, childList: true, subtree: true, characterData: true });
  // Events from Go while nothing changes, by name.
  const events: Record<string, number> = {};
  const w = window as unknown as { _wails?: { dispatchWailsEvent?: (e: { name: string }) => void } };
  const dispatch = w._wails?.dispatchWailsEvent;
  if (w._wails && dispatch) {
    w._wails.dispatchWailsEvent = (e) => {
      events[e.name] = (events[e.name] ?? 0) + 1;
      dispatch.call(w._wails, e);
    };
  }
  traceRafCallers(true);
  const startedAt = Date.now();
  await sleep(seconds * 1000);
  const endedAt = Date.now();
  observer.disconnect();
  const rafCallers = traceRafCallers(false) ?? {};
  if (w._wails && dispatch) w._wails.dispatchWailsEvent = dispatch;
  const after = await api.diagnostics();
  const sec = (endedAt - startedAt) / 1000;
  const perSec = (a: number, b: number) => Math.round(((a - b) / sec) * 100) / 100;
  const loops: Record<string, number> = {};
  for (const [k, v] of Object.entries(after.wakeups ?? {})) loops[k] = perSec(v, before.wakeups?.[k] ?? 0);
  return {
    name,
    visibility: document.visibilityState,
    startedAt,
    endedAt,
    seconds: Math.round(sec * 10) / 10,
    // CPU as % of one core; wakeups as voluntary context switches per second.
    go: { cpuPercent: perSec(after.process.cpuTimeMs, before.process.cpuTimeMs) / 10, wakeupsPerSec: perSec(after.process.voluntarySwitches, before.process.voluntarySwitches) },
    family: after.family?.supported
      ? { processes: after.family.processes, cpuPercent: perSec(after.family.cpuTimeMs, before.family.cpuTimeMs) / 10, wakeupsPerSec: perSec(after.family.voluntarySwitches, before.family.voluntarySwitches), rssMB: Math.round(after.family.rssMB) }
      : "measured from outside (hack/bench.sh)",
    backendLoopsPerSec: loops,
    // The phase's own sleep is one timeout.
    pagePerSec: { timeouts: perSec(wakeCounts.timeout - 1, page0.timeout), intervals: perSec(wakeCounts.interval, page0.interval), animationFrames: perSec(wakeCounts.raf, page0.raf) },
    domMutationsPerSec: perSec(mutationCount, 0),
    topMutations: Object.entries(mutations)
      .sort((x, y) => y[1] - x[1])
      .slice(0, 8)
      .map(([k, n]) => `${perSec(n, 0)}/s ${k}`),
    eventsPerSec: Object.fromEntries(Object.entries(events).map(([k, n]) => [k, perSec(n, 0)])),
    animationFrameCallers: Object.entries(rafCallers)
      .sort((x, y) => y[1] - x[1])
      .slice(0, 4)
      .map(([k, n]) => `${perSec(n, 0)}/s ${k}`),
    goHeapMB: Math.round(after.process.heapInuseMB),
    goroutines: after.process.goroutines,
  };
}

function summarizeBackend(d: BackendDiagnostics) {
  const { process, ...rest } = d;
  return { process, ...rest };
}

export async function runBenchmark(cfg: Record<string, string>, open: Open) {
  const api = backend!;
  const scenario = cfg.scenario ?? "table";
  const seconds = Number(cfg.seconds || (scenario === "storm" || scenario === "idle" ? 60 : 30));
  const result: Record<string, unknown> = {
    scenario,
    synthetic: cfg.synthetic,
    environment: {
      userAgent: navigator.userAgent,
      cores: navigator.hardwareConcurrency,
      screen: `${window.innerWidth}x${window.innerHeight}@${window.devicePixelRatio}`,
      build: import.meta.env.MODE,
    },
  };
  const t0 = performance.now();
  try {
    open("pods");
    const spec = Object.fromEntries((cfg.synthetic ?? "").split(",").map((p) => p.split("=")).filter((p) => p.length === 2));
    const clusters = Number(spec.clusters ?? 1);
    const ready = () => podStream.states().filter((s) => s.snapshotMs !== null).length;
    await waitFor(() => podStream.states().length === clusters && ready() >= clusters - Number(spec.slow ?? 0), 120_000, "snapshots");
    await waitFor(() => rowCount() > 1, 180_000, "table rows");
    await afterPaint();
    result.loadMs = Math.round(performance.now() - t0);
    result.rows = podStream.rows().length;
    result.domRows = scroller()?.querySelectorAll("[role=row]").length ?? 0;
    await api.resetDiagnostics();

    // Baseline: frames with nothing happening (rendering cost of the app at rest).
    const idle = new FrameMonitor();
    idle.start();
    await sleep(3000);
    result.idle = idle.stop();
    if (scenario === "table") {
      result.scrollSteady = await scrollTest(6, "steady");
      result.scrollJump = await scrollTest(4, "jump");
      result.search = await searchTest(3);
      result.sort = await sortTest(4);
      result.inspector = await inspectorTest(15);
    } else if (scenario === "storm") {
      const mon = new FrameMonitor();
      mon.start();
      result.backendSamples = await sampleBackend(seconds);
      result.frames = mon.stop();
      result.scrollDuringStorm = await scrollTest(5, "steady");
      // Consistency: stop changes, let the pipeline drain, compare with Go's rows.
      await api.setSyntheticPaused(true);
      await sleep(1500);
      const cluster = podStream.states()[0]!.cluster;
      const ui = checksum(podStream.rows(), cluster);
      const go = await api.podChecksum(cluster);
      result.consistency = { ui, go, equal: ui.count === go.count && ui.sum === go.sum };
      await api.setSyntheticPaused(false);
    } else if (scenario === "idle") {
      // Nothing changes: what does the app still do, visible and hidden?
      const visible = await idlePhase("visible", seconds);
      await api.benchWindow(false);
      await sleep(2000);
      const hidden = await idlePhase("hidden", seconds);
      await api.benchWindow(true);
      result.phases = [visible, hidden];
    } else if (scenario === "multi") {
      const mon = new FrameMonitor();
      mon.start();
      result.backendSamples = await sampleBackend(seconds, 3);
      result.frames = mon.stop();
      result.clusters = podStream.states().map((s) => ({ ...s, snapshotMs: s.snapshotMs === null ? null : Math.round(s.snapshotMs) }));
    }
    result.stream = {
      frames: podStream.metrics.frames,
      gaps: podStream.metrics.gaps,
      applyMs: stats(podStream.metrics.applyMs),
      receiveToPaintMs: stats(podStream.metrics.renderMs),
      updateCostMs: stats(podStream.metrics.paintMs),
    };
    result.backend = summarizeBackend(await api.diagnostics());
  } catch (e) {
    result.error = String(e);
  }
  result.totalMs = Math.round(performance.now() - t0);
  await api.reportBench(JSON.stringify(result, null, 2));
}
