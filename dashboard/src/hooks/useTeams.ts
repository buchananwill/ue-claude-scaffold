import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../api/client.ts';
import type { Team } from '../api/types.ts';
import { usePollInterval } from './usePollInterval.tsx';

export function useTeams() {
  const { intervalMs } = usePollInterval();
  return useQuery<Team[]>({
    queryKey: ['teams'],
    queryFn: ({ signal }) => apiFetch<Team[]>('/teams', signal),
    refetchInterval: intervalMs,
    staleTime: 2000,
  });
}
