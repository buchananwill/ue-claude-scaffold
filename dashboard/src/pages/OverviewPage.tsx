import { useState } from 'react';
import { Grid, Card, Title, Stack, Button, Group } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { TasksPanel } from '../components/TasksPanel.tsx';
import { AgentsPanel } from '../components/AgentsPanel.tsx';
import { UbtLockCard } from '../components/UbtLockCard.tsx';
import { useAgents } from '../hooks/useAgents.ts';
import { useTasks } from '../hooks/useTasks.ts';
import { useTaskFilters } from '../hooks/useTaskFilters.ts';
import { useUbtStatus } from '../hooks/useUbtStatus.ts';
import { apiPost } from '../api/client.ts';

export function OverviewPage() {
  const agents = useAgents();
  const tasks = useTasks();
  const taskFilters = useTaskFilters(tasks.data ?? []);
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
            tasks={tasks.data ?? null}
            isFetching={tasks.isFetching}
            filters={taskFilters}
          />
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
