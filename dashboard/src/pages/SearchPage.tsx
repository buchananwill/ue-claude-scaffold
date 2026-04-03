import { Title, Loader, Text, Stack, Group, UnstyledButton, Paper } from '@mantine/core';
import { IconSubtask, IconMessage, IconRobot } from '@tabler/icons-react';
import { useSearch, useNavigate } from '@tanstack/react-router';
import { useSearch as useSearchQuery } from '../hooks/useSearch.ts';
import { useProject } from '../contexts/ProjectContext.tsx';

export function SearchPage() {
  const { q } = useSearch({ strict: false }) as { q: string };
  const navigate = useNavigate();
  const { projectId } = useProject();
  const { data, isFetching } = useSearchQuery(q);

  const hasResults =
    data && (data.tasks.length > 0 || data.messages.length > 0 || data.agents.length > 0);

  return (
    <Stack gap="lg" p="md">
      <Title order={2}>Search results for &quot;{q}&quot;</Title>

      {isFetching && !data && <Loader size="lg" display="block" mx="auto" my="xl" />}

      {!isFetching && !hasResults && (
        <Text size="lg" c="dimmed" ta="center" my="xl">
          No results found
        </Text>
      )}

      {data && data.tasks.length > 0 && (
        <Paper p="md" withBorder>
          <Title order={4} mb="sm">
            <Group gap="xs">
              <IconSubtask size={18} />
              Tasks ({data.tasks.length})
            </Group>
          </Title>
          <Stack gap="xs">
            {data.tasks.map((task) => (
              <UnstyledButton
                key={`task-${task.id}`}
                w="100%"
                p="xs"
                style={{ borderRadius: 'var(--mantine-radius-sm)' }}
                onClick={() =>
                  navigate({ to: '/$projectId/tasks/$taskId', params: { projectId, taskId: String(task.id) } })
                }
              >
                <Group gap="xs" wrap="nowrap">
                  <IconSubtask size={14} />
                  <div style={{ minWidth: 0 }}>
                    <Text size="sm" truncate>
                      {task.title}
                    </Text>
                    <Text size="xs" c="dimmed" truncate>
                      {task.status} - #{task.id}
                    </Text>
                  </div>
                </Group>
              </UnstyledButton>
            ))}
          </Stack>
        </Paper>
      )}

      {data && data.messages.length > 0 && (
        <Paper p="md" withBorder>
          <Title order={4} mb="sm">
            <Group gap="xs">
              <IconMessage size={18} />
              Messages ({data.messages.length})
            </Group>
          </Title>
          <Stack gap="xs">
            {data.messages.map((msg) => (
              <UnstyledButton
                key={`msg-${msg.id}`}
                w="100%"
                p="xs"
                style={{ borderRadius: 'var(--mantine-radius-sm)' }}
                onClick={() =>
                  navigate({
                    to: '/$projectId/messages/$channel',
                    params: { projectId, channel: msg.channel },
                    search: { type: undefined, highlight: String(msg.id), agent: undefined },
                  })
                }
              >
                <Group gap="xs" wrap="nowrap">
                  <IconMessage size={14} />
                  <div style={{ minWidth: 0 }}>
                    <Text size="sm" truncate>
                      {msg.fromAgent} in #{msg.channel}
                    </Text>
                    <Text size="xs" c="dimmed" truncate>
                      {msg.type}
                    </Text>
                  </div>
                </Group>
              </UnstyledButton>
            ))}
          </Stack>
        </Paper>
      )}

      {data && data.agents.length > 0 && (
        <Paper p="md" withBorder>
          <Title order={4} mb="sm">
            <Group gap="xs">
              <IconRobot size={18} />
              Agents ({data.agents.length})
            </Group>
          </Title>
          <Stack gap="xs">
            {data.agents.map((agent) => (
              <UnstyledButton
                key={`agent-${agent.name}`}
                w="100%"
                p="xs"
                style={{ borderRadius: 'var(--mantine-radius-sm)' }}
                onClick={() =>
                  navigate({ to: '/$projectId/agents/$agentName', params: { projectId, agentName: agent.name } })
                }
              >
                <Group gap="xs" wrap="nowrap">
                  <IconRobot size={14} />
                  <div style={{ minWidth: 0 }}>
                    <Text size="sm" truncate>
                      {agent.name}
                    </Text>
                    <Text size="xs" c="dimmed" truncate>
                      {agent.status}
                    </Text>
                  </div>
                </Group>
              </UnstyledButton>
            ))}
          </Stack>
        </Paper>
      )}
    </Stack>
  );
}
