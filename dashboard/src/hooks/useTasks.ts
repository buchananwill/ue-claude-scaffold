import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { apiFetch } from '../api/client.ts';
import type { Task } from '../api/types.ts';
import { usePollInterval } from './usePollInterval.tsx';

export function useTasks(statusFilter?: string) {
  const { intervalMs } = usePollInterval();
  return useQuery({
    queryKey: ['tasks', statusFilter ?? ''],
    queryFn: ({ signal }) => {
      const params = statusFilter ? `?status=${statusFilter}` : '';
      return apiFetch<Task[]>(`/tasks${params}`, signal);
    },
    refetchInterval: intervalMs,
    staleTime: 2000,
    placeholderData: keepPreviousData,
  });
}
