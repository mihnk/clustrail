import { describe, expect, it } from "vitest";
import type { LogLine } from "@/data/logs";
import { defaultColumns, fieldStats, lineFields, matchesFieldFilters, messageOf, traceOf } from "./fields";

let id = 0;
const line = (msg: string): LogLine => ({ id: id++, ts: "", tag: "A", container: "app", level: "INFO", msg });

describe("lineFields", () => {
  it("splits a JSON object into flat fields, nested keys dotted", () => {
    const f = lineFields(line('{"level":"error","msg":"declined","error":{"code":"card_declined","retry":false},"latency_ms":121,"tags":["a","b"]}'));
    expect(f).toEqual({ level: "error", msg: "declined", "error.code": "card_declined", "error.retry": "false", latency_ms: "121", tags: '["a","b"]' });
  });

  it("leaves text, arrays and broken JSON as text", () => {
    for (const msg of ["GET /healthz 200", "[1,2]", '{"broken":', "  "]) expect(lineFields(line(msg))).toBeNull();
  });

  it("parses each line once", () => {
    const l = line('{"a":"1"}');
    expect(lineFields(l)).toBe(lineFields(l));
  });
});

describe("fieldStats and defaultColumns", () => {
  const lines = [
    line('{"level":"info","msg":"ok","route":"/v1/charge","trace_id":"t1","user_id":"u1"}'),
    line('{"level":"error","msg":"declined","route":"/v1/charge","trace_id":"t2"}'),
    line("plain text"),
    line('{"level":"info","msg":"ok","route":"/v1/refund","trace_id":"t3","rare":"x"}'),
  ];
  it("counts fields over the JSON lines", () => {
    const { stats, json, seen } = fieldStats(lines);
    expect(json).toBe(3);
    expect(seen).toBe(4);
    expect(stats.find((s) => s.name === "route")!.share).toBe(1);
    expect(stats.find((s) => s.name === "user_id")!.share).toBeCloseTo(1 / 3);
  });
  it("starts with the trace id, then common fields, skipping level and message", () => {
    expect(defaultColumns(fieldStats(lines).stats)).toEqual(["trace_id", "route", "rare"]);
  });
});

describe("filters, traces, messages", () => {
  const l = line('{"msg":"declined","route":"/v1/charge","traceId":"abc"}');
  it("matches every filter on the fields", () => {
    expect(matchesFieldFilters(l, [{ key: "route", value: "/v1/charge" }])).toBe(true);
    expect(matchesFieldFilters(l, [{ key: "route", value: "/v1/charge" }, { key: "msg", value: "ok" }])).toBe(false);
    expect(matchesFieldFilters(line("text"), [{ key: "route", value: "/v1/charge" }])).toBe(false);
    expect(matchesFieldFilters(line("text"), [])).toBe(true);
  });
  it("finds the trace id under its usual names", () => {
    expect(traceOf(lineFields(l))).toEqual({ key: "traceId", value: "abc" });
    expect(traceOf(lineFields(line('{"msg":"x"}')))).toBeNull();
  });
  it("shows msg or message, else the raw text", () => {
    expect(messageOf(l)).toBe("declined");
    expect(messageOf(line('{"message":"hi"}'))).toBe("hi");
    expect(messageOf(line("plain"))).toBe("plain");
  });
});
