import { useParams } from '@tanstack/react-router';
import { Link } from '@tanstack/react-router';
import { useState, useMemo } from 'react';
import { Grid, Card, Title, Text, Loader, Stack, Group } from '@mantine/core';
import { useAgent } from '../hooks/useAgent.ts';
import { useTasks } from '../hooks/useTasks.ts';
import { useTaskFilters } from '../hooks/useTaskFilters.ts';
import { useAgents } from '../hooks/useAgents.ts';
import { useMessages } from '../hooks/useMessages.ts';
import { StatusBadge } from '../components/StatusBadge.tsx';
import { RelativeTime } from '../components/RelativeTime.tsx';
import { TasksPanel } from '../components/TasksPanel.tsx';
import { MessagesFeed } from '../components/MessagesFeed.tsx';

export function AgentDetailPage() {
  const params = useParams({ strict: false }) as { agentName?: string };
  const agentName = params.agentName ?? '';
  const { data: agent, isLoading, error } = useAgent(agentName);
  const tasks = useTasks();
  const agents = useAgents();
  const messages = useMessages(agentName);
  const [statusFilter, setStatusFilter] = useState('');

  const agentTasks = useMemo(() => {
    if (!tasks.data) return [];
    return tasks.data.filter((t) => t.claimedBy === agentName);
  }, [tasks.data, agentName]);

  const taskFilters = useTaskFilters(agentTasks);

  if (isLoading) return <Loader display="block" mx="auto" my="xl" />;
  if (error) return <Text c="red" ta="center" py="xl">{error instanceof Error ? error.message : String(error)}</Text>;
  if (!agent) return <Text c="dimmed" ta="center" py="xl">Agent not found</Text>;

  return (
    <Stack gap="md">
      <Link to="/" style={{ textDecoration: 'none', fontSize: '0.875rem' }}>&larr; Back to overview</Link>

      <Group gap="sm">
        <Title order={3}>{agent.name}</Title>
        <StatusBadge value={agent.status} />
        <RelativeTime date={agent.registeredAt} />
      </Group>

      <Group gap="md">
        <Text size="sm" c="dimmed">Worktree: <Text span ff="monospace">{agent.worktree}</Text></Text>
        {agent.planDoc && (
          <Text size="sm" c="dimmed">Plan: <Text span ff="monospace">{agent.planDoc}</Text></Text>
        )}
      </Group>

      <Grid>
        <Grid.Col span={8}>
          <Card withBorder p="sm">
            <Title order={5} mb="sm">Tasks</Title>
            <TasksPanel
              tasks={agentTasks}
              isFetching={tasks.isFetching}
              statusFilter={statusFilter}
              onFilterChange={setStatusFilter}
              filters={taskFilters}
            />
          </Card>
        </Grid.Col>
        <Grid.Col span={4}>
          <Card withBorder p="sm">
            <Title order={5} mb="sm">Messages</Title>
            <MessagesFeed
              messages={messages.messages}
              loading={messages.loading}
              error={messages.error}
              channel={agentName}
              onChannelChange={() => {}}
              agents={agents.data ?? null}
              hideSelector
            />
          </Card>
        </Grid.Col>
      </Grid>
    </Stack>
  );
}
