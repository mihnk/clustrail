// Pods live in an external store, not in the workspace context (issue C1).
// A pod frame used to replace the context's value, so every component that
// read the workspace (the sidebar, the tab strip, every open view) rendered
// again, whether it showed pods or not. Now components subscribe to what
// they show: the pods view to the rows, the sidebar to two counts, an
// inspector to one pod. Rows keep their identity while unchanged, so
// selections, memos and the table's cached rows stay valid.
import { useEffect, useRef, useState } from "react";
import type { PodRow } from "./types";

type Listener = () => void;

let rows: PodRow[] = [];
const listeners = new Set<Listener>();

export const podStore = {
  get: (): PodRow[] => rows,
  /** Replaces the rows (a value or an updater, like a state setter). */
  set(next: PodRow[] | ((cur: PodRow[]) => PodRow[])) {
    const value = typeof next === "function" ? next(rows) : next;
    if (value === rows) return;
    rows = value;
    for (const l of [...listeners]) l();
  },
  subscribe(l: Listener): () => void {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
};

/** Every pod of every cluster; re-renders on each change. */
export function useAllPods(): PodRow[] {
  return usePodSelector(identity);
}

const identity = (rows: PodRow[]) => rows;

/**
 * A value derived from the pods; the component re-renders only when it
 * changes by equal (Object.is by default): counts, one pod, a short list.
 * select may close over props; the latest one is used.
 *
 * Updates go through React state, not useSyncExternalStore: those always
 * render at the synchronous priority, which made the first load of 10,000
 * pods about 100 ms slower than batched state updates. A value is read
 * fresh on every render, so a render never shows rows older than the store.
 */
export function usePodSelector<T>(select: (rows: PodRow[]) => T, equal: (a: T, b: T) => boolean = Object.is): T {
  const latest = useRef(select);
  latest.current = select;
  const equalRef = useRef(equal);
  equalRef.current = equal;
  const [, bump] = useState(0);
  const cache = useRef<{ rows: PodRow[]; value: T } | null>(null);
  const read = (): T => {
    const cur = podStore.get();
    const c = cache.current;
    const value = latest.current(cur);
    if (c && equalRef.current(c.value, value)) {
      cache.current = { rows: cur, value: c.value };
      return c.value;
    }
    cache.current = { rows: cur, value };
    return value;
  };
  const value = read();
  useEffect(() => {
    const check = () => {
      const c = cache.current;
      const cur = podStore.get();
      if (c && c.rows === cur) return;
      const next = latest.current(cur);
      if (c && equalRef.current(c.value, next)) {
        cache.current = { rows: cur, value: c.value };
        return;
      }
      bump((n) => n + 1);
    };
    check(); // a change between render and subscribing
    return podStore.subscribe(check);
  }, []);
  return value;
}

/** Shallow equality of two plain objects (for selectors that return a few counts). */
export function shallowEqual<T extends object>(a: T, b: T): boolean {
  if (a === b) return true;
  const ka = Object.keys(a) as (keyof T)[];
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => Object.is(a[k], b[k]));
}

/** The same items in the same order (for selectors that return a filtered list). */
export function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}
