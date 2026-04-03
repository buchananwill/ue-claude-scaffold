import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../api/client.ts';
import type { Agent } from '../api/types.ts';
import { usePollInterval } from './usePollInterval.tsx';
import { useProject } from '../contexts/ProjectContext.tsx';

export function useAgents() {
  const { intervalMs } = usePollInterval();
  const { projectId } = useProject();
  return useQuery({
    queryKey: ['agents', projectId],
    queryFn: ({ signal }) => apiFetch<Agent[]>('/agents', signal, projectId),
    refetchInterval: intervalMs,
    staleTime: 2000,
  });
}
