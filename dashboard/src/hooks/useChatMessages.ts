import { useState, useEffect, useRef, useCallback } from 'react';
import { apiFetch } from '../api/client.ts';
import type { ChatMessage } from '../api/types.ts';
import { usePollInterval } from './usePollInterval.tsx';
import { useProject } from '../contexts/ProjectContext.tsx';

const LIMIT = 50;

export function useChatMessages(roomId: string | null) {
  const { intervalMs } = usePollInterval();
  const { projectId } = useProject();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const cursorRef = useRef(0);
  const oldestIdRef = useRef<number | null>(null);
  const lastReadIdRef = useRef(0);

  useEffect(() => {
    if (!roomId) {
      setMessages([]);
      setLoading(false);
      return;
    }

    setMessages([]);
    cursorRef.current = 0;
    oldestIdRef.current = null;
    setHasOlder(false);
    setLoading(true);
    setUnreadCount(0);
    lastReadIdRef.current = 0;

    const ac = new AbortController();

    const fetchNew = () => {
      const since = cursorRef.current;
      let url: string;

      if (since > 0) {
        url = `/rooms/${encodeURIComponent(roomId)}/messages?since=${since}`;
      } else {
        url = `/rooms/${encodeURIComponent(roomId)}/messages?limit=${LIMIT}`;
      }

      apiFetch<ChatMessage[]>(url, ac.signal, projectId)
        .then((newMsgs) => {
          if (ac.signal.aborted) return;
          if (since === 0 && cursorRef.current === 0) {
            // Initial load
            if (newMsgs.length > 0) {
              setMessages(newMsgs);
              cursorRef.current = newMsgs[newMsgs.length - 1].id;
              oldestIdRef.current = newMsgs[0].id;
              setHasOlder(newMsgs.length === LIMIT);
              lastReadIdRef.current = newMsgs[newMsgs.length - 1].id;
            }
          } else if (newMsgs.length > 0) {
            // Polling append
            setMessages((prev) => [...prev, ...newMsgs]);
            cursorRef.current = newMsgs[newMsgs.length - 1].id;
            setUnreadCount((prev) => prev + newMsgs.filter((m) => m.id > lastReadIdRef.current).length);
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
  }, [roomId, intervalMs, projectId]);

  const loadOlder = useCallback(() => {
    const oldest = oldestIdRef.current;
    if (oldest === null || loadingOlder || !roomId) return;

    setLoadingOlder(true);
    const url = `/rooms/${encodeURIComponent(roomId)}/messages?before=${oldest}&limit=${LIMIT}`;

    apiFetch<ChatMessage[]>(url, undefined, projectId)
      .then((olderMsgs) => {
        // Server returns descending for before queries; reverse to ascending
        const sorted = [...olderMsgs].reverse();
        if (sorted.length > 0) {
          setMessages((prev) => [...sorted, ...prev]);
          oldestIdRef.current = sorted[0].id;
          setHasOlder(sorted.length === LIMIT);
        } else {
          setHasOlder(false);
        }
        setLoadingOlder(false);
      })
      .catch(() => {
        setLoadingOlder(false);
      });
  }, [roomId, loadingOlder, projectId]);

  const markRead = useCallback(() => {
    lastReadIdRef.current = cursorRef.current;
    setUnreadCount(0);
  }, []);

  return { messages, loading, error, hasOlder, loadingOlder, loadOlder, unreadCount, markRead };
}
