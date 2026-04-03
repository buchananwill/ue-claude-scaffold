import type { ReactNode, Ref } from 'react';
import { Paper, Group, Text } from '@mantine/core';
import { agentColor } from '../utils/agentColor.ts';

interface AgentMessageCardProps {
  agentName: string;
  timestamp: ReactNode;
  children: ReactNode;
  /** Extra props forwarded to the Paper wrapper (e.g. highlight styles). */
  paperRef?: Ref<HTMLDivElement>;
  style?: React.CSSProperties;
  /** Content rendered between the agent header and the body. */
  headerExtra?: ReactNode;
}

export function AgentMessageCard({
  agentName,
  timestamp,
  children,
  paperRef,
  style,
  headerExtra,
}: AgentMessageCardProps) {
  const color = agentColor(agentName);

  return (
    <Paper
      ref={paperRef}
      p="sm"
      withBorder
      shadow="xs"
      style={{
        borderLeftWidth: 3,
        borderLeftColor: `var(--mantine-color-${color}-6)`,
        ...style,
      }}
    >
      <Group gap="xs" mb="xs">
        <Text
          size="sm"
          fw={700}
          c={`${color}.4`}
          maw={200}
          style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {agentName}
        </Text>
        {timestamp}
        {headerExtra}
      </Group>
      {children}
    </Paper>
  );
}
