import { useEffect, useRef, useState } from "react";

/**
 * value, updated at most every ms: for summaries of fast-changing data
 * (counts in a menu) that need not follow every frame.
 */
export function useThrottled<T>(value: T, ms: number): T {
  const [shown, setShown] = useState(value);
  const last = useRef(0);
  useEffect(() => {
    const wait = last.current + ms - Date.now();
    const show = () => {
      last.current = Date.now();
      setShown(value);
    };
    if (wait <= 0) {
      show();
      return;
    }
    const t = setTimeout(show, wait);
    return () => clearTimeout(t);
  }, [value, ms]);
  return shown;
}
