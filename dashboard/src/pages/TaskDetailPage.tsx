import { useParams } from '@tanstack/react-router';
import { Link } from '@tanstack/react-router';
import { Stack, Group, Card, Title, Text, Code, Loader, Badge } from '@mantine/core';
import { useTask } from '../hooks/useTask.ts';
import { StatusBadge } from '../components/StatusBadge.tsx';
import { RelativeTime } from '../components/RelativeTime.tsx';
import { TaskDuration } from '../components/TaskDuration.tsx';
import { useProject } from '../contexts/ProjectContext.tsx';

export function TaskDetailPage() {
  const params = useParams({ from: '/$projectId/tasks/$taskId' });
  const { projectId } = useProject();
  const taskId = Number(params.taskId);
  const { data: task, isLoading, error } = useTask(taskId);

  if (isNaN(taskId)) return <Text c="red">Invalid task ID</Text>;
  if (isLoading) return <Loader display="block" mx="auto" my="xl" />;
  if (error) return <Text c="red" ta="center" py="xl">{error instanceof Error ? error.message : String(error)}</Text>;
  if (!task) return <Text c="dimmed" ta="center" py="xl">Task not found</Text>;

  return (
    <Stack gap="md">
      <Text fz="sm"><Link to="/$projectId" params={{ projectId }} search={(prev: any) => prev} style={{ textDecoration: 'none' }}>&larr; Back to overview</Link></Text>

      <Card withBorder p="md">
        <Group gap="sm" mb="md">
          <Title order={3}>#{task.id} {task.title}</Title>
          <StatusBadge value={task.status} />
          <Text size="sm" c="dimmed">Priority {task.priority}</Text>
        </Group>

        <Stack gap="sm">
          <div>
            <Text size="xs" fw={600} c="dimmed">Description</Text>
            {task.description
              ? <Text size="sm">{task.description}</Text>
              : <Text size="sm" c="dimmed" fs="italic">&mdash;</Text>}
          </div>

          <div>
            <Text size="xs" fw={600} c="dimmed">Acceptance Criteria</Text>
            {task.acceptanceCriteria
              ? <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>{task.acceptanceCriteria}</Text>
              : <Text size="sm" c="dimmed" fs="italic">&mdash;</Text>}
          </div>

          <div>
            <Text size="xs" fw={600} c="dimmed">Progress Log</Text>
            {task.progressLog
              ? <Code block>{task.progressLog}</Code>
              : <Text size="sm" c="dimmed" fs="italic">&mdash;</Text>}
          </div>

          <div>
            <Text size="xs" fw={600} c="dimmed">Result</Text>
            {task.result != null
              ? <Code block>{JSON.stringify(task.result, null, 2)}</Code>
              : <Text size="sm" c="dimmed" fs="italic">&mdash;</Text>}
          </div>

          <div>
            <Text size="xs" fw={600} c="dimmed">Files</Text>
            {task.files && task.files.length > 0
              ? <Stack gap={2}>
                  {task.files.map((f) => (
                    <Text key={f} size="sm" ff="monospace">{f}</Text>
                  ))}
                </Stack>
              : <Text size="sm" c="dimmed" fs="italic">(none)</Text>}
          </div>

          <div>
            <Text size="xs" fw={600} c="dimmed">Dependencies</Text>
            {task.dependsOn && task.dependsOn.length > 0
              ? <Group gap="xs">
                  {task.dependsOn.map((depId) => (
                    <Group key={depId} gap={4}>
                      <Text fz="sm" span>
                        <Link
                          to="/$projectId/tasks/$taskId"
                          params={{ projectId, taskId: String(depId) }}
                          style={{ textDecoration: 'none' }}
                        >
                          #{depId}
                        </Link>
                      </Text>
                      {task.blockedBy?.includes(depId) && (
                        <Badge size="xs" color="orange" variant="light">blocking</Badge>
                      )}
                    </Group>
                  ))}
                </Group>
              : <Text size="sm" c="dimmed" fs="italic">(none)</Text>}
          </div>

          {task.blockReasons?.length > 0 && (
            <div>
              <Text size="xs" fw={600} c="dimmed">Block Reasons</Text>
              <Stack gap={2} mt={4}>
                {task.blockReasons.map((r, i) => (
                  <Text key={i} size="sm" c="red">{r}</Text>
                ))}
              </Stack>
            </div>
          )}

          <div>
            <Text size="xs" fw={600} c="dimmed">Source Path</Text>
            {task.sourcePath
              ? <Text size="sm" ff="monospace">{task.sourcePath}</Text>
              : <Text size="sm" c="dimmed" fs="italic">&mdash;</Text>}
          </div>

          <Group gap="md">
            <Text size="xs" c="dimmed">Created: <RelativeTime date={task.createdAt} /></Text>
            <Text size="xs" c="dimmed">Claimed: {task.claimedAt
              ? <RelativeTime date={task.claimedAt} />
              : <Text span size="xs" c="dimmed" fs="italic">&mdash;</Text>}</Text>
            <Text size="xs" c="dimmed">Completed: {task.completedAt
              ? <RelativeTime date={task.completedAt} />
              : <Text span size="xs" c="dimmed" fs="italic">&mdash;</Text>}</Text>
          </Group>
          <Text size="xs" c="dimmed">Duration: <TaskDuration claimedAt={task.claimedAt} completedAt={task.completedAt} status={task.status} /></Text>

          <div>
            <Text size="xs" fw={600} c="dimmed">Claimed By</Text>
            {task.claimedBy
              ? <Text fz="sm" span>
                  <Link to="/$projectId/agents/$agentName" params={{ projectId, agentName: task.claimedBy }}>
                    {task.claimedBy}
                  </Link>
                </Text>
              : <Text size="sm" c="dimmed" fs="italic">&mdash;</Text>}
          </div>
        </Stack>
      </Card>
    </Stack>
  );
}
