import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../api/client.ts';
import type { Room } from '../api/types.ts';
import { usePollInterval } from './usePollInterval.tsx';

export function useRooms() {
  const { intervalMs } = usePollInterval();
  return useQuery<Room[]>({
    queryKey: ['rooms'],
    queryFn: ({ signal }) => apiFetch<Room[]>('/rooms', signal),
    refetchInterval: intervalMs,
    staleTime: 2000,
  });
}
