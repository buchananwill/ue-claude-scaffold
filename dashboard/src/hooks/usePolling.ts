import { useState, useEffect, useCallback } from 'react';

export interface UsePollingResult<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  lastUpdated: Date | null;
  refresh: () => void;
}

export function usePolling<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  intervalMs: number,
): UsePollingResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    const ac = new AbortController();
    setLoading(true);

    const doFetch = () => {
      fetcher(ac.signal)
        .then((result) => {
          if (!ac.signal.aborted) {
            setData(result);
            setError(null);
            setLoading(false);
            setLastUpdated(new Date());
          }
        })
        .catch((err) => {
          if (!ac.signal.aborted) {
            setError(err instanceof Error ? err.message : String(err));
            setLoading(false);
          }
        });
    };

    doFetch();
    const id = setInterval(doFetch, intervalMs);
    return () => {
      ac.abort();
      clearInterval(id);
    };
  }, [fetcher, intervalMs, tick]);

  return { data, error, loading, lastUpdated, refresh };
}
