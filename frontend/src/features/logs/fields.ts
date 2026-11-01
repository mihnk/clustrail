import type { LogLine } from "@/data/logs";

// Structured logs: lines that are a JSON object are split into fields
// (nested objects flattened to dotted keys), counted, and filtered on.

export type Fields = Record<string, string>;

const parsed = new WeakMap<LogLine, Fields | null>();

/** The line's fields, or null when it is not a JSON object. Parsed once per line. */
export function lineFields(l: LogLine): Fields | null {
  const hit = parsed.get(l);
  if (hit !== undefined) return hit;
  let out: Fields | null = null;
  const s = l.msg.trimStart();
  if (s.startsWith("{")) {
    try {
      const v: unknown = JSON.parse(s);
      if (v && typeof v === "object" && !Array.isArray(v)) {
        out = {};
        flatten(v as Record<string, unknown>, "", out, 0);
      }
    } catch {
      out = null;
    }
  }
  parsed.set(l, out);
  return out;
}

function flatten(o: Record<string, unknown>, prefix: string, out: Fields, depth: number) {
  for (const [k, v] of Object.entries(o)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v) && depth < 4) flatten(v as Record<string, unknown>, key, out, depth + 1);
    else out[key] = typeof v === "string" ? v : JSON.stringify(v);
  }
}

export interface FieldStat {
  name: string;
  /** Share of the JSON lines that have the field, 0–1. */
  share: number;
}

/** Fields seen in the newest `sample` lines, most common first. */
export function fieldStats(lines: LogLine[], sample = 5000): { stats: FieldStat[]; json: number; seen: number } {
  const counts = new Map<string, number>();
  let json = 0;
  const from = Math.max(0, lines.length - sample);
  for (let i = from; i < lines.length; i++) {
    const f = lineFields(lines[i]!);
    if (!f) continue;
    json++;
    for (const k of Object.keys(f)) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const stats = [...counts].map(([name, n]) => ({ name, share: json ? n / json : 0 }));
  stats.sort((a, b) => b.share - a.share || a.name.localeCompare(b.name));
  return { stats, json, seen: lines.length - from };
}

export interface FieldFilter {
  key: string;
  value: string;
}

/** Whether the line's fields hold every filter's value (a line without fields never matches). */
export function matchesFieldFilters(l: LogLine, filters: FieldFilter[]): boolean {
  if (!filters.length) return true;
  const f = lineFields(l);
  return !!f && filters.every((x) => f[x.key] === x.value);
}

// Keys that name a request across services, in the order they are looked for.
export const TRACE_KEYS = ["trace_id", "traceId", "traceID", "trace.id", "otelTraceID", "dd.trace_id", "request_id", "requestId", "x_request_id"];

/** The line's trace (or request) id, if it has one. */
export function traceOf(f: Fields | null): FieldFilter | null {
  if (!f) return null;
  for (const key of TRACE_KEYS) if (f[key]) return { key, value: f[key]! };
  return null;
}

// Fields already shown in their own place (time, level, message) or rarely useful as a column.
const NOT_COLUMNS = new Set(["time", "ts", "timestamp", "@timestamp", "level", "lvl", "severity", "msg", "message", "caller", "logger"]);

/** Columns to start with: a trace id if there is one, then the most common fields, up to `max`. */
export function defaultColumns(stats: FieldStat[], max = 3): string[] {
  const usable = stats.filter((s) => !NOT_COLUMNS.has(s.name) && s.share >= 0.2);
  const trace = usable.find((s) => TRACE_KEYS.includes(s.name));
  const rest = usable.filter((s) => s !== trace).map((s) => s.name);
  return [...(trace ? [trace.name] : []), ...rest].slice(0, max);
}

/** The message of a JSON line (msg or message), else the raw text. */
export function messageOf(l: LogLine): string {
  const f = lineFields(l);
  return f?.msg ?? f?.message ?? l.msg;
}
