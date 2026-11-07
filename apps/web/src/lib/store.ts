import { useSyncExternalStore } from 'react';

/** A tiny observable value for state shared outside React's tree. */
export class Store<T> {
  private listeners = new Set<() => void>();
  constructor(private value: T) {}

  get = () => this.value;

  set(next: T | ((prev: T) => T)) {
    const v = typeof next === 'function' ? (next as (p: T) => T)(this.value) : next;
    if (Object.is(v, this.value)) return;
    this.value = v;
    for (const l of this.listeners) l();
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/** localStorage access that tolerates private mode, quota errors and corrupt data. */
export const storage = {
  read<T>(key: string, fallback: T): T {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : fallback;
    } catch {
      return fallback;
    }
  },
  write(key: string, value: unknown) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage unavailable: preferences last for this session only */
    }
  },
  remove(key: string) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};
