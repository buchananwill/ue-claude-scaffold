/**
 * Arbitration section for the task detail page. Renders the list of
 * arbitration rulings (at most one per trigger) with the contradiction
 * resolution alert when applicable.
 *
 * Extracted verbatim from TaskDetailPage. Uses the shared FindingHighlightLink
 * primitive so the upheld / retired finding click-through stays consistent
 * with the rest of the dashboard.
 */
import { useQuery } from '@tanstack/react-query';
import { Alert, Badge, Card, Group, Loader, Stack, Text, Title } from '@mantine/core';
import { MarkdownContent } from './MarkdownContent.tsx';
import { RelativeTime } from './RelativeTime.tsx';
import { FindingHighlightLink } from './FindingLinks.tsx';
import { usePollInterval } from '../hooks/usePollInterval.tsx';
import { fetchTaskArbitrations } from '../api/client.ts';
import type { ArbitrationRun } from '../api/types.ts';

interface TaskArbitrationSectionProps {
  taskId: number;
  projectId: string;
}

export function TaskArbitrationSection({ taskId, projectId }: TaskArbitrationSectionProps) {
  const { intervalMs } = usePollInterval();
  const { data, isLoading, error } = useQuery({
    queryKey: ['task-arbitrations', taskId, projectId],
    queryFn: ({ signal }) => fetchTaskArbitrations(taskId, signal, projectId),
    refetchInterval: intervalMs,
    staleTime: 2000,
  });

  if (isLoading) {
    return (
      <Card withBorder p="md">
        <Title order={5} mb="xs">Arbitration</Title>
        <Loader size="sm" />
      </Card>
    );
  }

  if (error) {
    return (
      <Card withBorder p="md">
        <Title order={5} mb="xs">Arbitration</Title>
        <Text c="red" size="sm">
          {error instanceof Error ? error.message : String(error)}
        </Text>
      </Card>
    );
  }

  const runs = data?.runs ?? [];
  if (runs.length === 0) {
    return null;
  }

  return (
    <Card withBorder p="md">
      <Title order={5} mb="xs">Arbitration</Title>
      <Stack gap="sm">
        {runs.map((run) => (
          <ArbitrationRunBlock key={run.id} run={run} projectId={projectId} />
        ))}
      </Stack>
    </Card>
  );
}

function ArbitrationRunBlock({ run, projectId }: { run: ArbitrationRun; projectId: string }) {
  return (
    <Card withBorder p="sm" bg="var(--mantine-color-gray-0)">
      <Group gap="sm" mb="xs">
        <Badge color="pink" variant="light" size="sm">{run.trigger}</Badge>
        <Badge color={run.ruling === 'escalate' ? 'red' : run.ruling === 'rule' ? 'orange' : 'green'} variant="filled" size="sm">
          {run.ruling}
        </Badge>
        <Text size="xs" c="dimmed">
          <RelativeTime date={run.postedAt} />
        </Text>
      </Group>

      <MarkdownContent content={run.rulingMarkdown} />

      {run.ruling === 'rule' && run.contradictionResolution && (
        <Alert color="orange" mt="sm" title="Contradiction resolution">
          <Stack gap={4}>
            <Text size="sm">
              Upheld finding:{' '}
              <FindingHighlightLink
                id={run.contradictionResolution.upheldFindingId}
                projectId={projectId}
              />
            </Text>
            <Text size="sm">
              Retired finding:{' '}
              <FindingHighlightLink
                id={run.contradictionResolution.retiredFindingId}
                projectId={projectId}
              />
            </Text>
            <div>
              <Text size="xs" fw={600} c="dimmed">Rationale</Text>
              <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                {run.contradictionResolution.rationale}
              </Text>
            </div>
          </Stack>
        </Alert>
      )}
    </Card>
  );
}
