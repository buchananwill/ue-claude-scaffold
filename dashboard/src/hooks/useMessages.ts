import { useState, useEffect, useRef, useCallback } from 'react';
import { apiFetch } from '../api/client.ts';
import type { Message } from '../api/types.ts';
import { usePollInterval } from './usePollInterval.tsx';
import { useProject } from '../contexts/ProjectContext.tsx';

const LIMIT = 20;

export function useMessages(channel: string, typeFilter = '', agentFilter = '') {
  const { intervalMs } = usePollInterval();
  const { projectId } = useProject();
  const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [totalCount, setTotalCount] = useState<number | null>(null);
  const cursorRef = useRef(0);
  const oldestIdRef = useRef<number | null>(null);

  useEffect(() => {
    setMessages([]);
    cursorRef.current = 0;
    oldestIdRef.current = null;
    setHasOlder(false);
    setLoading(true);
    setTotalCount(null);

    const ac = new AbortController();

    const fetchNew = () => {
      const since = cursorRef.current;
      let url: string;

      if (since > 0) {
        // Polling path: no limit
        url = `/messages/${encodeURIComponent(channel)}?since=${since}${typeFilter ? `&type=${encodeURIComponent(typeFilter)}` : ''}${agentFilter ? `&from_agent=${encodeURIComponent(agentFilter)}` : ''}`;
      } else {
        // Initial load: get most recent LIMIT
        url = `/messages/${encodeURIComponent(channel)}?limit=${LIMIT}${typeFilter ? `&type=${encodeURIComponent(typeFilter)}` : ''}${agentFilter ? `&from_agent=${encodeURIComponent(agentFilter)}` : ''}`;
      }

      const fetchCount = () => {
        const countUrl = `/messages/${encodeURIComponent(channel)}/count${typeFilter || agentFilter ? '?' : ''}${typeFilter ? `type=${encodeURIComponent(typeFilter)}` : ''}${typeFilter && agentFilter ? '&' : ''}${agentFilter ? `from_agent=${encodeURIComponent(agentFilter)}` : ''}`;
        apiFetch<{ count: number }>(countUrl, ac.signal, projectId)
          .then((data) => {
            if (!ac.signal.aborted) setTotalCount(data.count);
          })
          .catch(() => {});
      };

      apiFetch<Message[]>(url, ac.signal, projectId)
        .then((newMsgs) => {
          if (ac.signal.aborted) return;
          if (since === 0 && cursorRef.current === 0) {
            // Initial load
            fetchCount();
            if (newMsgs.length > 0) {
              setMessages(newMsgs);
              cursorRef.current = newMsgs[newMsgs.length - 1].id;
              oldestIdRef.current = newMsgs[0].id;
              setHasOlder(newMsgs.length === LIMIT);
            }
          } else if (newMsgs.length > 0) {
            // Polling append
            setMessages((prev) => [...prev, ...newMsgs]);
            cursorRef.current = newMsgs[newMsgs.length - 1].id;
          }
          setError(null);
          setLoading(false);
        })
        .catch((err) => {
          if (!ac.signal.aborted) {
            setError(err instanceof Error ? err.message : String(err));
            setLoading(false);
          }
        });
    };

    fetchNew();
    const id = setInterval(fetchNew, intervalMs);
    return () => {
      ac.abort();
      clearInterval(id);
    };
  }, [channel, intervalMs, typeFilter, agentFilter, projectId]);

  const loadOlder = useCallback(() => {
    const oldest = oldestIdRef.current;
    if (oldest === null || loadingOlder) return;

    setLoadingOlder(true);
    let url = `/messages/${encodeURIComponent(channel)}?before=${oldest}&limit=${LIMIT}`;
    if (typeFilter) {
      url += `&type=${encodeURIComponent(typeFilter)}`;
    }
    if (agentFilter) {
      url += `&from_agent=${encodeURIComponent(agentFilter)}`;
    }

    apiFetch<Message[]>(url, undefined, projectId)
      .then((olderMsgs) => {
        if (olderMsgs.length > 0) {
          setMessages((prev) => [...olderMsgs, ...prev]);
          oldestIdRef.current = olderMsgs[0].id;
          setHasOlder(olderMsgs.length === LIMIT);
        } else {
          setHasOlder(false);
        }
        setLoadingOlder(false);
      })
      .catch(() => {
        setLoadingOlder(false);
      });
  }, [channel, typeFilter, agentFilter, loadingOlder, projectId]);

  return { messages, error, loading, hasOlder, loadingOlder, loadOlder, totalCount };
}
