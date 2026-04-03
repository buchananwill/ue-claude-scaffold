import { useState, useEffect, useRef } from 'react';
import { ScrollArea, Box, Group, Text, TextInput, ActionIcon, Button, Paper, Transition, Stack } from '@mantine/core';
import { IconSend, IconArrowDown } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { apiPost } from '../api/client.ts';
import { useProject } from '../contexts/ProjectContext.tsx';
import { RelativeTime } from './RelativeTime.tsx';
import { MarkdownContent } from './MarkdownContent.tsx';
import { agentColor } from '../utils/agentColor.ts';
import { useAutoScroll } from '../hooks/useAutoScroll.ts';
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
}: ChatTimelineProps) {
  const { projectId } = useProject();
  const [inputValue, setInputValue] = useState('');
  const { viewportRef, sentinelRef, showJumpToLatest, jumpToLatest, onNewContent } = useAutoScroll();
  const lastMessageId = messages.length > 0 ? messages[messages.length - 1].id : null;
  const lastSeenIdRef = useRef<number | null>(null);

  useEffect(() => {
    onMarkRead();
  }, [roomId, onMarkRead]);

  useEffect(() => {
    if (lastMessageId !== null && lastMessageId !== lastSeenIdRef.current) {
      lastSeenIdRef.current = lastMessageId;
      onNewContent();
    }
  }, [lastMessageId, onNewContent]);

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
        message: err instanceof Error ? err.message : String(err),
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
                {messages.map((msg) => {
                  const color = agentColor(msg.sender);
                  return (
                    <Paper
                      key={msg.id}
                      p="sm"
                      withBorder
                      shadow="xs"
                      style={{
                        borderLeftWidth: 3,
                        borderLeftColor: `var(--mantine-color-${color}-6)`,
                      }}
                    >
                      <Group gap="xs" mb={4}>
                        <Text size="sm" fw={700} c={`${color}.4`}>{msg.sender}</Text>
                        <RelativeTime date={msg.createdAt} />
                      </Group>
                      {msg.replyTo != null && (
                        <Text size="xs" c="dimmed">reply to #{msg.replyTo}</Text>
                      )}
                      <MarkdownContent content={msg.content} />
                    </Paper>
                  );
                })}
              </Stack>
              <div ref={sentinelRef} />
            </ScrollArea>

            <Transition mounted={showJumpToLatest} transition="slide-up" duration={200}>
              {(styles) => (
                <Button
                  style={{ ...styles, position: 'absolute', bottom: 16, left: '50%', transform: 'translateX(-50%)', zIndex: 10 }}
                  size="compact-sm"
                  variant="filled"
                  leftSection={<IconArrowDown size={14} />}
                  onClick={jumpToLatest}
                >
                  Jump to latest
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
            <ActionIcon onClick={handleSend} variant="filled">
              <IconSend size={16} />
            </ActionIcon>
          </Group>
        </>
      )}
    </Box>
  );
}
