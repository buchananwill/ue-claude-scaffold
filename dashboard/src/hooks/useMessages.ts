import { useState, useEffect, useRef } from 'react';
import { apiFetch } from '../api/client.ts';
import type { Message } from '../api/types.ts';
import { usePollInterval } from './usePollInterval.tsx';

const MAX_MESSAGES = 1000;

export function useMessages(channel: string, typeFilter = '') {
  const { intervalMs } = usePollInterval();
  const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const cursorRef = useRef(0);

  useEffect(() => {
    setMessages([]);
    cursorRef.current = 0;
    setLoading(true);

    const ac = new AbortController();

    const fetchNew = () => {
      const since = cursorRef.current;
      apiFetch<Message[]>(
        `/messages/${encodeURIComponent(channel)}?since=${since}${typeFilter ? `&type=${encodeURIComponent(typeFilter)}` : ''}`,
        ac.signal,
      )
        .then((newMsgs) => {
          if (ac.signal.aborted) return;
          if (newMsgs.length > 0) {
            setMessages((prev) => {
              const combined = [...prev, ...newMsgs];
              if (combined.length > MAX_MESSAGES) {
                return combined.slice(combined.length - MAX_MESSAGES);
              }
              return combined;
            });
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
  }, [channel, intervalMs, typeFilter]);

  return { messages, error, loading };
}
