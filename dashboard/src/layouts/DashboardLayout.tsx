import { AppShell, Group, NavLink } from '@mantine/core';
import { IconLayoutDashboard, IconMessage, IconList, IconMessageCircle, IconUsersGroup } from '@tabler/icons-react';
import { Outlet, Link, useMatches } from '@tanstack/react-router';
import { HealthBar } from '../components/HealthBar.tsx';
import { useHealth } from '../hooks/useHealth.ts';
import { usePollInterval } from '../hooks/usePollInterval.tsx';
import { SearchBar } from '../components/SearchBar.tsx';

export function DashboardLayout() {
  const { intervalMs, setIntervalMs } = usePollInterval();
  const health = useHealth();
  const matches = useMatches();

  const currentPath = matches[matches.length - 1]?.pathname ?? '/';
  const isMessages = currentPath.startsWith('/messages');
  const isLogs = currentPath === '/logs';
  const isChat = currentPath.startsWith('/chat');
  const isTeams = currentPath.startsWith('/teams');

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
        <Group gap="xs" mb="md">
          <NavLink
            component={Link}
            to="/"
            label="Overview"
            leftSection={<IconLayoutDashboard size={16} />}
            active={currentPath === '/'}
            style={{ borderRadius: 'var(--mantine-radius-sm)', flex: 'none', width: 'auto' }}
            px="md"
          />
          <NavLink
            component={Link}
            to="/messages/$channel"
            {...{ params: { channel: 'general' } } as any}
            label="Messages"
            leftSection={<IconMessage size={16} />}
            active={isMessages}
            style={{ borderRadius: 'var(--mantine-radius-sm)', flex: 'none', width: 'auto' }}
            px="md"
          />
          <NavLink
            component={Link}
            to="/logs"
            label="Logs"
            leftSection={<IconList size={16} />}
            active={isLogs}
            style={{ borderRadius: 'var(--mantine-radius-sm)', flex: 'none', width: 'auto' }}
            px="md"
          />
          <NavLink
            component={Link}
            to="/chat"
            label="Chat"
            leftSection={<IconMessageCircle size={16} />}
            active={isChat}
            style={{ borderRadius: 'var(--mantine-radius-sm)', flex: 'none', width: 'auto' }}
            px="md"
          />
          <NavLink
            component={Link}
            to="/teams"
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
