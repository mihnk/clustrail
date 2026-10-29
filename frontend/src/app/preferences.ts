import { useCallback, useState } from "react";

// UI preferences persisted locally. These move to the Go settings service
// once it exists; until then localStorage keeps them across restarts.

export type Theme = "dark" | "light";
export type Density = "compact" | "default" | "comfortable";

export const ROW_HEIGHT: Record<Density, number> = { compact: 24, default: 28, comfortable: 34 };

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

export function usePersistentState<T>(key: string, fallback: T) {
  const [value, setValue] = useState<T>(() => read(key, fallback));
  const set = useCallback(
    (next: T) => {
      setValue(next);
      write(key, next);
    },
    [key],
  );
  return [value, set] as const;
}
