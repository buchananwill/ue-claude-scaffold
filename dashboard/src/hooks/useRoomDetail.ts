import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../api/client.ts';
import type { RoomDetail } from '../api/types.ts';
import { usePollInterval } from './usePollInterval.tsx';

export function useRoomDetail(roomId: string | null) {
  const { intervalMs } = usePollInterval();
  return useQuery<RoomDetail>({
    queryKey: ['room', roomId],
    queryFn: ({ signal }) => apiFetch<RoomDetail>(`/rooms/${encodeURIComponent(roomId!)}`, signal),
    refetchInterval: intervalMs,
    staleTime: 2000,
    enabled: !!roomId,
  });
}
