import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { apiFetch } from '../api/client.ts';
import type { BuildRecord } from '../api/types.ts';
import { usePollInterval } from './usePollInterval.tsx';
import { useProject } from '../contexts/ProjectContext.tsx';

export function useBuildHistory(agentFilter?: string, typeFilter?: string) {
  const { intervalMs } = usePollInterval();
  const { projectId } = useProject();

  return useQuery({
    queryKey: ['builds', agentFilter, typeFilter, projectId],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams();
      if (agentFilter) params.set('agent', agentFilter);
      if (typeFilter) params.set('type', typeFilter);
      const qs = params.toString();
      return apiFetch<BuildRecord[]>(`/builds${qs ? `?${qs}` : ''}`, signal, projectId);
    },
    refetchInterval: intervalMs,
    staleTime: 2000,
    placeholderData: keepPreviousData,
  });
}
