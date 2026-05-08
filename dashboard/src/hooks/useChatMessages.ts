import { useState, useRef, useCallback, useEffect, useLayoutEffect } from 'react';
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
      if (roomId == null) throw new Error('roomId is null');
      const base = `/rooms/${encodeURIComponent(roomId)}`;
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
      if (items.length > 0) {
        lastReadIdRef.current = items[items.length - 1].id;
      }
    },
    onPollAppend: (newItems) => {
      setUnreadCount((prev) => prev + newItems.filter((m) => m.id > lastReadIdRef.current).length);
    },
    transformOlder: (items) => [...items].reverse(),
  });

  // Mirror messages into a ref so markRead can stay identity-stable across
  // polls (empty deps) without going stale.
  const messagesRef = useRef(messages);
  useLayoutEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const markRead = useCallback(() => {
    const current = messagesRef.current;
    if (current.length > 0) {
      lastReadIdRef.current = current[current.length - 1].id;
    }
    setUnreadCount(0);
  }, []);

  return { messages, loading, error, hasOlder, loadingOlder, loadOlder, unreadCount, markRead };
}
