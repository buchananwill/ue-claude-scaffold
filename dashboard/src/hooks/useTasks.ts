import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { apiFetch } from '../api/client.ts';
import type { TasksPage } from '../api/types.ts';
import { usePollInterval } from './usePollInterval.tsx';
import { useProject } from '../contexts/ProjectContext.tsx';

export interface UseTasksParams {
  limit?: number;
  offset?: number;
  status?: string[];
  agent?: string[];
  priority?: number[];
  sort?: string;
  dir?: string;
}

export function useTasks(params?: UseTasksParams) {
  const { intervalMs } = usePollInterval();
  const { projectId } = useProject();
  const limit = params?.limit ?? 20;
  const offset = params?.offset ?? 0;
  const qs = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (params?.status && params.status.length > 0) qs.set('status', params.status.join(','));
  if (params?.agent && params.agent.length > 0) qs.set('agent', params.agent.join(','));
  if (params?.priority && params.priority.length > 0) qs.set('priority', params.priority.join(','));
  if (params?.sort) qs.set('sort', params.sort);
  if (params?.dir) qs.set('dir', params.dir);
  const path = `/tasks?${qs.toString()}`;

  const statusKey = params?.status?.join(',') ?? '';
  const agentKey = params?.agent?.join(',') ?? '';
  const priorityKey = params?.priority?.join(',') ?? '';
  const sortKey = params?.sort ?? '';
  const dirKey = params?.dir ?? '';

  return useQuery({
    queryKey: ['tasks', limit, offset, statusKey, agentKey, priorityKey, sortKey, dirKey, projectId],
    queryFn: ({ signal }) => {
      return apiFetch<TasksPage>(path, signal, projectId);
    },
    refetchInterval: intervalMs,
    staleTime: 2000,
    placeholderData: keepPreviousData,
  });
}
