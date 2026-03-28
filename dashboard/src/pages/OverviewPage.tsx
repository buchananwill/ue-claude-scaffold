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

export function OverviewPage() {
  const agents = useAgents();
  const taskFilters = useTaskFiltersUrlBacked([]);
  const { page, setPage, statusFilter } = taskFilters;
  // Server accepts a single status filter. When the user selects exactly one status chip,
  // push it to the server for a tighter result set. When zero or multiple are selected,
  // omit the server-side filter and let client-side filtering handle it.
  const statusParam = statusFilter.size === 1 ? [...statusFilter][0] : undefined;
  const PAGE_SIZE = 20;
  const offset = ((page ?? 1) - 1) * PAGE_SIZE;
  const tasks = useTasks({ limit: PAGE_SIZE, offset, status: statusParam });
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
      }>('/sync/plans');
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
        message: err instanceof Error ? err.message : String(err),
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
          <Group justify="center" mt="xs">
            <Pagination
              total={Math.ceil((tasks.data?.total ?? 0) / PAGE_SIZE)}
              value={page ?? 1}
              onChange={setPage}
              size="sm"
            />
          </Group>
        </Card>
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
