import { useMemo } from "react";

/**
 * The same object for as long as its JSON is the same: for values rebuilt on
 * every render (a list mapped from props) that effects and memos depend on.
 */
export function useContentStable<T>(value: T): T {
  const key = JSON.stringify(value);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- the point: a new value only when its content (key) changes
  return useMemo(() => value, [key]);
}
