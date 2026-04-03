import { Stack, Select, ScrollArea, Group, Text, Code, Box, Badge, Button, Transition } from '@mantine/core';
import { useRef, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { IconArrowDown } from '@tabler/icons-react';
import dayjs from 'dayjs';
import type { Agent, Message } from '../api/types.ts';
import { StatusBadge } from './StatusBadge.tsx';
import { MarkdownContent } from './MarkdownContent.tsx';
import { AgentMessageCard } from './AgentMessageCard.tsx';
import { useAutoScroll } from '../hooks/useAutoScroll.ts';

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
  const prevScrollHeightRef = useRef<number>(0);
  const isPrependRef = useRef(false);
  const highlightRef = useRef<HTMLDivElement>(null);
  const [flashId, setFlashId] = useState<number | undefined>(highlightMessageId);
  const onHighlightConsumedRef = useRef(onHighlightConsumed);
  onHighlightConsumedRef.current = onHighlightConsumed;

  const { viewportRef, sentinelRef, showJumpToLatest, jumpToLatest, onNewContent } = useAutoScroll();
  // Keep a local ref to the viewport element for prepend scroll restoration
  const viewportElRef = useRef<HTMLDivElement | null>(null);
  const combinedViewportRef = (node: HTMLDivElement | null) => {
    viewportElRef.current = node;
    viewportRef(node);
  };

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
    if (viewportElRef.current) {
      prevScrollHeightRef.current = viewportElRef.current.scrollHeight;
      isPrependRef.current = true;
    }
    onLoadOlder?.();
  };

  // Restore scroll position after prepend
  useLayoutEffect(() => {
    if (isPrependRef.current && viewportElRef.current) {
      const newScrollHeight = viewportElRef.current.scrollHeight;
      const diff = newScrollHeight - prevScrollHeightRef.current;
      viewportElRef.current.scrollTop += diff;
      isPrependRef.current = false;
    }
  }, [currentFirstId]);

  // Auto-scroll to bottom only when new messages arrive at the tail
  const lastSeenIdRef = useRef<number | null>(null);
  useEffect(() => {
    if (currentLastId !== null && currentLastId !== lastSeenIdRef.current) {
      lastSeenIdRef.current = currentLastId;
      onNewContent();
    }
  }, [currentLastId, onNewContent]);

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

      <Box pos="relative" style={{ flex: 1, minHeight: 0 }}>
        <ScrollArea style={{ flex: 1, minHeight: 0 }} viewportRef={combinedViewportRef}>
          <Stack gap="xs">
            {messages.length === 0 && !loading && (
              <Text c="dimmed" ta="center" py="xl" size="sm">No messages in #{channel}</Text>
            )}
            {messages.map((m) => {
              const ts = m.createdAt.endsWith('Z') ? dayjs(m.createdAt) : dayjs(m.createdAt + 'Z');
              const payloadStr = formatPayload(m.payload);
              const isObject = typeof m.payload === 'object' && m.payload !== null;
              const isStringPayload = typeof m.payload === 'string' || (isObject && typeof (m.payload as Record<string, unknown>).message === 'string');

              const isHighlighted = flashId === m.id;

              return (
                <AgentMessageCard
                  key={m.id}
                  agentName={m.fromAgent}
                  timestamp={<Text size="xs" c="dimmed" ff="monospace">{ts.format('HH:mm:ss')}</Text>}
                  headerExtra={<StatusBadge value={m.type} size="xs" />}
                  paperRef={isHighlighted ? highlightRef : undefined}
                  style={{
                    backgroundColor: isHighlighted ? 'var(--mantine-color-blue-light)' : undefined,
                    transition: 'background-color 2s ease-out',
                  }}
                >
                  {isStringPayload ? (
                    <MarkdownContent
                      content={
                        typeof m.payload === 'string'
                          ? m.payload
                          : String((m.payload as Record<string, unknown>).message)
                      }
                    />
                  ) : isObject ? (
                    <Code block fz="xs">{payloadStr}</Code>
                  ) : (
                    <Text size="sm">{payloadStr}</Text>
                  )}
                </AgentMessageCard>
              );
            })}
            <div ref={sentinelRef} />
          </Stack>
        </ScrollArea>

        <Transition mounted={showJumpToLatest} transition="slide-up" duration={200}>
          {(styles) => (
            <Button
              style={{ ...styles, position: 'absolute', bottom: 'var(--mantine-spacing-md)', left: '50%', transform: 'translateX(-50%)', zIndex: 10 }}
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
    </Stack>
  );
}
