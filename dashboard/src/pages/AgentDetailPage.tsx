import { useParams } from '@tanstack/react-router';
import { Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { Badge, Grid, Card, Title, Text, Loader, Stack, Group } from '@mantine/core';
import { useAgent } from '../hooks/useAgent.ts';
import { useTasks } from '../hooks/useTasks.ts';
import { useTaskFilters } from '../hooks/useTaskFilters.ts';
import { useAgents } from '../hooks/useAgents.ts';
import { useMessages } from '../hooks/useMessages.ts';
import { ApiError } from '../api/client.ts';
import { StatusBadge } from '../components/StatusBadge.tsx';
import { RelativeTime } from '../components/RelativeTime.tsx';
import { TasksPanel } from '../components/TasksPanel.tsx';
import { MessagesFeed } from '../components/MessagesFeed.tsx';
import { useProject } from '../contexts/ProjectContext.tsx';

export function AgentDetailPage() {
  const params = useParams({ from: '/$projectId/agents/$agentName' });
  const agentName = params.agentName ?? '';
  const { projectId } = useProject();
  const { data: agent, isLoading, error, isError } = useAgent(agentName);
  const tasks = useTasks({ limit: 500 });
  const agents = useAgents();
  const [typeFilter, setTypeFilter] = useState('');
  const messages = useMessages('_all', typeFilter, agentName);

  const is404 = isError && error instanceof ApiError && error.status === 404;
  const isDeregistered = is404;
  const isRealError = isError && !is404;

  const agentTasks = useMemo(() => {
    if (!tasks.data?.tasks) return [];
    return tasks.data.tasks.filter((t) => t.claimedBy === agentName);
  }, [tasks.data, agentName]);

  const excludeStatuses = new Set(['pending']);
  const taskFilters = useTaskFilters(agentTasks);

  if (!agentName) return <Text c="red" ta="center" py="xl">No agent name provided</Text>;
  if (isLoading) return <Loader display="block" mx="auto" my="xl" />;
  if (isRealError) return <Text c="red" ta="center" py="xl">{error instanceof Error ? error.message : String(error)}</Text>;

  return (
    <Stack gap="md">
      {/* prev: any — TanStack Router doesn't infer search param types for cross-route Links */}
      <Text fz="sm"><Link to="/$projectId" params={{ projectId }} search={(prev: any) => prev} style={{ textDecoration: 'none' }}>&larr; Back to overview</Link></Text>

      {agent ? (
        <>
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
        </>
      ) : isDeregistered ? (
        <Group gap="sm">
          <Title order={3}>{agentName}</Title>
          <Badge color="gray" variant="light" size="sm">deregistered</Badge>
        </Group>
      ) : null}

      <Grid>
        <Grid.Col span={8}>
          <Card withBorder p="sm">
            <Title order={5} mb="sm">Tasks</Title>
            <TasksPanel
              tasks={agentTasks}
              isFetching={tasks.isFetching}
              filters={taskFilters}
              excludeStatuses={excludeStatuses}
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
              channel="_all"
              onChannelChange={() => {}}
              agents={agents.data ?? null}
              hideSelector
              typeFilter={typeFilter}
              onTypeFilterChange={setTypeFilter}
              agentFilter=""
              onAgentFilterChange={() => {}}
              totalCount={messages.totalCount}
              hasOlder={messages.hasOlder}
              loadingOlder={messages.loadingOlder}
              onLoadOlder={messages.loadOlder}
            />
          </Card>
        </Grid.Col>
      </Grid>
    </Stack>
  );
}
