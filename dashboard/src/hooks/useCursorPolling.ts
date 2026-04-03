import { useState, useEffect, useRef, useCallback } from 'react';
import { apiFetch } from '../api/client.ts';
import { usePollInterval } from './usePollInterval.tsx';
import { useProject } from '../contexts/ProjectContext.tsx';
import { toErrorMessage } from '../utils/toErrorMessage.ts';

interface CursorPollingOptions<T extends { id: number }> {
  /** Build the URL for initial load (with limit) and polling (with since). */
  buildUrl: (params: { since?: number; limit: number; before?: number }) => string;
  /** Dependencies that trigger a full reset when changed. */
  deps: unknown[];
  /** Number of items per page. */
  limit: number;
  /** Whether polling is enabled. If false, no fetching occurs. */
  enabled?: boolean;
  /** Called on initial load with raw fetched items; return value replaces items. Default: identity. */
  onInitialLoad?: (items: T[]) => void;
  /** Called on poll append with new items. Default: append to end. */
  onPollAppend?: (newItems: T[]) => void;
  /** Transform older items before prepending. Default: identity. */
  transformOlder?: (items: T[]) => T[];
}

interface CursorPollingResult<T> {
  items: T[];
  error: string | null;
  loading: boolean;
  hasOlder: boolean;
  loadingOlder: boolean;
  loadOlder: () => void;
}

export function useCursorPolling<T extends { id: number }>(
  options: CursorPollingOptions<T>,
): CursorPollingResult<T> {
  const { buildUrl, deps, limit, enabled = true, onInitialLoad, onPollAppend, transformOlder } = options;
  const { intervalMs } = usePollInterval();
  const { projectId } = useProject();
  const [items, setItems] = useState<T[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const cursorRef = useRef(0);
  const oldestIdRef = useRef<number | null>(null);

  // Store callbacks in refs to avoid re-triggering the effect
  const onInitialLoadRef = useRef(onInitialLoad);
  onInitialLoadRef.current = onInitialLoad;
  const onPollAppendRef = useRef(onPollAppend);
  onPollAppendRef.current = onPollAppend;
  const buildUrlRef = useRef(buildUrl);
  buildUrlRef.current = buildUrl;

  useEffect(() => {
    if (!enabled) {
      setItems([]);
      setLoading(false);
      return;
    }

    setItems([]);
    cursorRef.current = 0;
    oldestIdRef.current = null;
    setHasOlder(false);
    setLoading(true);

    const ac = new AbortController();

    const fetchNew = () => {
      const since = cursorRef.current;
      const url = since > 0
        ? buildUrlRef.current({ since, limit })
        : buildUrlRef.current({ limit });

      apiFetch<T[]>(url, ac.signal, projectId)
        .then((newItems) => {
          if (ac.signal.aborted) return;
          if (since === 0 && cursorRef.current === 0) {
            // Initial load
            if (newItems.length > 0) {
              setItems(newItems);
              cursorRef.current = newItems[newItems.length - 1].id;
              oldestIdRef.current = newItems[0].id;
              setHasOlder(newItems.length === limit);
              onInitialLoadRef.current?.(newItems);
            }
          } else if (newItems.length > 0) {
            // Polling append
            setItems((prev) => [...prev, ...newItems]);
            cursorRef.current = newItems[newItems.length - 1].id;
            onPollAppendRef.current?.(newItems);
          }
          setError(null);
          setLoading(false);
        })
        .catch((err) => {
          if (!ac.signal.aborted) {
            setError(toErrorMessage(err));
            setLoading(false);
          }
        });
    };

    fetchNew();
    const id = setInterval(fetchNew, intervalMs);
    return () => {
      ac.abort();
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, intervalMs, projectId, limit, ...deps]);

  const loadOlder = useCallback(() => {
    const oldest = oldestIdRef.current;
    if (oldest === null || loadingOlder || !enabled) return;

    setLoadingOlder(true);
    const url = buildUrlRef.current({ before: oldest, limit });

    apiFetch<T[]>(url, undefined, projectId)
      .then((olderItems) => {
        const transformed = transformOlder ? transformOlder(olderItems) : olderItems;
        if (transformed.length > 0) {
          setItems((prev) => [...transformed, ...prev]);
          oldestIdRef.current = transformed[0].id;
          setHasOlder(transformed.length === limit);
        } else {
          setHasOlder(false);
        }
        setLoadingOlder(false);
      })
      .catch((err) => {
        setError(toErrorMessage(err));
        setLoadingOlder(false);
      });
  }, [loadingOlder, enabled, projectId, limit, transformOlder]);

  return { items, error, loading, hasOlder, loadingOlder, loadOlder };
}
