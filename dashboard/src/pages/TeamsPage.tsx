import { useState } from 'react';
import { Title, Stack, Card, Group, Text, Select } from '@mantine/core';
import { useTeams } from '../hooks/useTeams.ts';
import { useTeamDetail } from '../hooks/useTeamDetail.ts';
import { StatusBadge } from '../components/StatusBadge.tsx';
import { TeamCard } from '../components/TeamCard.tsx';

function TeamDetailPanel({ teamId }: { teamId: string }) {
  const { data: team } = useTeamDetail(teamId);
  if (!team) return <Text c="dimmed" size="sm">Loading...</Text>;
  return <TeamCard team={team} />;
}

export function TeamsPage() {
  const { data: teams } = useTeams();
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [expandedTeamId, setExpandedTeamId] = useState<string | null>(null);

  const teamList = teams ?? [];
  const filtered = statusFilter
    ? teamList.filter((t) => t.status === statusFilter)
    : teamList;

  return (
    <>
      <Title order={4} mb="md">Teams</Title>
      <Select
        placeholder="Filter by status"
        clearable
        mb="md"
        w={200}
        value={statusFilter}
        onChange={setStatusFilter}
        data={[
          { value: 'active', label: 'Active' },
          { value: 'converging', label: 'Converging' },
          { value: 'dissolved', label: 'Dissolved' },
        ]}
      />
      {filtered.length === 0 ? (
        <Text c="dimmed">No teams</Text>
      ) : (
        <Stack gap="md">
          {filtered.map((team) => (
            <div key={team.id}>
              <Card
                withBorder
                p="xs"
                style={{ cursor: 'pointer' }}
                onClick={() => setExpandedTeamId(expandedTeamId === team.id ? null : team.id)}
              >
                <Group justify="space-between">
                  <Text fw={600}>{team.name}</Text>
                  <StatusBadge value={team.status} />
                </Group>
              </Card>
              {expandedTeamId === team.id && <TeamDetailPanel teamId={team.id} />}
            </div>
          ))}
        </Stack>
      )}
    </>
  );
}
