// Mock log streams for the checkout-api pods. In the desktop build the Go
// backend runs one follow stream per container (client-go GetLogs with
// Follow), interleaves them by timestamp and pushes batches to the UI.

export type LogLevel = "INFO" | "WARN" | "ERROR" | "";
export type SourceTag = "A" | "B" | "C" | "D";

export interface LogLine {
  /** Monotonic id: the line's position in the merged stream. */
  id: number;
  ts: string;
  tag: SourceTag;
  container: string;
  level: LogLevel;
  msg: string;
  /** Inline marker (restart, reconnect, stream end) instead of a log line. */
  event?: { health: "failed" | "progressing" | "unknown" };
}

export interface LogSource {
  tag: SourceTag;
  pod: string;
  containers: string[];
  /** live · reconnecting · ended · off */
  state: "live" | "reconnecting" | "ended" | "off";
  note?: string;
}

export const checkoutSources: LogSource[] = [
  { tag: "A", pod: "checkout-api-7d9f8b6c4-x2kqp", containers: ["api", "envoy"], state: "reconnecting", note: "restart 14" },
  { tag: "B", pod: "checkout-api-7d9f8b6c4-m8vtn", containers: ["api", "envoy"], state: "ended", note: "back-off 2m40s" },
  { tag: "C", pod: "checkout-api-7d9f8b6c4-9rkzd", containers: ["api", "envoy"], state: "live" },
  { tag: "D", pod: "checkout-api-7d9f8b6c4-h2pqs", containers: ["api", "envoy"], state: "off" },
];

const FIXED: [string, SourceTag, LogLevel, string][] = [
  ["11:58:40.913", "C", "INFO", "c.a.checkout.api.CheckoutController - POST /v1/checkout 200 84ms cart=3f1a…"],
  ["11:58:41.102", "A", "INFO", "c.a.checkout.api.CheckoutController - POST /v1/checkout 200 97ms cart=9b20…"],
  ["11:58:41.377", "B", "WARN", "c.zaxxer.hikari.pool.HikariPool - HikariPool-1 - Connection is not available, request timed out after 30000ms"],
  ["11:58:41.390", "B", "ERROR", "c.a.checkout.api.ErrorHandler - POST /v1/checkout 503 30012ms"],
  ["11:58:42.006", "C", "INFO", "c.a.checkout.pricing.PriceCache - refreshed 18,422 entries in 412ms (heap used 301 MB)"],
  ["11:58:42.551", "A", "INFO", "c.a.checkout.pricing.PriceCache - refreshed 18,422 entries in 498ms (heap used 338 MB)"],
  ["11:58:43.120", "A", "WARN", "c.a.checkout.runtime.GcMonitor - GC pause 1.8s (G1 Evacuation Pause), heap 361/384 MB"],
  ["11:58:44.804", "C", "INFO", "c.a.checkout.api.CheckoutController - POST /v1/checkout 200 71ms cart=c88e…"],
  ["11:58:46.231", "A", "WARN", "c.a.checkout.runtime.GcMonitor - GC pause 3.2s (G1 Full GC), heap 379/384 MB"],
  ["11:58:47.940", "A", "ERROR", 'o.a.c.c.C.[Tomcat].[localhost] - Exception in thread "http-nio-8080-exec-14" java.lang.OutOfMemoryError: Java heap space'],
  ["11:58:47.941", "A", "ERROR", "    at java.base/java.util.Arrays.copyOf(Arrays.java:3537)"],
  ["11:58:47.941", "A", "ERROR", "    at c.a.checkout.pricing.PriceCache.rebuild(PriceCache.java:214)"],
  ["11:58:47.942", "A", "ERROR", "    at c.a.checkout.pricing.PriceCache.refresh(PriceCache.java:131)"],
  ["11:59:02.000", "A", "", "EVENT:failed:Container api terminated · OOMKilled · exit 137 · 11:59:02"],
  ["11:59:03.410", "C", "INFO", "c.a.checkout.api.CheckoutController - POST /v1/checkout 200 92ms cart=71d2…"],
  ["11:59:05.006", "B", "INFO", "o.s.boot.SpringApplication - Starting CheckoutApplication v2.31.0 using Java 21.0.4"],
  ["11:59:05.118", "B", "INFO", "c.a.checkout.runtime.JvmInfo - -Xmx384m -XX:+UseG1GC, container memory limit 256 MiB"],
  ["11:59:11.882", "B", "INFO", "o.s.boot.SpringApplication - Started CheckoutApplication in 6.9 seconds"],
  ["11:59:12.004", "B", "INFO", "c.a.checkout.pricing.PriceCache - warming cache from pricing-svc …"],
  ["11:59:44.000", "A", "", "EVENT:progressing:Stream reconnected · new container instance (restart 14) · 11:59:44"],
  ["11:59:45.231", "A", "INFO", "o.s.boot.SpringApplication - Starting CheckoutApplication v2.31.0 using Java 21.0.4"],
  ["11:59:45.340", "A", "INFO", "c.a.checkout.runtime.JvmInfo - -Xmx384m -XX:+UseG1GC, container memory limit 256 MiB"],
  ["11:59:52.016", "A", "INFO", "o.s.boot.SpringApplication - Started CheckoutApplication in 6.8 seconds"],
  ["12:00:14.551", "B", "INFO", "c.a.checkout.pricing.PriceCache - refreshed 18,422 entries in 506ms (heap used 344 MB)"],
  ["12:00:16.903", "B", "WARN", "c.a.checkout.runtime.GcMonitor - GC pause 2.9s (G1 Full GC), heap 377/384 MB"],
  ["12:00:18.212", "B", "ERROR", "c.a.checkout.api.ErrorHandler - Unhandled java.lang.OutOfMemoryError: Java heap space"],
  ["12:00:19.000", "B", "", "EVENT:failed:Container api terminated · OOMKilled · exit 137 · 12:00:19 · stream ended"],
  ["12:00:21.774", "C", "INFO", "c.a.checkout.api.CheckoutController - POST /v1/checkout 200 88ms cart=0a4c…"],
  ["12:00:24.010", "C", "INFO", "c.a.checkout.pricing.PriceCache - refreshed 18,422 entries in 421ms (heap used 305 MB)"],
  ["12:00:31.627", "A", "INFO", "c.a.checkout.api.CheckoutController - POST /v1/checkout 200 103ms cart=e5b9…"],
  ["12:00:44.019", "C", "INFO", "c.a.checkout.api.HealthController - GET /readyz 200 2ms"],
  ["12:00:44.022", "A", "INFO", "c.a.checkout.api.HealthController - GET /readyz 200 3ms"],
  ["12:01:02.558", "A", "INFO", "c.a.checkout.pricing.PriceCache - refreshed 18,422 entries in 517ms (heap used 349 MB)"],
  ["12:01:09.330", "A", "WARN", "c.a.checkout.runtime.GcMonitor - GC pause 2.4s (G1 Evacuation Pause), heap 368/384 MB"],
  ["12:01:16.881", "C", "INFO", "c.a.checkout.api.CheckoutController - POST /v1/checkout 200 79ms cart=21ff…"],
];

