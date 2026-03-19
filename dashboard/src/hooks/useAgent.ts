import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../api/client.ts';
import type { Agent } from '../api/types.ts';
import { usePollInterval } from './usePollInterval.tsx';

export function useAgent(name: string) {
  const { intervalMs } = usePollInterval();
  return useQuery({
    queryKey: ['agent', name],
    queryFn: ({ signal }) => apiFetch<Agent>('/agents/' + encodeURIComponent(name), signal),
    refetchInterval: intervalMs,
    staleTime: 2000,
    enabled: !!name,
  });
}
