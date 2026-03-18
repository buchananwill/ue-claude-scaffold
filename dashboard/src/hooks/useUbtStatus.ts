import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../api/client.ts';
import type { UbtStatus } from '../api/types.ts';
import { usePollInterval } from './usePollInterval.tsx';

export function useUbtStatus() {
  const { intervalMs } = usePollInterval();
  return useQuery({
    queryKey: ['ubt-status'],
    queryFn: ({ signal }) => apiFetch<UbtStatus>('/ubt/status', signal),
    refetchInterval: intervalMs,
    staleTime: 2000,
  });
}
