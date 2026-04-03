import type { ReactNode } from 'react';
import { AppShell, Group, NavLink } from '@mantine/core';
import { IconLayoutDashboard, IconMessage, IconList, IconMessageCircle, IconUsersGroup } from '@tabler/icons-react';
import { Outlet, Link, useMatches } from '@tanstack/react-router';
import { HealthBar } from '../components/HealthBar.tsx';
import { useHealth } from '../hooks/useHealth.ts';
import { usePollInterval } from '../hooks/usePollInterval.tsx';
import { SearchBar } from '../components/SearchBar.tsx';
import { useProject } from '../contexts/ProjectContext.tsx';

interface NavItem {
  to: string;
  params: Record<string, string>;
  label: string;
  icon: ReactNode;
  isActive: (relativePath: string) => boolean;
}

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

  const NAV_ITEMS: NavItem[] = [
    { to: '/$projectId', params: { projectId }, label: 'Overview', icon: <IconLayoutDashboard size={16} />, isActive: (p) => p === '/' },
    { to: '/$projectId/messages/$channel', params: { projectId, channel: 'general' }, label: 'Messages', icon: <IconMessage size={16} />, isActive: (p) => p.startsWith('/messages') },
    { to: '/$projectId/logs', params: { projectId }, label: 'Logs', icon: <IconList size={16} />, isActive: (p) => p === '/logs' },
    { to: '/$projectId/chat', params: { projectId }, label: 'Chat', icon: <IconMessageCircle size={16} />, isActive: (p) => p.startsWith('/chat') },
    { to: '/$projectId/teams', params: { projectId }, label: 'Teams', icon: <IconUsersGroup size={16} />, isActive: (p) => p.startsWith('/teams') },
  ];

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
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              component={Link}
              to={item.to}
              {...({ params: item.params } as unknown as Record<string, string>)}
              label={item.label}
              leftSection={item.icon}
              active={item.isActive(relativePath)}
              style={{ borderRadius: 'var(--mantine-radius-sm)', flex: 'none', width: 'auto' }}
              px="md"
            />
          ))}
        </Group>
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}
