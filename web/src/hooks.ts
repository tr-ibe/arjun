import { useCallback, useEffect, useRef, useState } from "react";

// Loads data now and again every `ms` while the page is visible. Returns the latest value.
export function usePolling<T>(load: () => Promise<T>, ms: number, deps: unknown[] = []): T | null {
  const [data, setData] = useState<T | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let stopped = false;
    const tick = () => {
      if (document.hidden) return;
      loadRef
        .current()
        .then((d) => !stopped && setData(d))
        .catch(() => {});
    };
    tick();
    const timer = setInterval(tick, ms);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms, ...deps]);

  return data;
}

// Same, but also returns a function to reload right away (after an action).
export function useReloadable<T>(load: () => Promise<T>, ms: number | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;

  const reload = useCallback(() => {
    return loadRef
      .current()
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    setData(null);
    void reload();
    if (!ms) return;
    const timer = setInterval(() => !document.hidden && void reload(), ms);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms, reload, ...deps]);

  return { data, error, reload };
}
