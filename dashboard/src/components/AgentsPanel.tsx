import { Table, ActionIcon, Text, Popover, Button, Group, Stack } from '@mantine/core';
import { IconTrash } from '@tabler/icons-react';
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { apiDelete } from '../api/client.ts';
import type { Agent } from '../api/types.ts';
import { StatusBadge } from './StatusBadge.tsx';
import { RelativeTime } from './RelativeTime.tsx';
import { useProject } from '../contexts/ProjectContext.tsx';

interface AgentsPanelProps {
  agents: Agent[] | null;
}

export function AgentsPanel({ agents }: AgentsPanelProps) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const { projectId } = useProject();

  const handleDelete = async (name: string) => {
    await apiDelete(`/agents/${encodeURIComponent(name)}`);
    setConfirming(null);
    await queryClient.invalidateQueries({ queryKey: ['agents'] });
  };

  if (!agents || agents.length === 0) {
    return <Text c="dimmed" ta="center" py="md" size="sm">No agents registered</Text>;
  }

  return (
    <Table striped highlightOnHover fz="sm">
      <Table.Thead>
        <Table.Tr>
          <Table.Th>Name</Table.Th>
          <Table.Th>Branch</Table.Th>
          <Table.Th>Status</Table.Th>
          <Table.Th>Registered</Table.Th>
          <Table.Th w={40} />
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {agents.map((a) => (
          <Table.Tr key={a.name}>
            <Table.Td fw={600}>
              <Link to="/$projectId/agents/$agentName" params={{ projectId, agentName: a.name }} style={{ textDecoration: 'none', color: 'inherit' }}>
                {a.name}
              </Link>
            </Table.Td>
            <Table.Td>
              <Text size="xs" c="dimmed">{a.worktree}</Text>
            </Table.Td>
            <Table.Td><StatusBadge value={a.status} /></Table.Td>
            <Table.Td><RelativeTime date={a.registeredAt} /></Table.Td>
            <Table.Td>
              <Popover
                opened={confirming === a.name}
                onChange={(opened) => !opened && setConfirming(null)}
                position="left"
                withArrow
              >
                <Popover.Target>
                  <ActionIcon
                    variant="subtle"
                    color="red"
                    size="sm"
                    onClick={() => setConfirming(a.name)}
                  >
                    <IconTrash size={14} />
                  </ActionIcon>
                </Popover.Target>
                <Popover.Dropdown>
                  <Stack gap="xs">
                    <Text size="sm">Stop and deregister {a.name}? This will signal the container to shut down.</Text>
                    <Group gap="xs">
                      <Button size="xs" color="red" onClick={() => handleDelete(a.name)}>
                        Stop agent
                      </Button>
                      <Button size="xs" variant="default" onClick={() => setConfirming(null)}>
                        No
                      </Button>
                    </Group>
                  </Stack>
                </Popover.Dropdown>
              </Popover>
            </Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}
