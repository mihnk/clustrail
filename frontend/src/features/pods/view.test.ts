import { describe, expect, it } from "vitest";
import type { SortingState } from "@tanstack/react-table";
import type { Health, PodRow } from "@/data/types";
import { computePodView, podView, type PodQuery } from "./view";

// Property test (issue C1): random sequences of creates, updates, deletes,
// sort changes and filter changes. After every step the incremental view
// must equal a full recompute, row for row and in the same order.

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const HEALTH: Health[] = ["healthy", "healthy", "healthy", "failed", "warning", "progressing", "unknown"];
const NS = ["payments", "ledger", "search", "kube-system"];
const OWNERS: (PodRow["owner"])[] = [{ kind: "ReplicaSet", name: "api-1" }, { kind: "StatefulSet", name: "db" }, { kind: "Job", name: "batch" }, null];
const APPS = ["api", "web", "worker", "db"];
const SORTS: SortingState[] = [
  [{ id: "status", desc: false }],
  [{ id: "name", desc: false }],
  [{ id: "restarts", desc: true }],
  [{ id: "age", desc: false }],
  [{ id: "cpu", desc: true }],
  [],
];
const QUERIES: PodQuery[] = [
  { text: "", namespaces: null, owner: "any", labels: [], health: "all" },
  { text: "api", namespaces: null, owner: "any", labels: [], health: "all" },
  { text: "", namespaces: new Set(["payments", "ledger"]), owner: "any", labels: [], health: "attention" },
  { text: "status:attention", namespaces: null, owner: "ReplicaSet", labels: [], health: "all" },
  { text: "", namespaces: null, owner: "none", labels: ["app=web"], health: "all" },
  { text: "ns:search", namespaces: null, owner: "any", labels: [], health: "attention" },
];

function makePod(r: () => number, n: number): PodRow {
  const app = APPS[Math.floor(r() * APPS.length)]!;
  const ns = NS[Math.floor(r() * NS.length)]!;
  return {
    id: `c/${ns}/${app}-${n}`, name: `${app}-${n}`, namespace: ns, cluster: "c", env: "dev", node: `node-${n % 5}`,
    health: HEALTH[Math.floor(r() * HEALTH.length)]!, status: "Running", reason: "", readyContainers: 1, totalContainers: 1,
    restarts: Math.floor(r() * 5), cpuMilli: r() < 0.2 ? null : Math.floor(r() * 900), memoryMiB: 64, ageSeconds: Math.floor(r() * 10000),
    owner: OWNERS[Math.floor(r() * OWNERS.length)]!, labels: { app },
  } as PodRow;
}

const ids = (rows: PodRow[]) => rows.map((p) => p.id);

describe("podView", () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    it(`equals a full recompute through random changes (seed ${seed})`, () => {
      const r = rng(seed);
      let next = 0;
      let pods: PodRow[] = Array.from({ length: 300 }, () => makePod(r, next++));
      const view = podView();
      let query = QUERIES[0]!;
      let sorting = SORTS[0]!;
      for (let step = 0; step < 400; step++) {
        const op = r();
        if (op < 0.35) {
          // a watch batch: a few pods change; the rest keep their identity
          const k = 1 + Math.floor(r() * 8);
          pods = pods.slice();
          for (let i = 0; i < k && pods.length; i++) {
            const at = Math.floor(r() * pods.length);
            const p = pods[at]!;
            pods[at] = { ...p, health: HEALTH[Math.floor(r() * HEALTH.length)]!, restarts: p.restarts + 1, cpuMilli: Math.floor(r() * 900), labels: { app: APPS[Math.floor(r() * APPS.length)]! } };
          }
        } else if (op < 0.55) {
          pods = [...pods, ...Array.from({ length: 1 + Math.floor(r() * 5) }, () => makePod(r, next++))];
        } else if (op < 0.75) {
          pods = pods.filter(() => r() > 0.03);
        } else if (op < 0.87) {
          sorting = SORTS[Math.floor(r() * SORTS.length)]!;
        } else {
          query = QUERIES[Math.floor(r() * QUERIES.length)]!;
        }
        const got = view(pods, query, sorting);
        const want = computePodView(pods, query, sorting);
        expect(ids(got.sorted), `step ${step}`).toEqual(ids(want.sorted));
        expect(ids(got.base)).toEqual(ids(want.base));
        expect(got.attention).toBe(want.attention);
        // The same objects, not copies: unchanged rows keep their identity downstream.
        got.sorted.forEach((p, i) => expect(p).toBe(want.sorted[i]));
      }
    });
  }

  it("tests the filter only for rows that are new objects", () => {
    const r = rng(9);
    const pods = Array.from({ length: 1000 }, (_, i) => makePod(r, i));
    const view = podView();
    const q: PodQuery = { text: "api", namespaces: null, owner: "any", labels: [], health: "all" };
    view(pods, q, SORTS[0]!);
    // Count label lookups: the predicate reads p.labels once per test.
    let reads = 0;
    const watched = pods.map((p, i) =>
      i < 10
        ? Object.defineProperty({ ...p }, "labels", { get: () => (reads++, p.labels), enumerable: true })
        : p,
    );
    const q2: PodQuery = { ...q, labels: ["app=api"] };
    view(watched, q2, SORTS[0]!); // a new query: every row is tested
    const full = reads;
    reads = 0;
    view(watched, q2, SORTS[0]!); // same query, same objects: nothing is tested
    expect(full).toBeGreaterThan(0);
    expect(reads).toBe(0);
  });
});
