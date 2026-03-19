import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../api/client.ts';
import type { Task } from '../api/types.ts';
import { usePollInterval } from './usePollInterval.tsx';

export function useTask(id: number) {
  const { intervalMs } = usePollInterval();
  return useQuery({
    queryKey: ['task', id],
    queryFn: ({ signal }) => apiFetch<Task>('/tasks/' + id, signal),
    refetchInterval: intervalMs,
    staleTime: 2000,
    enabled: !isNaN(id),
  });
}
