import type { SortingState } from "@tanstack/react-table";
import { healthRank, isAttention } from "@/data/health";
import type { PodRow } from "@/data/types";

// Pods are sorted here instead of by TanStack (manualSorting): one key per
// row computed up front, then plain comparisons. TanStack's row model called
// an accessor per comparison and the status order used localeCompare; with
// 10,000+ rows and a re-sort on every watch batch that dominated the profile.

type Key = number | string;

const keyOf: Record<string, (p: PodRow) => Key> = {
  name: (p) => p.name,
  namespace: (p) => p.namespace,
  cluster: (p) => p.cluster,
  node: (p) => p.node,
  ready: (p) => p.readyContainers / Math.max(1, p.totalContainers),
  restarts: (p) => p.restarts,
  cpu: (p) => p.cpuMilli ?? -1,
  memory: (p) => p.memoryMiB ?? -1,
  age: (p) => p.ageSeconds,
};

const cmp = (a: Key, b: Key) => (a < b ? -1 : a > b ? 1 : 0);

/** Returns a sorted copy; ties fall back to name, then id, so the order is stable across updates. */
export function sortPods(rows: PodRow[], sorting: SortingState): PodRow[] {
  const s = sorting[0];
  if (!s) return rows;
  const dir = s.desc ? -1 : 1;
  const n = rows.length;
  const idx = new Uint32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  if (s.id === "status") {
    // Attention first; among pods needing attention the most restarts lead; then name.
    const rank = new Float64Array(n);
    const restarts = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const p = rows[i]!;
      rank[i] = healthRank[p.health];
      restarts[i] = isAttention(p.health) ? -p.restarts : 0;
    }
    idx.sort((a, b) => dir * (rank[a]! - rank[b]! || restarts[a]! - restarts[b]!) || cmp(rows[a]!.name, rows[b]!.name) || cmp(rows[a]!.id, rows[b]!.id));
  } else {
    const get = keyOf[s.id];
    if (!get) return rows;
    const keys = new Array<Key>(n);
    for (let i = 0; i < n; i++) keys[i] = get(rows[i]!);
    idx.sort((a, b) => dir * cmp(keys[a]!, keys[b]!) || cmp(rows[a]!.name, rows[b]!.name) || cmp(rows[a]!.id, rows[b]!.id));
  }
  const out = new Array<PodRow>(n);
  for (let i = 0; i < n; i++) out[i] = rows[idx[i]!]!;
  return out;
}

function comparator(s: SortingState[number]): ((a: PodRow, b: PodRow) => number) | null {
  const dir = s.desc ? -1 : 1;
  const tie = (a: PodRow, b: PodRow) => cmp(a.name, b.name) || cmp(a.id, b.id);
  if (s.id === "status") {
    const restarts = (p: PodRow) => (isAttention(p.health) ? -p.restarts : 0);
    return (a, b) => dir * (healthRank[a.health] - healthRank[b.health] || restarts(a) - restarts(b)) || tie(a, b);
  }
  const get = keyOf[s.id];
  return get ? (a, b) => dir * cmp(get(a), get(b)) || tie(a, b) : null;
}

/**
 * sortPods with memory: when the sort is unchanged and few rows are new
 * objects (a watch batch), only those are sorted and merged into the previous
 * order: O(n) instead of O(n log n) string comparisons per batch. The order is
 * total (ties fall back to name, then id), so the result equals a full sort.
 */
export function podSorter(): (rows: PodRow[], sorting: SortingState) => PodRow[] {
  let spec = "";
  let prev: PodRow[] = [];
  let prevRows = new Set<PodRow>();
  return (rows, sorting) => {
    const s = sorting[0];
    const key = s ? `${s.id}:${s.desc}` : "";
    const current = new Set(rows);
    const compare = s ? comparator(s) : null;
    let out: PodRow[];
    const added = key === spec && compare ? rows.filter((p) => !prevRows.has(p)) : null;
    if (!compare || !added || added.length > rows.length / 8) {
      out = sortPods(rows, sorting);
    } else {
      added.sort(compare);
      out = new Array<PodRow>(rows.length);
      let i = 0;
      let j = 0;
      let k = 0;
      while (i < prev.length || j < added.length) {
        const a = prev[i];
        if (a !== undefined && !current.has(a)) {
          i++; // deleted, or replaced by a newer object of the same pod
          continue;
        }
        const b = added[j];
        if (a === undefined || (b !== undefined && compare(b, a) < 0)) {
          out[k++] = b!;
          j++;
        } else {
          out[k++] = a;
          i++;
        }
      }
    }
    spec = key;
    prev = out;
    prevRows = current;
    return out;
  };
}
