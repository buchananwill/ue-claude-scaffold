import { Grid, Card, Title, Stack } from '@mantine/core';
import { TasksPanel } from '../components/TasksPanel.tsx';
import { AgentsPanel } from '../components/AgentsPanel.tsx';
import { UbtLockCard } from '../components/UbtLockCard.tsx';
import { useAgents } from '../hooks/useAgents.ts';
import { useTasks } from '../hooks/useTasks.ts';
import { useTaskFilters } from '../hooks/useTaskFilters.ts';
import { useUbtStatus } from '../hooks/useUbtStatus.ts';

export function OverviewPage() {
  const agents = useAgents();
  const tasks = useTasks();
  const taskFilters = useTaskFilters(tasks.data ?? []);
  const ubt = useUbtStatus();

  return (
    <Grid>
      <Grid.Col span={8}>
        <Card withBorder p="sm">
          <Title order={5} mb="sm">Tasks</Title>
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
