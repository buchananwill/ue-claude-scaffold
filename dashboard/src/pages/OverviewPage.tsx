import { useState, useMemo } from 'react';
import { Grid, Card, Title, Stack, Button, Group, Pagination } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { TasksPanel } from '../components/TasksPanel.js';
import { AgentsPanel } from '../components/AgentsPanel.js';
import { UbtLockCard } from '../components/UbtLockCard.js';
import { useAgents } from '../hooks/useAgents.js';
import { useTasks } from '../hooks/useTasks.js';
import { useTaskFiltersUrlBacked, UNASSIGNED } from '../hooks/useTaskFilters.js';
import { useUbtStatus } from '../hooks/useUbtStatus.js';
import { apiPost } from '../api/client.js';
import { useProject } from '../contexts/ProjectContext.js';
import { toErrorMessage } from '../utils/toErrorMessage.js';

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

  // Derive available agents from the /agents endpoint so that all registered
  // agents appear in the filter popover, not just those on the current page.
  const availableAgents = useMemo(() => {
    const agentList = agents.data;
    if (!agentList) return [];
    const names = agentList.map((a) => a.name).sort((a, b) => a.localeCompare(b));
    // Always include the unassigned sentinel so users can filter for unassigned tasks.
    // The UNASSIGNED sentinel is recognized by the server's GET /tasks handler
    // (see server/src/routes/tasks.ts).
    names.unshift(UNASSIGNED);
    return names;
  }, [agents.data]);

  const availablePriorities = useMemo(() => {
    const taskList = tasks.data?.tasks;
    if (!taskList) return [];
    const set = new Set<number>();
    for (const t of taskList) set.add(t.priority);
    return Array.from(set).sort((a, b) => b - a);
  }, [tasks.data?.tasks]);

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
            availableAgents={availableAgents}
            availablePriorities={availablePriorities}
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
