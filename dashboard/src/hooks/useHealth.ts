import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../api/client.ts';
import type { HealthResponse } from '../api/types.ts';
import { usePollInterval } from './usePollInterval.tsx';

export function useHealth() {
  const { intervalMs } = usePollInterval();
  return useQuery({
    queryKey: ['health'],
    queryFn: ({ signal }) => apiFetch<HealthResponse>('/health', signal),
    refetchInterval: intervalMs,
    staleTime: 2000,
  });
}
