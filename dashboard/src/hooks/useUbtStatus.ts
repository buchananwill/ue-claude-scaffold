import { useCallback } from 'react';
import { apiFetch } from '../api/client';
import type { UbtStatus } from '../api/types';
import { usePolling } from './usePolling';

export function useUbtStatus(intervalMs: number) {
  const fetcher = useCallback(
    (signal: AbortSignal) => apiFetch<UbtStatus>('/ubt/status', signal),
    [],
  );
  return usePolling(fetcher, intervalMs);
}
