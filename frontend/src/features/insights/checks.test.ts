import { describe, expect, it } from "vitest";
import type { APIRemovalFinding, QuotaReport } from "@/backend/client";
import { minorOf, removalState } from "./ApiRemovalsWorkspace";
import { namespacesOf, ruleText } from "./QuotasWorkspace";

const f = (removed: string): APIRemovalFinding => ({ source: "helm", apiVersion: "x/v1beta1", kind: "X", removed });

describe("API removals", () => {
  it("reads minor versions", () => {
    expect(minorOf("1.25")).toBe(25);
    expect(minorOf("1.9")).toBe(9);
    expect(minorOf("")).toBe(0);
    expect(minorOf("2.0")).toBe(0);
  });

  it("places a finding against the cluster and the target", () => {
    // Cluster on 1.30 upgrading to 1.32.
    expect(removalState(f("1.26"), 30, 32)).toBe("gone");
    expect(removalState(f("1.30"), 30, 32)).toBe("gone");
    expect(removalState(f("1.31"), 30, 32)).toBe("target");
    expect(removalState(f("1.32"), 30, 32)).toBe("target");
    expect(removalState(f("1.33"), 30, 32)).toBe("later");
    expect(removalState(f(""), 30, 32)).toBe("unset");
    // Unknown server version: nothing is "already removed".
    expect(removalState(f("1.26"), 0, 32)).toBe("target");
  });
});

describe("quotas", () => {
  const report: QuotaReport = {
    cluster: "prod",
    notes: [],
    quotas: [
      { namespace: "a", name: "q1", scopes: [], items: [{ resource: "pods", used: "5", hard: "5", ratio: 1, full: true }] },
      { namespace: "a", name: "q2", scopes: [], items: [{ resource: "requests.cpu", used: "1", hard: "4", ratio: 0.25, full: false }] },
      { namespace: "b", name: "q", scopes: [], items: [{ resource: "services", used: "1", hard: "10", ratio: 0.1, full: false }] },
    ],
    limits: [{ namespace: "c", name: "l", items: [] }],
    rules: [{ namespace: "a", kind: "needs", resource: "requests.memory", quota: "q1" }],
  };

  it("groups quotas, limits and rules by namespace", () => {
    const spaces = namespacesOf([report]);
    const a = spaces.find((s) => s.namespace === "a")!;
    expect(a.quotas.map((q) => q.name)).toEqual(["q1", "q2"]);
    expect(a.full).toBe(1);
    expect(a.top).toBe(1);
    expect(a.rules).toHaveLength(1);
    expect(spaces.find((s) => s.namespace === "c")!.quotas).toEqual([]);
    expect(spaces.find((s) => s.namespace === "b")!.top).toBe(0.1);
  });

  it("states each rule", () => {
    expect(ruleText({ namespace: "a", kind: "needs", resource: "requests.memory", quota: "q1" })).toBe("Containers must set a memory request or limit: a pod without one is refused (quota q1).");
    expect(ruleText({ namespace: "a", kind: "needs", resource: "limits.cpu", quota: "q1" })).toBe("Containers must set a cpu limit: a pod without one is refused (quota q1).");
    expect(ruleText({ namespace: "a", kind: "defaults", resource: "requests.cpu", value: "100m" })).toBe("A container without a cpu request gets 100m (LimitRange).");
    expect(ruleText({ namespace: "a", kind: "defaults", resource: "limits.memory", value: "512Mi" })).toBe("A container without a memory limit gets 512Mi (LimitRange).");
  });
});
