import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../api/client.ts';
import type { Task } from '../api/types.ts';
import { usePollInterval } from './usePollInterval.tsx';
import { useProject } from '../contexts/ProjectContext.tsx';

export function useTask(id: number) {
  const { intervalMs } = usePollInterval();
  const { projectId } = useProject();
  return useQuery({
    queryKey: ['task', id, projectId],
    queryFn: ({ signal }) => apiFetch<Task>('/tasks/' + id, signal, projectId),
    refetchInterval: intervalMs,
    staleTime: 2000,
    enabled: Number.isInteger(id) && id > 0,
  });
}
