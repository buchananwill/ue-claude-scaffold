import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../api/client.ts';
import type { TeamDetail } from '../api/types.ts';
import { usePollInterval } from './usePollInterval.tsx';

export function useTeamDetail(teamId: string | null) {
  const { intervalMs } = usePollInterval();
  return useQuery<TeamDetail>({
    queryKey: ['team', teamId],
    queryFn: ({ signal }) => apiFetch<TeamDetail>(`/teams/${encodeURIComponent(teamId!)}`, signal),
    refetchInterval: intervalMs,
    staleTime: 2000,
    enabled: !!teamId,
  });
}
