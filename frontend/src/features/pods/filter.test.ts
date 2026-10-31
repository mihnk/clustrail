import { describe, expect, it } from "vitest";
import type { PodRow } from "@/data/types";
import { matchesFilter, matchesLabel, parseFilter } from "./filter";

const pod = (p: Partial<PodRow> = {}): PodRow =>
  ({
    id: "prod/payments/checkout-api-1", name: "checkout-api-1", namespace: "payments", cluster: "prod-eu-west-1", env: "prod", node: "node-a",
    health: "healthy", status: "Running", reason: "", readyContainers: 1, totalContainers: 1, restarts: 0, cpuMilli: null, memoryMiB: null,
    ageSeconds: 60, owner: null, labels: { app: "checkout", Tier: "Backend" },
    ...p,
  }) as PodRow;

const match = (text: string, p = pod()) => matchesFilter(p, parseFilter(text));

describe("parseFilter", () => {
  it("separates free words from key:value tokens and lowercases both", () => {
    const f = parseFilter("  Checkout NS:Payments  status:attention ");
    expect(f.words).toEqual(["checkout"]);
    expect(f.tokens.get("namespace")).toEqual(["payments"]);
    expect(f.tokens.get("status")).toEqual(["attention"]);
  });

  it("collects repeated keys and keeps unknown keys as words", () => {
    const f = parseFilter("ns:a namespace:b foo:bar label:");
    expect(f.tokens.get("namespace")).toEqual(["a", "b"]);
    expect(f.words).toEqual(["foo:bar", "label:"]);
  });
});

describe("matchesFilter", () => {
  it("matches everything when empty", () => {
    expect(match("")).toBe(true);
  });

  it("needs every free word somewhere in name, namespace, cluster, node or status", () => {
    expect(match("checkout prod")).toBe(true);
    expect(match("checkout staging")).toBe(false);
    expect(match("node-a running")).toBe(true);
  });

  it("ORs values of the same key and ANDs different keys", () => {
    expect(match("ns:billing ns:payments")).toBe(true);
    expect(match("ns:payments cluster:staging")).toBe(false);
  });

  it("status:attention follows health; other statuses match the start of the status or the reason", () => {
    expect(match("status:attention")).toBe(false);
    expect(match("status:attention", pod({ health: "failed" }))).toBe(true);
    expect(match("status:run")).toBe(true);
    expect(match("status:crashloop", pod({ status: "Waiting", reason: "CrashLoopBackOff" }))).toBe(true);
  });

  it("filters by label with or without a value", () => {
    expect(match("label:app")).toBe(true);
    expect(match("label:tier=backend")).toBe(true);
    expect(match("label:tier=frontend")).toBe(false);
  });
});

describe("matchesLabel", () => {
  it("compares keys and values case-insensitively and keeps '=' inside the value", () => {
    expect(matchesLabel({ Tier: "Backend" }, "tier=BACKEND")).toBe(true);
    expect(matchesLabel({ q: "a=b" }, "q=a=b")).toBe(false); // split("=", 2) drops what follows the second '='
    expect(matchesLabel({}, "app")).toBe(false);
  });
});
