import { AppShell, Group, NavLink } from '@mantine/core';
import { IconLayoutDashboard, IconMessage, IconList, IconMessageCircle, IconUsersGroup } from '@tabler/icons-react';
import { Outlet, Link, useMatches } from '@tanstack/react-router';
import { HealthBar } from '../components/HealthBar.tsx';
import { useHealth } from '../hooks/useHealth.ts';
import { usePollInterval } from '../hooks/usePollInterval.tsx';
import { SearchBar } from '../components/SearchBar.tsx';
import { useProject } from '../contexts/ProjectContext.tsx';

export function DashboardLayout() {
  const { intervalMs, setIntervalMs } = usePollInterval();
  const health = useHealth();
  const matches = useMatches();
  const { projectId } = useProject();

  const currentPath = matches[matches.length - 1]?.pathname ?? '/';
  const projectPrefix = `/${projectId}`;
  const relativePath = currentPath.startsWith(projectPrefix)
    ? currentPath.slice(projectPrefix.length) || '/'
    : currentPath;
  const isMessages = relativePath.startsWith('/messages');
  const isLogs = relativePath === '/logs';
  const isChat = relativePath.startsWith('/chat');
  const isTeams = relativePath.startsWith('/teams');

  return (
    <AppShell header={{ height: 50 }} padding="md">
      <AppShell.Header>
        <HealthBar
          health={health.data ?? null}
          error={health.error ? String(health.error) : null}
          intervalMs={intervalMs}
          onIntervalChange={setIntervalMs}
          middle={<SearchBar />}
        />
      </AppShell.Header>

      <AppShell.Main>
        {/* TanStack Router's NavLink+Link composition doesn't infer params types
           for project-scoped routes; `as any` casts work around this limitation. */}
        <Group gap="xs" mb="md">
          <NavLink
            component={Link}
            to="/$projectId"
            {...{ params: { projectId } } as any}
            label="Overview"
            leftSection={<IconLayoutDashboard size={16} />}
            active={relativePath === '/'}
            style={{ borderRadius: 'var(--mantine-radius-sm)', flex: 'none', width: 'auto' }}
            px="md"
          />
          <NavLink
            component={Link}
            to="/$projectId/messages/$channel"
            {...{ params: { projectId, channel: 'general' } } as any}
            label="Messages"
            leftSection={<IconMessage size={16} />}
            active={isMessages}
            style={{ borderRadius: 'var(--mantine-radius-sm)', flex: 'none', width: 'auto' }}
            px="md"
          />
          <NavLink
            component={Link}
            to="/$projectId/logs"
            {...{ params: { projectId } } as any}
            label="Logs"
            leftSection={<IconList size={16} />}
            active={isLogs}
            style={{ borderRadius: 'var(--mantine-radius-sm)', flex: 'none', width: 'auto' }}
            px="md"
          />
          <NavLink
            component={Link}
            to="/$projectId/chat"
            {...{ params: { projectId } } as any}
            label="Chat"
            leftSection={<IconMessageCircle size={16} />}
            active={isChat}
            style={{ borderRadius: 'var(--mantine-radius-sm)', flex: 'none', width: 'auto' }}
            px="md"
          />
          <NavLink
            component={Link}
            to="/$projectId/teams"
            {...{ params: { projectId } } as any}
            label="Teams"
            leftSection={<IconUsersGroup size={16} />}
            active={isTeams}
            style={{ borderRadius: 'var(--mantine-radius-sm)', flex: 'none', width: 'auto' }}
            px="md"
          />
        </Group>
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}
