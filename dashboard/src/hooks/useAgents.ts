import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../api/client.ts';
import type { Agent } from '../api/types.ts';
import { usePollInterval } from './usePollInterval.tsx';

export function useAgents() {
  const { intervalMs } = usePollInterval();
  return useQuery({
    queryKey: ['agents'],
    queryFn: ({ signal }) => apiFetch<Agent[]>('/agents', signal),
    refetchInterval: intervalMs,
    staleTime: 2000,
  });
}