const ROUTINE = [
  "c.a.checkout.api.CheckoutController - POST /v1/checkout 200 {ms}ms cart={id}…",
  "c.a.checkout.api.HealthController - GET /readyz 200 {ms2}ms",
  "c.a.checkout.pricing.PriceCache - refreshed 18,422 entries in {ms3}ms (heap used {heap} MB)",
  "c.a.checkout.api.CartController - GET /v1/cart/{id} 200 {ms}ms",
];

function fill(t: string, n: number) {
  return t
    .replace("{ms}", String(60 + (n % 50)))
    .replace("{ms2}", String(2 + (n % 3)))
    .replace("{ms3}", String(400 + (n % 120)))
    .replace("{heap}", String(290 + (n % 60)))
    .replace("{id}", (n * 2654435761).toString(16).slice(-4));
}

function toLine(id: number, [ts, tag, level, msg]: [string, SourceTag, LogLevel, string]): LogLine {
  if (msg.startsWith("EVENT:")) {
    const [, health, text] = msg.split(":", 3) as [string, "failed" | "progressing" | "unknown", string];
    return { id, ts, tag, container: "api", level: "", msg: msg.slice(`EVENT:${health}:`.length) || text, event: { health } };
  }
  return { id, ts, tag, container: "api", level, msg };
}

const clock = (sec: number) => {
  const h = Math.floor(sec / 3600) % 24;
  const m = Math.floor(sec / 60) % 60;
  const s = sec % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(Math.floor(s)).padStart(2, "0")}.${String(Math.floor((s % 1) * 1000)).padStart(3, "0")}`;
};

/** The buffer as it is when the tab opens: 15 minutes of routine traffic, then the incident. */
export function initialBuffer(size = 48210): LogLine[] {
  const lines: LogLine[] = [];
  const start = 11 * 3600 + 44 * 60 + 6; // 11:44:06
  const span = 14.5 * 60;
  const routine = size - FIXED.length;
  const tags: SourceTag[] = ["A", "B", "C"];
  for (let i = 0; i < routine; i++) {
    const t = start + (i / routine) * span;
    lines.push({
      id: i,
      ts: clock(t),
      tag: tags[i % 3]!,
      container: "api",
      level: i % 997 === 0 ? "WARN" : "INFO",
      msg: fill(ROUTINE[i % ROUTINE.length]!, i),
    });
  }
  FIXED.forEach((f, i) => lines.push(toLine(routine + i, f)));
  return lines;
}

/** Lines of the previous (terminated) instance, as `kubectl logs --previous` returns them. */
export function previousInstance(tag: SourceTag): LogLine[] {
  return FIXED.filter((f) => f[1] === tag && f[0] < "11:59:02" && !f[3].startsWith("EVENT"))
    .map((f, i) => toLine(i, f))
    .concat([{ id: 9999, ts: "11:59:02.000", tag, container: "api", level: "", msg: "Instance ended · OOMKilled · exit 137", event: { health: "failed" } }]);
}

/** New lines arriving from the live streams. */
export function nextLines(fromId: number, count: number, liveTags: SourceTag[], now: Date): LogLine[] {
  const base = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds() + now.getMilliseconds() / 1000;
  return Array.from({ length: count }, (_, i) => {
    const n = fromId + i;
    return {
      id: n,
      ts: clock(base + i * 0.05),
      tag: liveTags[n % liveTags.length]!,
      container: "api",
      level: n % 211 === 0 ? "WARN" : "INFO",
      msg: fill(ROUTINE[n % ROUTINE.length]!, n),
    };
  });
}

export const TAG_COLOR: Record<SourceTag, string> = {
  A: "#5BB8E8",
  B: "#D99CF0",
  C: "#E8C36D",
  D: "#9AA8B6",
};
