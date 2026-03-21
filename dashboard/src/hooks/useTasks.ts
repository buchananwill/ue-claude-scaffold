import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { apiFetch } from '../api/client.ts';
import type { Task } from '../api/types.ts';
import { usePollInterval } from './usePollInterval.tsx';

export function useTasks() {
  const { intervalMs } = usePollInterval();
  return useQuery({
    queryKey: ['tasks'],
    queryFn: ({ signal }) => {
      return apiFetch<Task[]>('/tasks', signal);
    },
    refetchInterval: intervalMs,
    staleTime: 2000,
    placeholderData: keepPreviousData,
  });
}
