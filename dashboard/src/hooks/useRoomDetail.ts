import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../api/client.ts';
import type { RoomDetail } from '../api/types.ts';
import { usePollInterval } from './usePollInterval.tsx';
import { useProject } from '../contexts/ProjectContext.tsx';

export function useRoomDetail(roomId: string | null) {
  const { intervalMs } = usePollInterval();
  const { projectId } = useProject();
  return useQuery<RoomDetail>({
    queryKey: ['room', roomId, projectId],
    queryFn: ({ signal }) => apiFetch<RoomDetail>(`/rooms/${encodeURIComponent(roomId!)}`, signal, projectId),
    refetchInterval: intervalMs,
    staleTime: 2000,
    enabled: !!roomId,
  });
}
