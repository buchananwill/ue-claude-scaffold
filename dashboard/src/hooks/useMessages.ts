import { useState, useEffect, useRef, useCallback } from 'react';
import { apiFetch } from '../api/client';
import type { Message } from '../api/types';

export function useMessages(channel: string, intervalMs: number) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const cursorRef = useRef(0);

  const reset = useCallback(() => {
    setMessages([]);
    cursorRef.current = 0;
    setLoading(true);
  }, []);

  useEffect(() => {
    // Reset when channel changes
    setMessages([]);
    cursorRef.current = 0;
    setLoading(true);

    const ac = new AbortController();

    const fetchNew = () => {
      const since = cursorRef.current;
      apiFetch<Message[]>(
        `/messages/${encodeURIComponent(channel)}?since=${since}`,
        ac.signal,
      )
        .then((newMsgs) => {
          if (ac.signal.aborted) return;
          if (newMsgs.length > 0) {
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
  }, [channel, intervalMs]);

  return { messages, error, loading, reset };
}
