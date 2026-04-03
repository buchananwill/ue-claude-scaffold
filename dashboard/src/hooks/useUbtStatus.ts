import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../api/client.ts';
import type { UbtStatus } from '../api/types.ts';
import { usePollInterval } from './usePollInterval.tsx';
import { useProject } from '../contexts/ProjectContext.tsx';

export function useUbtStatus() {
  const { intervalMs } = usePollInterval();
  const { projectId } = useProject();
  return useQuery({
    queryKey: ['ubt-status', projectId],
    queryFn: ({ signal }) => apiFetch<UbtStatus>('/ubt/status', signal, projectId),
    refetchInterval: intervalMs,
    staleTime: 2000,
  });
}
