import { AppShell, Group, NavLink } from '@mantine/core';
import { IconLayoutDashboard, IconMessage } from '@tabler/icons-react';
import { Outlet, useRouter, useMatches } from '@tanstack/react-router';
import { HealthBar } from '../components/HealthBar.tsx';
import { useHealth } from '../hooks/useHealth.ts';
import { usePollInterval } from '../hooks/usePollInterval.tsx';

export function DashboardLayout() {
  const { intervalMs, setIntervalMs } = usePollInterval();
  const health = useHealth();
  const router = useRouter();
  const matches = useMatches();

  const currentPath = matches[matches.length - 1]?.pathname ?? '/';
  const isMessages = currentPath.startsWith('/messages');

  return (
    <AppShell header={{ height: 50 }} padding="md">
      <AppShell.Header>
        <HealthBar
          health={health.data ?? null}
          error={health.error ? String(health.error) : null}
          intervalMs={intervalMs}
          onIntervalChange={setIntervalMs}
        />
      </AppShell.Header>

      <AppShell.Main>
        <Group gap="xs" mb="md">
          <NavLink
            label="Overview"
            leftSection={<IconLayoutDashboard size={16} />}
            active={currentPath === '/'}
            onClick={() => router.navigate({ to: '/' })}
            style={{ borderRadius: 'var(--mantine-radius-sm)', flex: 'none', width: 'auto' }}
            px="md"
          />
          <NavLink
            label="Messages"
            leftSection={<IconMessage size={16} />}
            active={isMessages}
            onClick={() => router.navigate({ to: '/messages/$channel', params: { channel: 'general' } })}
            style={{ borderRadius: 'var(--mantine-radius-sm)', flex: 'none', width: 'auto' }}
            px="md"
          />
        </Group>
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}
