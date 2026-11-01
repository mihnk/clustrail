import { describe, expect, it } from "vitest";
import type { JobEvent } from "@/backend/client";
import { jobResultToast, trackJob } from "./jobs";

const ev = (seq: number, p: Partial<JobEvent> = {}): JobEvent => ({ id: "drain-1", title: "Draining node-a", cluster: "prod", state: "running", progress: 0.5, detail: "", seq, started: 1, ...p });

describe("trackJob", () => {
  it("drops events older than the last one seen, and repeats", () => {
    const seen = new Map<string, number>();
    expect(trackJob(seen, ev(3))).toBe("progress");
    expect(trackJob(seen, ev(2))).toBe("stale"); // late
    expect(trackJob(seen, ev(3))).toBe("stale"); // duplicate
    expect(trackJob(seen, ev(5))).toBe("progress");
  });

  it("shows a result once, and nothing of the job after it", () => {
    const seen = new Map<string, number>();
    expect(trackJob(seen, ev(7, { state: "succeeded", done: true }))).toBe("result");
    expect(trackJob(seen, ev(7, { state: "succeeded", done: true }))).toBe("stale");
    expect(trackJob(seen, ev(6))).toBe("stale"); // a progress event that arrives after the result
    expect(trackJob(seen, ev(9))).toBe("stale");
  });

  it("keeps jobs apart", () => {
    const seen = new Map<string, number>();
    expect(trackJob(seen, ev(4, { state: "failed", done: true }))).toBe("result");
    expect(trackJob(seen, ev(2, { id: "helm-1" }))).toBe("progress");
  });
});

describe("jobResultToast", () => {
  it("never shows an unknown result as a success", () => {
    expect(jobResultToast(ev(1, { state: "succeeded", done: true, detail: "3 pods evicted" }))).toMatchObject({ kind: "success", title: "Drained node-a" });
    expect(jobResultToast(ev(1, { state: "failed", done: true, error: "timed out" }))).toMatchObject({ kind: "error", title: "Draining node-a failed", detail: "timed out" });
    expect(jobResultToast(ev(1, { state: "unknown", done: true, error: "connection closed" }))).toMatchObject({ kind: "error", title: "Draining node-a: result unknown" });
  });
});
