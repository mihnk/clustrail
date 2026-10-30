import { useCallback, useSyncExternalStore } from "react";

// UI preferences persisted locally. These move to the Go settings service
// once it exists; until then localStorage keeps them across restarts.

export type Theme = "dark" | "light";
/** "system" follows prefers-color-scheme. */
export type ThemePreference = Theme | "system";
export type Density = "compact" | "default" | "comfortable";

export const ROW_HEIGHT: Record<Density, number> = { compact: 24, default: 28, comfortable: 34 };

/** Reads a persisted value outside React (initial state). */
export function readPreference<T>(key: string, fallback: T): T {
  return read(key, fallback);
}

/** Writes a persisted value outside React; hooks reading the key are not notified. */
export function writePreference(key: string, value: unknown): void {
  write(key, value);
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`clustrail.${key}`);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(`clustrail.${key}`, JSON.stringify(value));
  } catch {
    // Storage unavailable: keep the in-memory value.
  }
}

// One value per key, shared by every component that reads it: Settings
// changes reach the views using them without a reload.
const cache = new Map<string, unknown>();
const listeners = new Map<string, Set<() => void>>();

function subscribe(key: string, listener: () => void) {
  let set = listeners.get(key);
  if (!set) listeners.set(key, (set = new Set()));
  set.add(listener);
  return () => set.delete(listener);
}

export function usePersistentState<T>(key: string, fallback: T) {
  const value = useSyncExternalStore(
    useCallback((l: () => void) => subscribe(key, l), [key]),
    () => {
      if (!cache.has(key)) cache.set(key, read(key, fallback));
      return cache.get(key) as T;
    },
  );
  const set = useCallback(
    (next: T) => {
      cache.set(key, next);
      write(key, next);
      listeners.get(key)?.forEach((l) => l());
    },
    [key],
  );
  return [value, set] as const;
}

/** Live media query, e.g. "(prefers-color-scheme: dark)". */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    useCallback(
      (l: () => void) => {
        const mq = window.matchMedia(query);
        mq.addEventListener("change", l);
        return () => mq.removeEventListener("change", l);
      },
      [query],
    ),
    () => window.matchMedia(query).matches,
  );
}
