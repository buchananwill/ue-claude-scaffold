import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../api/client.ts';
import type { Room } from '../api/types.ts';
import { usePollInterval } from './usePollInterval.tsx';
import { useProject } from '../contexts/ProjectContext.tsx';

export function useRooms() {
  const { intervalMs } = usePollInterval();
  const { projectId } = useProject();
  return useQuery<Room[]>({
    queryKey: ['rooms', projectId],
    queryFn: ({ signal }) => apiFetch<Room[]>('/rooms', signal, projectId),
    refetchInterval: intervalMs,
    staleTime: 2000,
  });
}
