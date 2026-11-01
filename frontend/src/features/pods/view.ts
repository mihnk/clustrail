// The Pods table's rows from the pods (issue C1): filtered and sorted with
// memory across updates. A watch batch replaces a few row objects; the others
// keep their identity. The filter's answer is cached per row object, so only
// new or changed rows are tested again, and the sort merges the new rows into
// the previous order (sort.ts). A change of query or sort recomputes in full.
// The result always equals a full recompute (view.test.ts checks random
// sequences against one).
import type { SortingState } from "@tanstack/react-table";
import { isAttention } from "@/data/health";
import type { PodRow } from "@/data/types";
import { matchesFilter, matchesLabel, parseFilter } from "./filter";
import { podSorter, sortPods } from "./sort";

export type OwnerFilter = "any" | "ReplicaSet" | "StatefulSet" | "Job" | "none";
export type HealthFilter = "all" | "attention";

export interface PodQuery {
  text: string;
  namespaces: ReadonlySet<string> | null;
  owner: OwnerFilter;
  labels: readonly string[];
  health: HealthFilter;
}

export interface PodViewResult {
  /** Rows that match everything but the health segment (its counts stay meaningful). */
  base: PodRow[];
  /** Rows that match the whole query. */
  rows: PodRow[];
  /** base rows needing attention. */
  attention: number;
  /** rows, sorted. */
  sorted: PodRow[];
}

function predicate(q: PodQuery): (p: PodRow) => boolean {
  const f = parseFilter(q.text);
  return (p) =>
    (q.namespaces === null || q.namespaces.has(p.namespace)) &&
    (q.owner === "any" || (q.owner === "none" ? p.owner === null : p.owner?.kind === q.owner)) &&
    q.labels.every((l) => matchesLabel(p.labels, l)) &&
    matchesFilter(p, f);
}

function queryKey(q: PodQuery): string {
  return JSON.stringify([q.text, q.namespaces === null ? null : [...q.namespaces].sort(), q.owner, q.labels]);
}

/** The view as a full recompute: the reference the incremental one must equal. */
export function computePodView(pods: readonly PodRow[], q: PodQuery, sorting: SortingState): PodViewResult {
  const test = predicate(q);
  const base = pods.filter(test);
  const attention = base.filter((p) => isAttention(p.health)).length;
  const rows = q.health === "attention" ? base.filter((p) => isAttention(p.health)) : base;
  return { base, rows, attention, sorted: sortPods(rows, sorting) };
}

/** A view with memory; one per table. */
export function podView(): (pods: readonly PodRow[], q: PodQuery, sorting: SortingState) => PodViewResult {
  let key: string | null = null;
  let test: (p: PodRow) => boolean = () => true;
  let matches = new WeakMap<PodRow, boolean>();
  const sorter = podSorter();
  return (pods, q, sorting) => {
    const k = queryKey(q);
    if (k !== key) {
      key = k;
      test = predicate(q);
      matches = new WeakMap();
    }
    const base: PodRow[] = [];
    let attention = 0;
    for (const p of pods) {
      let ok = matches.get(p);
      if (ok === undefined) {
        ok = test(p);
        matches.set(p, ok);
      }
      if (ok) {
        base.push(p);
        if (isAttention(p.health)) attention++;
      }
    }
    const rows = q.health === "attention" ? base.filter((p) => isAttention(p.health)) : base;
    return { base, rows, attention, sorted: sorter(rows, sorting) };
  };
}
