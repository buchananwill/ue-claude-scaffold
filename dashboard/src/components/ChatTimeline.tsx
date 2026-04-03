import { useState, useEffect, useRef } from 'react';
import { ScrollArea, Box, Group, Text, TextInput, ActionIcon, Button } from '@mantine/core';
import { IconSend } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { apiPost } from '../api/client.ts';
import { useProject } from '../contexts/ProjectContext.tsx';
import { RelativeTime } from './RelativeTime.tsx';
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
  const sentinelRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const lastMessageId = messages.length > 0 ? messages[messages.length - 1].id : null;

  useEffect(() => {
    onMarkRead();
  }, [roomId, onMarkRead]);

  useEffect(() => {
    if (!sentinelRef.current || !viewportRef.current) return;
    const viewport = viewportRef.current;
    const distanceFromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    if (distanceFromBottom < 100) {
      sentinelRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [lastMessageId]);

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
      handleSend();
    }
  };

  return (
    <Box>
      {error && <Text c="red" size="sm" mb="xs">{error}</Text>}
      {loading && messages.length === 0 ? (
        <Text c="dimmed" ta="center">Loading...</Text>
      ) : (
        <>
          <ScrollArea h="calc(100vh - 250px)" viewportRef={viewportRef}>
            {hasOlder && (
              <Button variant="subtle" size="xs" onClick={onLoadOlder} loading={loadingOlder} mb="xs">
                Load older
              </Button>
            )}
            {messages.map((msg) => (
              <Box key={msg.id} mb="xs">
                <Group gap="xs">
                  <Text size="sm" fw={700}>{msg.sender}</Text>
                  <RelativeTime date={msg.createdAt} />
                </Group>
                {msg.replyTo != null && (
                  <Text size="xs" c="dimmed">↩ reply to #{msg.replyTo}</Text>
                )}
                <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>{msg.content}</Text>
              </Box>
            ))}
            <div ref={sentinelRef} />
          </ScrollArea>
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
