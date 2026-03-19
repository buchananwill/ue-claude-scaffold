import { useParams } from '@tanstack/react-router';
import { Link } from '@tanstack/react-router';
import { Stack, Group, Card, Title, Text, Code, Loader } from '@mantine/core';
import { useTask } from '../hooks/useTask.ts';
import { StatusBadge } from '../components/StatusBadge.tsx';
import { RelativeTime } from '../components/RelativeTime.tsx';

export function TaskDetailPage() {
  const params = useParams({ strict: false }) as { taskId?: string };
  const taskId = Number(params.taskId);
  const { data: task, isLoading, error } = useTask(taskId);

  if (isNaN(taskId)) return <Text c="red">Invalid task ID</Text>;
  if (isLoading) return <Loader display="block" mx="auto" my="xl" />;
  if (error) return <Text c="red" ta="center" py="xl">{error instanceof Error ? error.message : String(error)}</Text>;
  if (!task) return <Text c="dimmed" ta="center" py="xl">Task not found</Text>;

  return (
    <Stack gap="md">
      <Link to="/" style={{ textDecoration: 'none', fontSize: '0.875rem' }}>&larr; Back to overview</Link>

      <Card withBorder p="md">
        <Group gap="sm" mb="md">
          <Title order={3}>#{task.id} {task.title}</Title>
          <StatusBadge value={task.status} />
          {task.priority > 0 && <Text size="sm" c="dimmed">Priority {task.priority}</Text>}
        </Group>

        <Stack gap="sm">
          {task.description && (
            <div>
              <Text size="xs" fw={600} c="dimmed">Description</Text>
              <Text size="sm">{task.description}</Text>
            </div>
          )}

          {task.acceptanceCriteria && (
            <div>
              <Text size="xs" fw={600} c="dimmed">Acceptance Criteria</Text>
              <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>{task.acceptanceCriteria}</Text>
            </div>
          )}

          {task.progressLog && (
            <div>
              <Text size="xs" fw={600} c="dimmed">Progress Log</Text>
              <Code block>{task.progressLog}</Code>
            </div>
          )}

          {task.result != null && (
            <div>
              <Text size="xs" fw={600} c="dimmed">Result</Text>
              <Code block>{JSON.stringify(task.result, null, 2)}</Code>
            </div>
          )}

          {task.files && task.files.length > 0 && (
            <div>
              <Text size="xs" fw={600} c="dimmed">Files</Text>
              <Stack gap={2}>
                {task.files.map((f) => (
                  <Text key={f} size="sm" ff="monospace">{f}</Text>
                ))}
              </Stack>
            </div>
          )}

          {task.sourcePath && (
            <div>
              <Text size="xs" fw={600} c="dimmed">Source Path</Text>
              <Text size="sm" ff="monospace">{task.sourcePath}</Text>
            </div>
          )}

          <Group gap="md">
            <Text size="xs" c="dimmed">Created: <RelativeTime date={task.createdAt} /></Text>
            {task.claimedAt && (
              <Text size="xs" c="dimmed">Claimed: <RelativeTime date={task.claimedAt} /></Text>
            )}
            {task.completedAt && (
              <Text size="xs" c="dimmed">Completed: <RelativeTime date={task.completedAt} /></Text>
            )}
          </Group>

          {task.claimedBy && (
            <div>
              <Text size="xs" fw={600} c="dimmed">Claimed By</Text>
              <Link to="/agents/$agentName" params={{ agentName: task.claimedBy }} style={{ fontSize: '0.875rem' }}>
                {task.claimedBy}
              </Link>
            </div>
          )}
        </Stack>
      </Card>
    </Stack>
  );
}
