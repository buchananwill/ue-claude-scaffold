import { Collapse, Text, Code, Stack, Group, Badge, Table } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import type { Task } from '../api/types.ts';
import { RelativeTime } from './RelativeTime.tsx';
import { useProject } from '../contexts/ProjectContext.tsx';

interface TaskDetailRowProps {
  task: Task;
  expanded: boolean;
}

export function TaskDetailRow({ task, expanded }: TaskDetailRowProps) {
  const { projectId } = useProject();
  return (
    <Table.Tr>
      <Table.Td colSpan={7}>
        <Collapse in={expanded}>
          <Stack gap="xs" p="sm">
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
            {task.blockedBy && task.blockedBy.length > 0 && (
              <div>
                <Text size="xs" fw={600} c="dimmed">Blocked by</Text>
                <Group gap={4}>
                  {task.blockedBy.map((depId) => (
                    <Link
                      key={depId}
                      to="/$projectId/tasks/$taskId"
                      params={{ projectId, taskId: String(depId) }}
                      onClick={(e) => e.stopPropagation()}
                      style={{ textDecoration: 'none' }}
                    >
                      <Badge size="sm" color="orange" variant="light">#{depId}</Badge>
                    </Link>
                  ))}
                </Group>
              </div>
            )}
            {task.blockReasons?.length > 0 && (
              <div>
                <Text size="xs" fw={600} c="dimmed">Block Reasons</Text>
                <Stack gap={2}>
                  {task.blockReasons.map((r, i) => (
                    <Text key={i} size="xs" c="red">{r}</Text>
                  ))}
                </Stack>
              </div>
            )}
            <Group gap="xs">
              {task.claimedAt && (
                <Text size="xs" c="dimmed">Claimed: <RelativeTime date={task.claimedAt} /></Text>
              )}
              {task.completedAt && (
                <Text size="xs" c="dimmed">Completed: <RelativeTime date={task.completedAt} /></Text>
              )}
            </Group>
          </Stack>
        </Collapse>
      </Table.Td>
    </Table.Tr>
  );
}
