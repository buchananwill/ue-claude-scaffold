import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../api/client.ts';
import type { TeamDetail } from '../api/types.ts';
import { usePollInterval } from './usePollInterval.tsx';
import { useProject } from '../contexts/ProjectContext.tsx';

export function useTeamDetail(teamId: string | null) {
  const { intervalMs } = usePollInterval();
  const { projectId } = useProject();
  return useQuery<TeamDetail>({
    queryKey: ['team', teamId, projectId],
    queryFn: ({ signal }) => apiFetch<TeamDetail>(`/teams/${encodeURIComponent(teamId!)}`, signal, projectId),
    refetchInterval: intervalMs,
    staleTime: 2000,
    enabled: !!teamId,
  });
}
