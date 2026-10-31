// Frame and latency measurement in the page (development diagnostics and benchmarks).

export interface Stats {
  n: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

export function stats(values: number[]): Stats {
  if (!values.length) return { n: 0, p50: 0, p95: 0, p99: 0, max: 0, mean: 0 };
  const v = [...values].sort((a, b) => a - b);
  const at = (p: number) => v[Math.min(v.length - 1, Math.floor(p * v.length))]!;
  const round = (x: number) => Math.round(x * 100) / 100;
  return { n: v.length, p50: round(at(0.5)), p95: round(at(0.95)), p99: round(at(0.99)), max: round(v[v.length - 1]!), mean: round(v.reduce((a, b) => a + b, 0) / v.length) };
}

/** Frame intervals from requestAnimationFrame: FPS and stalls. */
export class FrameMonitor {
  private intervals: number[] = [];
  private last = 0;
  private raf = 0;
  private longTasks: number[] = [];
  private observer: PerformanceObserver | null = null;

  start() {
    this.intervals = [];
    this.longTasks = [];
    this.last = performance.now();
    const loop = (t: number) => {
      this.intervals.push(t - this.last);
      this.last = t;
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
    try {
      this.observer = new PerformanceObserver((list) => list.getEntries().forEach((e) => this.longTasks.push(e.duration)));
      this.observer.observe({ type: "longtask", buffered: false });
    } catch {
      this.observer = null; // WebKit has no Long Tasks API; frame stalls below cover it
    }
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.observer?.disconnect();
    const total = this.intervals.reduce((a, b) => a + b, 0);
    return {
      seconds: Math.round(total / 10) / 100,
      fps: total ? Math.round((this.intervals.length / total) * 1000 * 10) / 10 : 0,
      frameMs: stats(this.intervals),
      // A frame over 50 ms is a visible stall; over 34 ms means at least one missed 60 Hz frame.
      over34ms: this.intervals.filter((x) => x > 34).length,
      over50ms: this.intervals.filter((x) => x > 50).length,
      over100ms: this.intervals.filter((x) => x > 100).length,
      longTasks: this.observer ? stats(this.longTasks) : "unsupported",
    };
  }
}

/** Resolves after the browser painted the frame following the current task. */
export const afterPaint = () => new Promise<number>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(performance.now()))));

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Times an interaction from the call to the paint after it. */
export async function timed(action: () => void): Promise<number> {
  const start = performance.now();
  action();
  return (await afterPaint()) - start;
}

/**
 * Callbacks the page ran, by kind (benchmarks only: installed before the app
 * renders when a benchmark runs). An idle page should run none.
 */
export const wakeCounts = { timeout: 0, interval: 0, raf: 0 };
let countersInstalled = false;

export function installWakeCounters() {
  if (countersInstalled) return;
  countersInstalled = true;
  const st = window.setTimeout.bind(window);
  const si = window.setInterval.bind(window);
  const raf = window.requestAnimationFrame.bind(window);
  const wrap = (fn: TimerHandler, kind: "timeout" | "interval") =>
    typeof fn === "function"
      ? (...a: unknown[]) => {
          wakeCounts[kind]++;
          return (fn as (...x: unknown[]) => unknown)(...a);
        }
      : fn;
  window.setTimeout = ((fn: TimerHandler, ms?: number, ...args: unknown[]) => st(wrap(fn, "timeout"), ms, ...args)) as typeof window.setTimeout;
  window.setInterval = ((fn: TimerHandler, ms?: number, ...args: unknown[]) => si(wrap(fn, "interval"), ms, ...args)) as typeof window.setInterval;
  window.requestAnimationFrame = (cb: FrameRequestCallback) => {
    if (rafCallers) {
      const at = (new Error().stack ?? "").split("\n").slice(1, 4).map((l) => l.trim().replace(/^.*\//, "")).join(" < ");
      rafCallers[at] = (rafCallers[at] ?? 0) + 1;
    }
    return raf((t) => {
      wakeCounts.raf++;
      cb(t);
    });
  };
}

/** While set, who asks for animation frames (benchmarks: finding what draws while idle). */
export let rafCallers: Record<string, number> | null = null;
export const traceRafCallers = (on: boolean) => {
  const out = rafCallers;
  rafCallers = on ? {} : null;
  return out;
};
