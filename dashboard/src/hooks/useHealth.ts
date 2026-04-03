import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../api/client.ts';
import type { HealthResponse } from '../api/types.ts';
import { usePollInterval } from './usePollInterval.tsx';
import { useProject } from '../contexts/ProjectContext.tsx';

export function useHealth() {
  const { intervalMs } = usePollInterval();
  const { projectId } = useProject();
  return useQuery({
    queryKey: ['health', projectId],
    queryFn: ({ signal }) => apiFetch<HealthResponse>('/health', signal, projectId),
    refetchInterval: intervalMs,
    staleTime: 2000,
  });
}
