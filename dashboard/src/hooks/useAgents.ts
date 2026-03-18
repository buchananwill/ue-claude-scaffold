import { useCallback } from 'react';
import { apiFetch } from '../api/client';
import type { Agent } from '../api/types';
import { usePolling } from './usePolling';

export function useAgents(intervalMs: number) {
  const fetcher = useCallback(
    (signal: AbortSignal) => apiFetch<Agent[]>('/agents', signal),
    [],
  );
  return usePolling(fetcher, intervalMs);
}
