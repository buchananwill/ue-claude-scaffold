/**
 * Compact FSM status strip rendered at the top of the task detail page:
 * task status badge, cycle counter, reviewer-verdict chips, and the
 * arbitration / failure alert banners.
 *
 * Extracted verbatim from TaskDetailPage to keep that page under the
 * project's page-size convention. No logic changes.
 */
import { Alert, Badge, Card, Code, Group, Text, Title } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { StatusBadge } from './StatusBadge.tsx';
import { VERDICT_COLORS } from '../constants/finding-styling.ts';
import type {
  FailureReason,
  ReviewerVerdict,
  ReviewerVerdictMap,
} from '../api/types.ts';

interface TaskFsmStripProps {
  status: string;
  cycleCount: number;
  cycleBudget: number;
  verdicts: ReviewerVerdictMap;
  failureReason: FailureReason | null;
  failureDetail: string | null;
  arbitrationPendingTrigger: string | null;
}

export function TaskFsmStrip({
  status,
  cycleCount,
  cycleBudget,
  verdicts,
  failureReason,
  failureDetail,
  arbitrationPendingTrigger,
}: TaskFsmStripProps) {
  const verdictEntries = Object.entries(verdicts ?? {}) as [string, ReviewerVerdict][];

  return (
    <Card withBorder p="md">
      <Title order={5} mb="xs">Review state</Title>
      <Group gap="md" mb="xs">
        <Group gap={6}>
          <Text size="xs" c="dimmed">Status:</Text>
          <StatusBadge value={status} />
        </Group>
        <Group gap={6}>
          <Text size="xs" c="dimmed">Cycle:</Text>
          <Text size="sm" fw={500}>
            {cycleCount} / {cycleBudget}
          </Text>
        </Group>
      </Group>

      {verdictEntries.length > 0 ? (
        <Group gap="xs">
          {verdictEntries.map(([role, verdict]) => (
            <Badge
              key={role}
              color={VERDICT_COLORS[verdict] ?? 'gray'}
              variant={verdict === 'pending' ? 'outline' : 'light'}
              size="md"
            >
              {role}: {verdict}
            </Badge>
          ))}
        </Group>
      ) : (
        <Text size="sm" c="dimmed" fs="italic">
          No reviewer verdicts recorded yet.
        </Text>
      )}

      {status === 'arbitrating' && (
        <Alert color="pink" mt="md" icon={<IconAlertTriangle size={16} />} title="Arbitration pending">
          Trigger: <Code>{arbitrationPendingTrigger ?? 'unspecified'}</Code>. Waiting for arbitrator ruling.
        </Alert>
      )}

      {status === 'failed' && failureReason && (
        <Alert color="red" mt="md" icon={<IconAlertTriangle size={16} />} title={`Failed: ${failureReason}`}>
          {failureDetail ? (
            <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>{failureDetail}</Text>
          ) : (
            <Text size="sm" c="dimmed" fs="italic">No additional detail recorded.</Text>
          )}
        </Alert>
      )}
    </Card>
  );
}
