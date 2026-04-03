import { Card, Group, Title, Text, Table, Badge, Button, Box } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { StatusBadge } from './StatusBadge.tsx';
import { RelativeTime } from './RelativeTime.tsx';
import type { TeamDetail } from '../api/types.ts';
import { useProject } from '../contexts/ProjectContext.tsx';

interface TeamCardProps {
  team: TeamDetail;
}

export function TeamCard({ team }: TeamCardProps) {
  const { projectId } = useProject();
  return (
    <Card withBorder p="sm">
      <Group justify="space-between" mb="xs">
        <Title order={5}>{team.name}</Title>
        <StatusBadge value={team.status} />
      </Group>
      {team.dissolvedAt && (
        <Text size="xs" c="dimmed">Dissolved <RelativeTime date={team.dissolvedAt} /></Text>
      )}
      <Text size="xs" c="dimmed">Created <RelativeTime date={team.createdAt} /></Text>
      {team.briefPath && (
        <Text size="xs" mt="xs">Brief path: {team.briefPath}</Text>
      )}
      <Table striped fz="sm" mt="sm">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Agent</Table.Th>
            <Table.Th>Role</Table.Th>
            <Table.Th>Leader</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {team.members.map((m) => (
            <Table.Tr key={m.agentName}>
              <Table.Td>{m.agentName}</Table.Td>
              <Table.Td>{m.role}</Table.Td>
              <Table.Td>
                {m.isLeader && <Badge size="xs" color="yellow">Discussion Leader</Badge>}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      <Button
        component={Link}
        to="/$projectId/chat"
        {...{ params: { projectId }, search: { room: team.id } } as any}
        variant="light"
        size="xs"
        mt="sm"
      >
        Open Chat Room
      </Button>
      {team.deliverable && (
        <>
          <Text size="sm" fw={600} mt="sm">Deliverable</Text>
          <Box p="sm" style={{ whiteSpace: 'pre-wrap', fontSize: 'var(--mantine-font-size-sm)', background: 'var(--mantine-color-dark-6)', borderRadius: 'var(--mantine-radius-sm)' }}>
            {team.deliverable}
          </Box>
        </>
      )}
    </Card>
  );
}
