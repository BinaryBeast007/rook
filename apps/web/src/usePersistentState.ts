import { useEffect, useState } from "react";

/**
 * useState backed by localStorage. Storage can be unavailable (private mode,
 * blocked site data), so every access falls back to plain in-memory state.
 * Values are stored as JSON; `parse` validates the raw string and may throw.
 */
export function usePersistentState<T>(
  key: string,
  fallback: T,
  parse: (raw: string) => T | undefined,
) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : (parse(raw) ?? fallback);
    } catch {
      return fallback;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Keep working in memory.
    }
  }, [key, value]);

  return [value, setValue] as const;
}
