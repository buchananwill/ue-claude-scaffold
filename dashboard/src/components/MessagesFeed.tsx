import { Stack, Select, ScrollArea, Group, Text, Code, Box, Badge, Button } from '@mantine/core';
import { useRef, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import dayjs from 'dayjs';
import type { Agent, Message } from '../api/types.ts';
import { StatusBadge } from './StatusBadge.tsx';

interface MessagesFeedProps {
  messages: Message[];
  loading: boolean;
  error: string | null;
  channel: string;
  onChannelChange: (c: string) => void;
  agents: Agent[] | null;
  hideSelector?: boolean;
  typeFilter: string;
  onTypeFilterChange: (t: string) => void;
  agentFilter: string;
  onAgentFilterChange: (a: string) => void;
  totalCount?: number | null;
  hasOlder?: boolean;
  loadingOlder?: boolean;
  onLoadOlder?: () => void;
  highlightMessageId?: number;
  onHighlightConsumed?: () => void;
}

const KNOWN_TYPES = [
  'phase_start',
  'phase_complete',
  'phase_failed',
  'build_result',
  'build_start',
  'build_end',
  'test_start',
  'test_end',
  'status_update',
  'summary',
];

export function MessagesFeed({
  messages,
  loading,
  error,
  channel,
  onChannelChange,
  agents,
  hideSelector,
  typeFilter,
  onTypeFilterChange,
  agentFilter,
  onAgentFilterChange,
  totalCount,
  hasOlder,
  loadingOlder,
  onLoadOlder,
  highlightMessageId,
  onHighlightConsumed,
}: MessagesFeedProps) {
  const viewport = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const lastMessageIdRef = useRef<number | null>(null);
  const prevScrollHeightRef = useRef<number>(0);
  const isPrependRef = useRef(false);
  const highlightRef = useRef<HTMLDivElement>(null);
  const [flashId, setFlashId] = useState<number | undefined>(highlightMessageId);
  const onHighlightConsumedRef = useRef(onHighlightConsumed);
  onHighlightConsumedRef.current = onHighlightConsumed;

  // Sync flashId when highlightMessageId changes from outside
  useEffect(() => {
    setFlashId(highlightMessageId);
  }, [highlightMessageId]);

  // Scroll to highlighted message and trigger fade-out
  useEffect(() => {
    if (flashId == null || !highlightRef.current) return;
    highlightRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const timer = setTimeout(() => {
      setFlashId(undefined);
      onHighlightConsumedRef.current?.();
    }, 500);
    return () => clearTimeout(timer);
  }, [flashId]);

  const channels = useMemo(() => {
    return [{ value: 'general', label: 'general' }];
  }, []);

  const agentOptions = useMemo(() => {
    const options = [{ value: '', label: 'All agents' }];
    agents?.forEach((a) => options.push({ value: a.name, label: a.name }));
    return options;
  }, [agents]);
  const dynamicTypes = useMemo(() => {
    const seen = new Set(messages.map(m => m.type));
    return Array.from(seen).filter(t => !KNOWN_TYPES.includes(t));
  }, [messages]);

  // Track whether this render is a prepend (older messages loaded at the top)
  const currentLastId = messages.length > 0 ? messages[messages.length - 1].id : null;
  const currentFirstId = messages.length > 0 ? messages[0].id : null;

  // Before load-older, capture scroll height
  const handleLoadOlder = () => {
    if (viewport.current) {
      prevScrollHeightRef.current = viewport.current.scrollHeight;
      isPrependRef.current = true;
    }
    onLoadOlder?.();
  };

  // Restore scroll position after prepend
  useLayoutEffect(() => {
    if (isPrependRef.current && viewport.current) {
      const newScrollHeight = viewport.current.scrollHeight;
      const diff = newScrollHeight - prevScrollHeightRef.current;
      viewport.current.scrollTop += diff;
      isPrependRef.current = false;
    }
  }, [currentFirstId]);

  // Auto-scroll to bottom only when new messages arrive at the tail
  useEffect(() => {
    if (currentLastId !== null && currentLastId !== lastMessageIdRef.current) {
      lastMessageIdRef.current = currentLastId;
      sentinel.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [currentLastId]);

  const formatPayload = (payload: unknown): string => {
    if (typeof payload === 'string') return payload;
    return JSON.stringify(payload, null, 2);
  };

  return (
    <Stack gap="sm" h="100%">
      {!hideSelector && (
        <Group gap="sm">
          <Select
            size="xs"
            label="Channel"
            data={channels}
            value={channel}
            onChange={(v) => v && onChannelChange(v)}
            w={200}
          />
          <Select
            size="xs"
            label="Agent"
            data={agentOptions}
            value={agentFilter}
            onChange={(v) => onAgentFilterChange(v ?? '')}
            w={200}
            clearable
          />
        </Group>
      )}

      <Group gap="xs" wrap="wrap">
        {['', ...KNOWN_TYPES, ...dynamicTypes].map((t) => (
          <Badge
            key={t}
            size="sm"
            variant={typeFilter === t ? 'filled' : 'outline'}
            style={{ cursor: 'pointer' }}
            onClick={() => onTypeFilterChange(t)}
          >
            {t || 'All'}
          </Badge>
        ))}
      </Group>

      {error && <Text c="red" size="sm">{error}</Text>}
      {loading && messages.length === 0 && <Text c="dimmed" size="sm">Loading...</Text>}

      <Group gap="xs" justify="space-between">
        <Text size="xs" c="dimmed">
          {totalCount != null ? `Showing ${messages.length} of ${totalCount} messages` : `${messages.length} messages`}
        </Text>
        {hasOlder && (
          <Button variant="subtle" size="compact-xs" onClick={handleLoadOlder} loading={loadingOlder}>
            Load older
          </Button>
        )}
      </Group>

      <ScrollArea h="calc(100vh - 260px)" viewportRef={viewport}>
        <Stack gap={4}>
          {messages.length === 0 && !loading && (
            <Text c="dimmed" ta="center" py="xl" size="sm">No messages in #{channel}</Text>
          )}
          {messages.map((m) => {
            const ts = m.createdAt.endsWith('Z') ? dayjs(m.createdAt) : dayjs(m.createdAt + 'Z');
            const payloadStr = formatPayload(m.payload);
            const isObject = typeof m.payload === 'object' && m.payload !== null;

            const isHighlighted = flashId === m.id;

            return (
              <Box
                key={m.id}
                ref={isHighlighted ? highlightRef : undefined}
                py={4}
                px="xs"
                style={{
                  borderBottom: '1px solid var(--mantine-color-dark-5)',
                  backgroundColor: isHighlighted ? 'rgba(59, 130, 246, 0.25)' : 'transparent',
                  transition: 'background-color 2s ease-out',
                }}
              >
                <Group gap="xs" mb={2}>
                  <Text size="xs" c="dimmed" ff="monospace">{ts.format('HH:mm:ss')}</Text>
                  <Text size="sm" fw={700}>{m.fromAgent}</Text>
                  <StatusBadge value={m.type} size="xs" />
                </Group>
                {isObject ? (
                  <Code block fz="xs">{payloadStr}</Code>
                ) : (
                  <Text size="sm" pl="xs">{payloadStr}</Text>
                )}
              </Box>
            );
          })}
          <div ref={sentinel} />
        </Stack>
      </ScrollArea>
    </Stack>
  );
}
