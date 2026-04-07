import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../api/client.js';
import type { Agent } from '../api/types.js';
import { usePollInterval } from './usePollInterval.js';
import { useProject } from '../contexts/ProjectContext.js';

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
