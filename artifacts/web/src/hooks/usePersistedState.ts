import { useState } from "react";

export function usePersistedState<T>(
  key: string,
  defaultValue: T,
  validate?: (value: unknown) => value is T
): [T, (value: T | ((prev: T) => T)) => void, (freshValue?: T) => void] {
  const [state, setState] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(key);
      if (stored !== null) {
        const parsed: unknown = JSON.parse(stored);
        if (validate === undefined || validate(parsed)) {
          return parsed as T;
        }
      }
    } catch {
      // ignore parse errors
    }
    return defaultValue;
  });

  const setPersistedState = (value: T | ((prev: T) => T)) => {
    setState(prev => {
      const next = typeof value === "function" ? (value as (prev: T) => T)(prev) : value;
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // ignore storage errors
      }
      return next;
    });
  };

  const clearPersistedState = (freshValue?: T) => {
    try {
      localStorage.removeItem(key);
    } catch {
      // ignore storage errors
    }
    setState(freshValue !== undefined ? freshValue : defaultValue);
  };

  return [state, setPersistedState, clearPersistedState];
}
