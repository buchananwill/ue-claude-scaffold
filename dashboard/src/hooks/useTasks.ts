import { useCallback } from 'react';
import { apiFetch } from '../api/client';
import type { Task } from '../api/types';
import { usePolling } from './usePolling';

export function useTasks(intervalMs: number, statusFilter?: string) {
  const fetcher = useCallback(
    (signal: AbortSignal) => {
      const params = statusFilter ? `?status=${statusFilter}` : '';
      return apiFetch<Task[]>(`/tasks${params}`, signal);
    },
    [statusFilter],
  );
  return usePolling(fetcher, intervalMs);
}
