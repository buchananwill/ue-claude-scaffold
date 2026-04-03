import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../api/client.ts';
import type { Team } from '../api/types.ts';
import { usePollInterval } from './usePollInterval.tsx';
import { useProject } from '../contexts/ProjectContext.tsx';

export function useTeams() {
  const { intervalMs } = usePollInterval();
  const { projectId } = useProject();
  return useQuery<Team[]>({
    queryKey: ['teams', projectId],
    queryFn: ({ signal }) => apiFetch<Team[]>('/teams', signal, projectId),
    refetchInterval: intervalMs,
    staleTime: 2000,
  });
}
