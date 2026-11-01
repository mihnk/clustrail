// React bindings for lib/query.ts.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Query, type QueryOptions, type QueryState } from "./query";

export interface QueryResult<T> extends QueryState<T> {
  /** Load again now (after a change the user made). */
  refresh: () => void;
}

/**
 * Data for key, loaded by fetch. key must name the request: method and
 * arguments (two views asking the same key share one request in flight).
 * null disables it. fetch may change every render; the one current when a
 * request starts is used.
 */
export function useQuery<T>(key: string | null, fetch: () => Promise<T>, opts?: QueryOptions): QueryResult<T> {
  const [q] = useState(() => new Query<T>(opts));
  const fetchRef = useRef(fetch);
  useLayoutEffect(() => {
    fetchRef.current = fetch;
  });
  useEffect(() => {
    q.setKey(key, () => fetchRef.current());
    return () => q.stop();
  }, [q, key]);
  const state = useSyncExternalStore(q.subscribe, q.getSnapshot);
  const refresh = useCallback(() => q.refresh(), [q]);
  // Until the effect has run for a new key, the state is the old key's: never show it as this key's.
  if (state.key !== key) {
    const keep = opts?.keepPrevious && state.data !== undefined;
    return { key, data: keep ? state.data : undefined, stale: !!keep, error: null, loading: key !== null, updatedAt: keep ? state.updatedAt : 0, refresh };
  }
  return { ...state, refresh };
}

/**
 * One query per id (one per cluster, say), each with its own state. entries
 * pairs each id with its request key; a new key for an id reloads it (the
 * previous data stays, marked stale, with keepPrevious). Ids that leave the
 * list are stopped and dropped. While active is false every query is
 * stopped but keeps its data, so a tab coming back shows it while reloading.
 */
export function useQueries<T>(entries: [id: string, key: string][], fetch: (id: string) => Promise<T>, opts?: QueryOptions, active = true): { states: Record<string, QueryState<T>>; refresh: () => void } {
  const [queries] = useState(() => new Map<string, Query<T>>());
  const [optsOnce] = useState(opts);
  const fetchRef = useRef(fetch);
  useLayoutEffect(() => {
    fetchRef.current = fetch;
  });
  const [version, setVersion] = useState(0);
  const entriesKey = entries.map(([id, key]) => `${id}\t${key}`).join("\n");

  useEffect(() => {
    const list = parseEntries(entriesKey);
    const bump = () => setVersion((v) => v + 1);
    const offs: (() => void)[] = [];
    for (const [id, key] of list) {
      let q = queries.get(id);
      if (!q) {
        q = new Query<T>(optsOnce);
        queries.set(id, q);
      }
      offs.push(q.subscribe(bump));
      if (active) q.setKey(key, () => fetchRef.current(id));
      else q.stop();
    }
    const ids = new Set(list.map(([id]) => id));
    for (const [id, q] of queries) {
      if (!ids.has(id)) {
        q.stop();
        queries.delete(id);
      }
    }
    bump();
    return () => {
      for (const off of offs) off();
      for (const q of queries.values()) q.stop();
    };
  }, [queries, optsOnce, entriesKey, active]);

  const states = useMemo(() => {
    void version; // recomputed when any query changes
    const out: Record<string, QueryState<T>> = {};
    for (const [id, key] of parseEntries(entriesKey)) {
      const s = queries.get(id)?.getSnapshot();
      const keep = !!optsOnce?.keepPrevious && s?.data !== undefined;
      if (s && !active) out[id] = s;
      else out[id] = s && s.key === key ? s : { key, data: keep ? s!.data : undefined, stale: keep, error: null, loading: active, updatedAt: keep ? s!.updatedAt : 0 };
    }
    return out;
  }, [queries, optsOnce, entriesKey, version, active]);
  const refresh = useCallback(() => {
    for (const q of queries.values()) q.refresh();
  }, [queries]);
  return { states, refresh };
}

function parseEntries(s: string): [string, string][] {
  return s ? s.split("\n").map((line) => line.split("\t") as [string, string]) : [];
}
