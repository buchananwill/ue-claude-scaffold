import { useQuery } from '@tanstack/react-query';
import { apiFetch, ApiError } from '../api/client.ts';
import type { Agent } from '../api/types.ts';
import { usePollInterval } from './usePollInterval.tsx';

export function useAgent(name: string) {
  const { intervalMs } = usePollInterval();
  return useQuery({
    queryKey: ['agent', name],
    queryFn: ({ signal }) => apiFetch<Agent>('/agents/' + encodeURIComponent(name), signal),
    refetchInterval: (query) => {
      if (query.state.error instanceof ApiError && query.state.error.status === 404) return false;
      return intervalMs;
    },
    retry: (failureCount, error) => {
      if (error instanceof ApiError && error.status === 404) return false;
      return failureCount < 3;
    },
    staleTime: 2000,
    enabled: !!name,
  });
}
