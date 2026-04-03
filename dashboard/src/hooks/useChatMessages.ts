import { useState, useRef, useCallback, useEffect } from 'react';
import type { ChatMessage } from '../api/types.ts';
import { useCursorPolling } from './useCursorPolling.ts';

const LIMIT = 50;

export function useChatMessages(roomId: string | null) {
  const [unreadCount, setUnreadCount] = useState(0);
  const lastReadIdRef = useRef(0);

  // Reset unread state when switching rooms
  useEffect(() => {
    setUnreadCount(0);
    lastReadIdRef.current = 0;
  }, [roomId]);

  const { items: messages, error, loading, hasOlder, loadingOlder, loadOlder } = useCursorPolling<ChatMessage>({
    buildUrl: (params) => {
      const base = `/rooms/${encodeURIComponent(roomId!)}`;
      if (params.before != null) {
        return `${base}/messages?before=${params.before}&limit=${params.limit}`;
      }
      if (params.since != null && params.since > 0) {
        return `${base}/messages?since=${params.since}`;
      }
      return `${base}/messages?limit=${params.limit}`;
    },
    deps: [roomId],
    limit: LIMIT,
    enabled: roomId != null,
    onInitialLoad: (items) => {
      lastReadIdRef.current = items[items.length - 1].id;
    },
    onPollAppend: (newItems) => {
      setUnreadCount((prev) => prev + newItems.filter((m) => m.id > lastReadIdRef.current).length);
    },
    transformOlder: (items) => [...items].reverse(),
  });

  const markRead = useCallback(() => {
    if (messages.length > 0) {
      lastReadIdRef.current = messages[messages.length - 1].id;
    }
    setUnreadCount(0);
  }, [messages]);

  return { messages, loading, error, hasOlder, loadingOlder, loadOlder, unreadCount, markRead };
}
