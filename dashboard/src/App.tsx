import { useState } from 'react';
import { AppShell, Tabs, Grid, Card, Title, Stack } from '@mantine/core';
import { IconLayoutDashboard, IconMessage } from '@tabler/icons-react';
import { HealthBar } from './components/HealthBar';
import { AgentsPanel } from './components/AgentsPanel';
import { TasksPanel } from './components/TasksPanel';
import { MessagesFeed } from './components/MessagesFeed';
import { UbtLockCard } from './components/UbtLockCard';
import { useHealth } from './hooks/useHealth';
import { useAgents } from './hooks/useAgents';
import { useTasks } from './hooks/useTasks';
import { useMessages } from './hooks/useMessages';
import { useUbtStatus } from './hooks/useUbtStatus';

export default function App() {
  const [intervalMs, setIntervalMs] = useState(5000);
  const [taskFilter, setTaskFilter] = useState('');
  const [msgChannel, setMsgChannel] = useState('general');

  const health = useHealth(intervalMs);
  const agents = useAgents(intervalMs);
  const tasks = useTasks(intervalMs, taskFilter || undefined);
  const ubt = useUbtStatus(intervalMs);
  const messages = useMessages(msgChannel, intervalMs);

  return (
    <AppShell header={{ height: 50 }} padding="md">
      <AppShell.Header>
        <HealthBar
          health={health.data}
          error={health.error}
          intervalMs={intervalMs}
          onIntervalChange={setIntervalMs}
        />
      </AppShell.Header>

      <AppShell.Main>
        <Tabs defaultValue="overview">
          <Tabs.List mb="md">
            <Tabs.Tab value="overview" leftSection={<IconLayoutDashboard size={16} />}>
              Overview
            </Tabs.Tab>
            <Tabs.Tab value="messages" leftSection={<IconMessage size={16} />}>
              Messages
            </Tabs.Tab>
          </Tabs.List>

          <Tabs.Panel value="overview">
            <Grid>
              <Grid.Col span={8}>
                <Card withBorder p="sm">
                  <Title order={5} mb="sm">Tasks</Title>
                  <TasksPanel
                    tasks={tasks.data}
                    statusFilter={taskFilter}
                    onFilterChange={setTaskFilter}
                    onMutate={tasks.refresh}
                  />
                </Card>
              </Grid.Col>
              <Grid.Col span={4}>
                <Stack gap="md">
                  <Card withBorder p="sm">
                    <Title order={5} mb="sm">Agents</Title>
                    <AgentsPanel agents={agents.data} onMutate={agents.refresh} />
                  </Card>
                  <UbtLockCard status={ubt.data} />
                </Stack>
              </Grid.Col>
            </Grid>
          </Tabs.Panel>

          <Tabs.Panel value="messages">
            <MessagesFeed
              messages={messages.messages}
              loading={messages.loading}
              error={messages.error}
              channel={msgChannel}
              onChannelChange={setMsgChannel}
              agents={agents.data}
            />
          </Tabs.Panel>
        </Tabs>
      </AppShell.Main>
    </AppShell>
  );
}
