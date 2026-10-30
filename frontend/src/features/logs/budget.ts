import { useEffect, useSyncExternalStore } from "react";
import { usePersistentState } from "@/app/preferences";

/** Rough memory of one buffered line (text, fields, row state), as Settings estimates it. */
export const LINE_BYTES = 260;

// Open log views share Settings › Total log memory.
const open = new Set<string>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

/**
 * Lines one log view may keep: its per-stream buffer, lowered so all open
 * log views together stay within the total log memory.
 */
export function useLogLineLimit(viewId: string, bufferLimit: number): number {
  const [totalMB] = usePersistentState("settings.logMemoryMB", 256);
  const views = useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => open.size,
  );
  useEffect(() => {
    open.add(viewId);
    notify();
    return () => {
      open.delete(viewId);
      notify();
    };
  }, [viewId]);
  const share = Math.floor((totalMB * 1048576) / Math.max(1, views) / LINE_BYTES);
  return Math.max(1000, Math.min(bufferLimit, share));
}
