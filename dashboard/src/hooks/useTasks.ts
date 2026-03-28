import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { apiFetch } from '../api/client.ts';
import type { TasksPage } from '../api/types.ts';
import { usePollInterval } from './usePollInterval.tsx';

export function useTasks(params?: { limit?: number; offset?: number; status?: string }) {
  const { intervalMs } = usePollInterval();
  const limit = params?.limit ?? 20;
  const offset = params?.offset ?? 0;
  const qs = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (params?.status) qs.set('status', params.status);
  const path = `/tasks?${qs.toString()}`;

  return useQuery({
    queryKey: ['tasks', limit, offset, params?.status ?? ''],
    queryFn: ({ signal }) => {
      return apiFetch<TasksPage>(path, signal);
    },
    refetchInterval: intervalMs,
    staleTime: 2000,
    placeholderData: keepPreviousData,
  });
}
