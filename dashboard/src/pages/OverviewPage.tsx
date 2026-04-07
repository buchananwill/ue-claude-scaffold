import { useState } from 'react';
import { Grid, Card, Title, Stack, Button, Group, Pagination } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { TasksPanel } from '../components/TasksPanel.tsx';
import { AgentsPanel } from '../components/AgentsPanel.tsx';
import { UbtLockCard } from '../components/UbtLockCard.tsx';
import { useAgents } from '../hooks/useAgents.ts';
import { useTasks } from '../hooks/useTasks.ts';
import { useTaskFiltersUrlBacked } from '../hooks/useTaskFilters.ts';
import { useUbtStatus } from '../hooks/useUbtStatus.ts';
import { apiPost } from '../api/client.ts';
import { useProject } from '../contexts/ProjectContext.tsx';
import { toErrorMessage } from '../utils/toErrorMessage.ts';

const PAGE_SIZE = 20;

export function OverviewPage() {
  const { projectId } = useProject();
  const agents = useAgents();
  const taskFilters = useTaskFiltersUrlBacked();
  const { page, statusFilter, agentFilter, priorityFilter, sortColumn, sortDir } = taskFilters;
  const offset = (page - 1) * PAGE_SIZE;
  const tasks = useTasks({
    limit: PAGE_SIZE,
    offset,
    status: statusFilter.size > 0 ? [...statusFilter] : undefined,
    agent: agentFilter.size > 0 ? [...agentFilter] : undefined,
    priority: priorityFilter.size > 0 ? [...priorityFilter] : undefined,
    sort: sortColumn ?? undefined,
    dir: sortDir ?? undefined,
  });
  const ubt = useUbtStatus();
  const [syncing, setSyncing] = useState(false);

  const handleSync = async () => {
    setSyncing(true);
    try {
      const res = await apiPost<{
        ok: boolean;
        exteriorHead?: string;
        commitSha?: string;
        upToDate?: boolean;
        reason?: string;
      }>('/sync/plans', undefined, projectId);
      if (res.ok) {
        const detail = res.upToDate
          ? 'Already up to date'
          : `Synced to ${res.commitSha?.slice(0, 8)}`;
        notifications.show({ title: 'Sync complete', message: detail, color: 'green' });
      } else {
        notifications.show({ title: 'Sync failed', message: res.reason ?? 'Unknown error', color: 'red' });
      }
    } catch (err) {
      notifications.show({
        title: 'Sync failed',
        message: toErrorMessage(err),
        color: 'red',
      });
    } finally {
      setSyncing(false);
    }
  };

  return (
    <Grid>
      <Grid.Col span={8}>
        <Card withBorder p="sm">
          <Group justify="space-between" mb="sm">
            <Title order={5}>Tasks</Title>
            <Button
              size="compact-xs"
              variant="light"
              loading={syncing}
              onClick={handleSync}
            >
              Sync Bare Repo
            </Button>
          </Group>
          <TasksPanel
            tasks={tasks.data?.tasks ?? null}
            isFetching={tasks.isFetching}
            filters={taskFilters}
          />
        </Card>
        {/* zIndex: 1 layers above scrolled task rows; boxShadow fades into page background */}
        <Group justify="center" py="xs" mt="xs" pos="sticky" bottom={0} bg="var(--mantine-color-body)" style={{ zIndex: 1, boxShadow: '0 -6px 9px 3px var(--mantine-color-body)' }}>
          <Pagination
            total={Math.ceil((tasks.data?.total ?? 0) / PAGE_SIZE)}
            value={taskFilters.page ?? 1}
            onChange={taskFilters.setPage}
            size="sm"
          />
        </Group>
      </Grid.Col>
      <Grid.Col span={4}>
        <Stack gap="md">
          <Card withBorder p="sm">
            <Title order={5} mb="sm">Agents</Title>
            <AgentsPanel agents={agents.data ?? null} />
          </Card>
          <UbtLockCard status={ubt.data ?? null} />
        </Stack>
      </Grid.Col>
    </Grid>
  );
}
