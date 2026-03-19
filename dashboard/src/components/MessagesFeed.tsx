import { Stack, Select, ScrollArea, Group, Text, Code, Box, Chip } from '@mantine/core';
import { useRef, useEffect, useMemo } from 'react';
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
}

const KNOWN_TYPES = ['info', 'progress', 'build_start', 'build_end', 'test_start', 'test_end', 'error', 'warning'];

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
}: MessagesFeedProps) {
  const viewport = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);

  const channels = useMemo(() => {
    const set = new Set<string>(['general']);
    agents?.forEach((a) => set.add(a.name));
    return Array.from(set).map((c) => ({ value: c, label: c }));
  }, [agents]);
  const dynamicTypes = useMemo(() => {
    const seen = new Set(messages.map(m => m.type));
    return Array.from(seen).filter(t => !KNOWN_TYPES.includes(t));
  }, [messages]);

  useEffect(() => {
    sentinel.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const formatPayload = (payload: unknown): string => {
    if (typeof payload === 'string') return payload;
    return JSON.stringify(payload, null, 2);
  };

  return (
    <Stack gap="sm" h="100%">
      {!hideSelector && (
        <Select
          size="xs"
          label="Channel"
          data={channels}
          value={channel}
          onChange={(v) => v && onChannelChange(v)}
          w={200}
        />
      )}

      <Chip.Group value={typeFilter} onChange={(v) => onTypeFilterChange(typeof v === 'string' ? v : '')}>
        <Group gap="xs" wrap="wrap">
          <Chip value="" size="xs" variant="outline">All</Chip>
          {KNOWN_TYPES.map(t => <Chip key={t} value={t} size="xs" variant="outline">{t}</Chip>)}
          {dynamicTypes.map(t => <Chip key={t} value={t} size="xs" variant="outline">{t}</Chip>)}
        </Group>
      </Chip.Group>

      {error && <Text c="red" size="sm">{error}</Text>}
      {loading && messages.length === 0 && <Text c="dimmed" size="sm">Loading...</Text>}

      <ScrollArea h="calc(100vh - 260px)" viewportRef={viewport}>
        <Stack gap={4}>
          {messages.length === 0 && !loading && (
            <Text c="dimmed" ta="center" py="xl" size="sm">No messages in #{channel}</Text>
          )}
          {messages.map((m) => {
            const ts = m.createdAt.endsWith('Z') ? dayjs(m.createdAt) : dayjs(m.createdAt + 'Z');
            const payloadStr = formatPayload(m.payload);
            const isObject = typeof m.payload === 'object' && m.payload !== null;

            return (
              <Box key={m.id} py={4} px="xs" style={{ borderBottom: '1px solid var(--mantine-color-dark-5)' }}>
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
