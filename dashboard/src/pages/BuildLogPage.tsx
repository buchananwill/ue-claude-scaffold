import {
  Table,
  SegmentedControl,
  Select,
  Text,
  Code,
  Stack,
  Group,
  Collapse,
  Loader,
} from '@mantine/core';
import { IconCheck, IconX, IconChevronDown, IconChevronRight } from '@tabler/icons-react';
import { Fragment, useState, useMemo } from 'react';
import { useSearch, useNavigate } from '@tanstack/react-router';
import { useBuildHistory } from '../hooks/useBuildHistory.ts';
import { useAgents } from '../hooks/useAgents.ts';
import { RelativeTime } from '../components/RelativeTime.tsx';
import type { BuildRecord } from '../api/types.ts';

function formatDuration(ms: number | null): string {
  if (ms === null) return '\u2014';
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}m ${sec}s`;
}

function ResultIcon({ success }: { success: boolean | null }) {
  if (success === null) return <Text c="dimmed">{'\u2014'}</Text>;
  if (success) return <IconCheck size={16} color="var(--mantine-color-green-6)" />;
  return <IconX size={16} color="var(--mantine-color-red-6)" />;
}

export function BuildLogPage() {
  const search = useSearch({ from: '/$projectId/logs' });
  const navigate = useNavigate({ from: '/$projectId/logs' });

  const agentFilter = search.agent ?? '';
  const typeFilter = search.type ?? '';
  const successFilter = search.result ?? '';

  const setAgentFilter = (v: string) => {
    navigate({ search: (prev) => ({ ...prev, agent: v || undefined }) });
  };
  const setTypeFilter = (v: string) => {
    navigate({ search: (prev) => ({ ...prev, type: v || undefined }) });
  };
  const setSuccessFilter = (v: string) => {
    navigate({ search: (prev) => ({ ...prev, result: v || undefined }) });
  };

  const [expanded, setExpanded] = useState<number | null>(null);

  const agents = useAgents();
  const builds = useBuildHistory(
    agentFilter || undefined,
    typeFilter || undefined,
  );

  const agentOptions = useMemo(() => {
    const items: { value: string; label: string }[] = [{ value: '', label: 'All' }];
    if (agents.data) {
      for (const a of agents.data) {
        items.push({ value: a.name, label: a.name });
      }
    }
    return items;
  }, [agents.data]);

  const filteredRecords = useMemo(() => {
    const data = builds.data ?? [];
    if (!successFilter) return data;
    return data.filter((r: BuildRecord) => {
      if (successFilter === 'pass') return r.success === true;
      if (successFilter === 'fail') return r.success === false;
      return true;
    });
  }, [builds.data, successFilter]);

  if (builds.isLoading) {
    return (
      <Group justify="center" py="xl">
        <Loader size="sm" />
        <Text size="sm" c="dimmed">Loading build history...</Text>
      </Group>
    );
  }

  if (builds.error) {
    return (
      <Text c="red" ta="center" py="md">
        Error loading builds: {builds.error instanceof Error ? builds.error.message : String(builds.error)}
      </Text>
    );
  }

  return (
    <Stack gap="sm">
      <Group gap="md" align="flex-end">
        <Select
          label="Agent"
          size="xs"
          data={agentOptions}
          value={agentFilter}
          onChange={(v) => setAgentFilter(v ?? '')}
          style={{ width: 180 }}
        />
        <div>
          <Text size="xs" fw={500} mb={4}>Type</Text>
          <SegmentedControl
            size="xs"
            data={[
              { label: 'All', value: '' },
              { label: 'Build', value: 'build' },
              { label: 'Test', value: 'test' },
            ]}
            value={typeFilter}
            onChange={setTypeFilter}
          />
        </div>
        <div>
          <Text size="xs" fw={500} mb={4}>Result</Text>
          <SegmentedControl
            size="xs"
            data={[
              { label: 'All', value: '' },
              { label: 'Pass', value: 'pass' },
              { label: 'Fail', value: 'fail' },
            ]}
            value={successFilter}
            onChange={setSuccessFilter}
          />
        </div>
      </Group>

      {filteredRecords.length === 0 ? (
        <Text c="dimmed" ta="center" py="md" size="sm">No build records</Text>
      ) : (
        <Table striped highlightOnHover fz="sm" style={{ opacity: builds.isFetching ? 0.7 : 1, transition: 'opacity 150ms' }}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th w={30} />
              <Table.Th>Agent</Table.Th>
              <Table.Th>Type</Table.Th>
              <Table.Th>Started</Table.Th>
              <Table.Th>Duration</Table.Th>
              <Table.Th>Result</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {filteredRecords.map((r) => (
              <Fragment key={r.id}>
                <Table.Tr
                  onClick={() => setExpanded(expanded === r.id ? null : r.id)}
                  style={{ cursor: 'pointer' }}
                >
                  <Table.Td>
                    {expanded === r.id
                      ? <IconChevronDown size={14} />
                      : <IconChevronRight size={14} />}
                  </Table.Td>
                  <Table.Td>{r.agent}</Table.Td>
                  <Table.Td>{r.type}</Table.Td>
                  <Table.Td><RelativeTime date={r.startedAt} /></Table.Td>
                  <Table.Td>{formatDuration(r.durationMs)}</Table.Td>
                  <Table.Td><ResultIcon success={r.success} /></Table.Td>
                </Table.Tr>
                {expanded === r.id && (
                  <Table.Tr>
                    <Table.Td colSpan={6}>
                      <Collapse in={expanded === r.id}>
                        <Stack gap="xs" p="sm">
                          <div>
                            <Text size="xs" fw={600} c="dimmed">stdout</Text>
                            {r.output != null ? (
                              <Code block>{r.output}</Code>
                            ) : (
                              <Text size="sm" fs="italic" c="dimmed">(not recorded)</Text>
                            )}
                          </div>
                          <div>
                            <Text size="xs" fw={600} c="dimmed">stderr</Text>
                            {r.stderr != null ? (
                              <Code block>{r.stderr}</Code>
                            ) : (
                              <Text size="sm" fs="italic" c="dimmed">(not recorded)</Text>
                            )}
                          </div>
                        </Stack>
                      </Collapse>
                    </Table.Td>
                  </Table.Tr>
                )}
              </Fragment>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Stack>
  );
}
