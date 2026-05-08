import { useState, useEffect, useRef, useCallback, useLayoutEffect } from 'react';
import { ScrollArea, Box, Group, Text, TextInput, ActionIcon, Button, Transition, Stack } from '@mantine/core';
import { IconSend, IconArrowDown } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { apiPost } from '../api/client.ts';
import { toErrorMessage } from '../utils/toErrorMessage.ts';
import { useProject } from '../contexts/ProjectContext.tsx';
import { RelativeTime } from './RelativeTime.tsx';
import { MarkdownContent } from './MarkdownContent.tsx';
import { AgentMessageCard } from './AgentMessageCard.tsx';
import { useAutoScroll } from '../hooks/useAutoScroll.ts';
import { useAutoScrollPreference } from '../hooks/useAutoScrollPreference.tsx';
import {
  buildJumpToLatestLabel,
  shouldMarkReadOnAutoScrollTransition,
  shouldMarkReadOnNewMessage,
  shouldMountJumpToLatest,
} from './chatTimelineHelpers.ts';
import type { ChatMessage } from '../api/types.ts';

interface ChatTimelineProps {
  roomId: string;
  messages: ChatMessage[];
  loading: boolean;
  error: string | null;
  hasOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  onMarkRead: () => void;
  unreadCount: number;
}

export function ChatTimeline({
  roomId,
  messages,
  loading,
  error,
  hasOlder,
  loadingOlder,
  onLoadOlder,
  onMarkRead,
  unreadCount,
}: ChatTimelineProps) {
  const { projectId } = useProject();
  const { enabled: autoScrollEnabled } = useAutoScrollPreference();
  const [inputValue, setInputValue] = useState('');
  const { viewportRef, sentinelRef, showJumpToLatest, jumpToLatest, onNewContent } = useAutoScroll({
    enabled: autoScrollEnabled,
  });
  const lastMessageId = messages.length > 0 ? messages[messages.length - 1].id : null;
  const lastSeenIdRef = useRef<number | null>(null);

  // Mirror the latest onMarkRead into a ref so effects can call it without
  // taking it as a dependency (its identity is stable today, but the ref
  // makes that independence explicit for the `[roomId]` and
  // `[autoScrollEnabled]` effects below).
  const onMarkReadRef = useRef(onMarkRead);
  useLayoutEffect(() => {
    onMarkReadRef.current = onMarkRead;
  }, [onMarkRead]);

  // Reset unread count on room switch only — not on every poll-driven
  // identity change of onMarkRead.
  useEffect(() => {
    onMarkReadRef.current();
  }, [roomId]);

  useEffect(() => {
    if (lastMessageId !== null && lastMessageId !== lastSeenIdRef.current) {
      lastSeenIdRef.current = lastMessageId;
      onNewContent();
      if (shouldMarkReadOnNewMessage(autoScrollEnabled)) {
        onMarkReadRef.current();
      }
    }
  }, [lastMessageId, onNewContent, autoScrollEnabled]);

  // On a false → true transition of the global toggle, clear the unread
  // count. The useAutoScroll hook itself handles the scroll-to-sentinel.
  const prevAutoScrollEnabledRef = useRef(autoScrollEnabled);
  useEffect(() => {
    if (shouldMarkReadOnAutoScrollTransition(prevAutoScrollEnabledRef.current, autoScrollEnabled)) {
      onMarkReadRef.current();
    }
    prevAutoScrollEnabledRef.current = autoScrollEnabled;
  }, [autoScrollEnabled]);

  const handleJumpToLatest = useCallback(() => {
    jumpToLatest();
    onMarkReadRef.current();
  }, [jumpToLatest]);

  const handleSend = async () => {
    const content = inputValue.trim();
    if (!content) return;
    try {
      await apiPost(`/rooms/${encodeURIComponent(roomId)}/messages`, { content }, projectId);
      setInputValue('');
    } catch (err) {
      notifications.show({
        color: 'red',
        title: 'Send failed',
        message: toErrorMessage(err),
      });
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  return (
    <Box style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      {error && <Text c="red" size="sm" mb="xs">{error}</Text>}
      {loading && messages.length === 0 ? (
        <Text c="dimmed" ta="center">Loading...</Text>
      ) : (
        <>
          <Box pos="relative" style={{ flex: 1, minHeight: 0 }}>
            <ScrollArea style={{ flex: 1, minHeight: 0 }} viewportRef={viewportRef}>
              {hasOlder && (
                <Button variant="subtle" size="xs" onClick={onLoadOlder} loading={loadingOlder} mb="xs">
                  Load older
                </Button>
              )}
              <Stack gap="xs">
                {messages.map((msg) => (
                  <AgentMessageCard
                    key={msg.id}
                    agentName={msg.sender}
                    timestamp={<RelativeTime date={msg.createdAt} />}
                  >
                    {msg.replyTo != null && (
                      <Text size="xs" c="dimmed">reply to #{msg.replyTo}</Text>
                    )}
                    <MarkdownContent content={msg.content} />
                  </AgentMessageCard>
                ))}
              </Stack>
              <div ref={sentinelRef} />
            </ScrollArea>

            <Transition
              mounted={shouldMountJumpToLatest(showJumpToLatest, autoScrollEnabled, unreadCount)}
              transition="slide-up"
              duration={200}
            >
              {(styles) => (
                <Button
                  style={{ ...styles, position: 'absolute', bottom: 'var(--mantine-spacing-md)', left: '50%', transform: 'translateX(-50%)', zIndex: 10 }}
                  size="compact-sm"
                  variant="filled"
                  leftSection={<IconArrowDown size={14} />}
                  onClick={handleJumpToLatest}
                >
                  {buildJumpToLatestLabel(unreadCount)}
                </Button>
              )}
            </Transition>
          </Box>
          <Group mt="sm">
            <TextInput
              placeholder="Type a message..."
              value={inputValue}
              onChange={(e) => setInputValue(e.currentTarget.value)}
              onKeyDown={handleKeyDown}
              style={{ flex: 1 }}
            />
            <ActionIcon onClick={() => void handleSend()} variant="filled">
              <IconSend size={16} />
            </ActionIcon>
          </Group>
        </>
      )}
    </Box>
  );
}
