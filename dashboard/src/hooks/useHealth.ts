import { useCallback } from 'react';
import { apiFetch } from '../api/client';
import type { HealthResponse } from '../api/types';
import { usePolling } from './usePolling';

export function useHealth(intervalMs: number) {
  const fetcher = useCallback(
    (signal: AbortSignal) => apiFetch<HealthResponse>('/health', signal),
    [],
  );
  return usePolling(fetcher, intervalMs);
}
