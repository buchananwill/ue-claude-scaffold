import { useState, useRef, useEffect } from 'react';
import { apiFetch } from '../api/client.ts';
import type { Message } from '../api/types.ts';
import { useProject } from '../contexts/ProjectContext.tsx';
import { useCursorPolling } from './useCursorPolling.ts';

const LIMIT = 20;

function buildMessageUrl(
  channel: string,
  typeFilter: string,
  agentFilter: string,
  params: { since?: number; limit: number; before?: number },
): string {
  const base = `/messages/${encodeURIComponent(channel)}`;
  const qs: string[] = [];
  if (params.before != null) {
    qs.push(`before=${params.before}`);
  } else if (params.since != null && params.since > 0) {
    qs.push(`since=${params.since}`);
  }
  if (params.before != null || (params.since == null || params.since === 0)) {
    qs.push(`limit=${params.limit}`);
  }
  if (typeFilter) qs.push(`type=${encodeURIComponent(typeFilter)}`);
  if (agentFilter) qs.push(`from_agent=${encodeURIComponent(agentFilter)}`);
  return qs.length > 0 ? `${base}?${qs.join('&')}` : base;
}

export function useMessages(channel: string, typeFilter = '', agentFilter = '') {
  const { projectId } = useProject();
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Reset totalCount when deps change
  useEffect(() => {
    setTotalCount(null);
    const ac = new AbortController();
    abortRef.current = ac;
    return () => { ac.abort(); };
  }, [channel, typeFilter, agentFilter, projectId]);

  const { items: messages, error, loading, hasOlder, loadingOlder, loadOlder } = useCursorPolling<Message>({
    buildUrl: (params) => buildMessageUrl(channel, typeFilter, agentFilter, params),
    deps: [channel, typeFilter, agentFilter],
    limit: LIMIT,
    onInitialLoad: () => {
      // Fetch total count on initial load
      const countQs: string[] = [];
      if (typeFilter) countQs.push(`type=${encodeURIComponent(typeFilter)}`);
      if (agentFilter) countQs.push(`from_agent=${encodeURIComponent(agentFilter)}`);
      const countUrl = `/messages/${encodeURIComponent(channel)}/count${countQs.length > 0 ? '?' + countQs.join('&') : ''}`;
      const signal = abortRef.current?.signal;
      apiFetch<{ count: number }>(countUrl, signal, projectId)
        .then((data) => {
          if (!signal?.aborted) setTotalCount(data.count);
        })
        .catch(() => {});
    },
  });

  return { messages, error, loading, hasOlder, loadingOlder, loadOlder, totalCount };
}
