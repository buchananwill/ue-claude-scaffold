import {
  Table,
  SegmentedControl,
  Button,
  Collapse,
  Text,
  Code,
  Stack,
  Group,
  ActionIcon,
  Popover,
  Checkbox,
  Anchor,
  Badge,
} from '@mantine/core';
import {
  IconChevronUp,
  IconChevronDown,
  IconSelector,
  IconFilter,
  IconTrash,
} from '@tabler/icons-react';
import { Fragment, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { apiPost, apiDelete } from '../api/client.ts';
import { notifications } from '@mantine/notifications';
import type { Task } from '../api/types.ts';
import type { TaskFilters } from '../hooks/useTaskFilters.ts';
import { UNASSIGNED } from '../hooks/useTaskFilters.ts';
import type { SortColumn } from '../hooks/useTaskFilters.ts';
import { StatusBadge } from './StatusBadge.tsx';
import { RelativeTime } from './RelativeTime.tsx';

const statusFilters = [
  { label: 'All', value: '' },
  { label: 'Pending', value: 'pending' },
  { label: 'Claimed', value: 'claimed' },
  { label: 'In Progress', value: 'in_progress' },
  { label: 'Completed', value: 'completed' },
  { label: 'Failed', value: 'failed' },
];

interface TasksPanelProps {
  tasks: Task[] | null;
  isFetching: boolean;
  statusFilter: string;
  onFilterChange: (f: string) => void;
  filters: TaskFilters;
}

function SortHeader({
  label,
  column,
  activeColumn,
  dir,
  onSort,
}: {
  label: string;
  column: NonNullable<SortColumn>;
  activeColumn: SortColumn;
  dir: 'asc' | 'desc';
  onSort: (col: NonNullable<SortColumn>) => void;
}) {
  const isActive = activeColumn === column;
  let icon = <IconSelector size={14} />;
  if (isActive && dir === 'asc') icon = <IconChevronUp size={14} />;
  if (isActive && dir === 'desc') icon = <IconChevronDown size={14} />;

  return (
    <Group
      gap={2}
      onClick={() => onSort(column)}
      style={{ cursor: 'pointer', userSelect: 'none', display: 'inline-flex' }}
    >
      <Text size="sm" fw={500}>{label}</Text>
      {icon}
    </Group>
  );
}

export function TasksPanel({ tasks, isFetching, statusFilter, onFilterChange, filters }: TasksPanelProps) {
  const [expanded, setExpanded] = useState<number | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<number | null>(null);
  const [confirmingBulk, setConfirmingBulk] = useState(false);
  const [bulkDeleteTargets, setBulkDeleteTargets] = useState<Task[]>([]);
  const queryClient = useQueryClient();

  const {
    displayedTasks,
    sortColumn,
    sortDir,
    agentFilter,
    priorityFilter,
    cycleSort,
    setAgentFilter,
    setPriorityFilter,
    clearAllFilters,
    hasActiveFilters,
    uniqueAgents,
    uniquePriorities,
  } = filters;

  const handleRelease = async (id: number) => {
    try {
      await apiPost(`/tasks/${id}/release`);
      await queryClient.invalidateQueries({ queryKey: ['tasks'] });
      notifications.show({ title: 'Released', message: `Task #${id} returned to pending`, color: 'green' });
    } catch (err) {
      notifications.show({ title: 'Error', message: err instanceof Error ? err.message : String(err), color: 'red' });
    }
  };

  const handleDelete = async (id: number) => {
    try {
      await apiDelete(`/tasks/${id}`);
      setConfirmingDelete(null);
      await queryClient.invalidateQueries({ queryKey: ['tasks'] });
      notifications.show({ title: 'Deleted', message: `Task #${id} deleted`, color: 'green' });
    } catch (err) {
      notifications.show({ title: 'Error', message: err instanceof Error ? err.message : String(err), color: 'red' });
    }
  };

  const handleBulkDelete = async () => {
    const results = await Promise.allSettled(
      bulkDeleteTargets.map((t) => apiDelete(`/tasks/${t.id}`)),
    );
    setBulkDeleteTargets([]);
    setConfirmingBulk(false);
    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.filter((r) => r.status === 'rejected').length;
    await queryClient.invalidateQueries({ queryKey: ['tasks'] });
    if (succeeded > 0) {
      notifications.show({
        title: 'Deleted',
        message: `${succeeded} task(s) deleted`,
        color: 'green',
      });
    }
    if (failed > 0) {
      notifications.show({
        title: 'Warning',
        message: `${failed} task(s) failed to delete`,
        color: 'orange',
      });
    }
  };

  const bulkDeletable = displayedTasks.filter((t) => t.status === statusFilter);
  const showBulkDelete = (statusFilter === 'completed' || statusFilter === 'failed' || statusFilter === 'pending') && bulkDeletable.length > 0;

  return (
    <Stack gap="sm">
      <Group justify="space-between" align="center">
        <SegmentedControl
          size="xs"
          data={statusFilters}
          value={statusFilter}
          onChange={onFilterChange}
        />
        <Group gap="xs">
          {hasActiveFilters && (
            <Anchor size="xs" onClick={clearAllFilters}>Clear all filters</Anchor>
          )}
          {showBulkDelete && (
            <Popover
              opened={confirmingBulk}
              onChange={(opened) => { if (!opened) { setBulkDeleteTargets([]); setConfirmingBulk(false); } }}
              position="bottom"
              withArrow
              width={320}
            >
              <Popover.Target>
                <Button size="compact-xs" variant="light" color="red" onClick={() => { setBulkDeleteTargets(bulkDeletable); setConfirmingBulk(true); }}>
                  Delete {bulkDeletable.length} {statusFilter} task{bulkDeletable.length !== 1 ? 's' : ''}
                </Button>
              </Popover.Target>
              <Popover.Dropdown>
                <Stack gap="xs">
                  <Text size="sm" fw={500}>
                    Delete {bulkDeleteTargets.length} {statusFilter} task{bulkDeleteTargets.length !== 1 ? 's' : ''}?
                  </Text>
                  <Stack
                    gap={2}
                    style={{ maxHeight: 160, overflowY: 'auto' }}
                  >
                    {bulkDeleteTargets.map((t) => (
                      <Text key={t.id} size="xs" c="dimmed" truncate>
                        #{t.id} {t.title}
                      </Text>
                    ))}
                  </Stack>
                  <Group gap="xs">
                    <Button size="xs" color="red" onClick={handleBulkDelete}>Yes</Button>
                    <Button size="xs" variant="default" onClick={() => { setBulkDeleteTargets([]); setConfirmingBulk(false); }}>No</Button>
                  </Group>
                </Stack>
              </Popover.Dropdown>
            </Popover>
          )}
        </Group>
      </Group>

      {(!tasks || tasks.length === 0) ? (
        <Text c="dimmed" ta="center" py="md" size="sm">No tasks</Text>
      ) : (
        <Table striped highlightOnHover fz="sm" style={{ opacity: isFetching ? 0.7 : 1, transition: 'opacity 150ms' }}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th w={40}>
                <SortHeader label="#" column="id" activeColumn={sortColumn} dir={sortDir} onSort={cycleSort} />
              </Table.Th>
              <Table.Th w={40}>
                <Group gap={4} wrap="nowrap">
                  <SortHeader label="Pri" column="priority" activeColumn={sortColumn} dir={sortDir} onSort={cycleSort} />
                  <Popover position="bottom" withArrow>
                    <Popover.Target>
                      <ActionIcon variant="subtle" size="xs" color={priorityFilter.size > 0 ? 'blue' : 'gray'}>
                        {priorityFilter.size > 0
                          ? <Badge size="xs" circle>{priorityFilter.size}</Badge>
                          : <IconFilter size={12} />}
                      </ActionIcon>
                    </Popover.Target>
                    <Popover.Dropdown>
                      <Checkbox.Group
                        value={Array.from(priorityFilter).map(String)}
                        onChange={(vals: string[]) => setPriorityFilter(new Set(vals.map(Number)))}
                      >
                        <Stack gap="xs">
                          {uniquePriorities.map((p) => (
                            <Checkbox key={p} value={String(p)} label={`Priority ${p}`} size="xs" />
                          ))}
                        </Stack>
                      </Checkbox.Group>
                    </Popover.Dropdown>
                  </Popover>
                </Group>
              </Table.Th>
              <Table.Th w={100}>
                <SortHeader label="Status" column="status" activeColumn={sortColumn} dir={sortDir} onSort={cycleSort} />
              </Table.Th>
              <Table.Th>
                <SortHeader label="Title" column="title" activeColumn={sortColumn} dir={sortDir} onSort={cycleSort} />
              </Table.Th>
              <Table.Th>
                <Group gap={4} wrap="nowrap">
                  <SortHeader label="Agent" column="claimedBy" activeColumn={sortColumn} dir={sortDir} onSort={cycleSort} />
                  <Popover position="bottom" withArrow>
                    <Popover.Target>
                      <ActionIcon variant="subtle" size="xs" color={agentFilter.size > 0 ? 'blue' : 'gray'}>
                        {agentFilter.size > 0
                          ? <Badge size="xs" circle>{agentFilter.size}</Badge>
                          : <IconFilter size={12} />}
                      </ActionIcon>
                    </Popover.Target>
                    <Popover.Dropdown>
                      <Checkbox.Group
                        value={Array.from(agentFilter)}
                        onChange={(vals: string[]) => setAgentFilter(new Set(vals))}
                      >
                        <Stack gap="xs">
                          {uniqueAgents.map((a) => (
                            <Checkbox
                              key={a}
                              value={a}
                              label={a === UNASSIGNED ? 'Unassigned' : a}
                              size="xs"
                            />
                          ))}
                        </Stack>
                      </Checkbox.Group>
                    </Popover.Dropdown>
                  </Popover>
                </Group>
              </Table.Th>
              <Table.Th>
                <SortHeader label="Created" column="createdAt" activeColumn={sortColumn} dir={sortDir} onSort={cycleSort} />
              </Table.Th>
              <Table.Th w={80} />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {displayedTasks.map((t) => (
              <Fragment key={t.id}>
                <Table.Tr
                  onClick={() => setExpanded(expanded === t.id ? null : t.id)}
                  style={{ cursor: 'pointer' }}
                >
                  <Table.Td>{t.id}</Table.Td>
                  <Table.Td>{t.priority}</Table.Td>
                  <Table.Td><StatusBadge value={t.status} /></Table.Td>
                  <Table.Td fw={500}>{t.title}</Table.Td>
                  <Table.Td>
                    <Text size="xs" c="dimmed">{t.claimedBy ?? '\u2014'}</Text>
                  </Table.Td>
                  <Table.Td><RelativeTime date={t.createdAt} /></Table.Td>
                  <Table.Td>
                    <Group gap={4} wrap="nowrap">
                      {(t.status === 'claimed' || t.status === 'in_progress') && (
                        <Button
                          size="compact-xs"
                          variant="light"
                          color="orange"
                          onClick={(e) => { e.stopPropagation(); handleRelease(t.id); }}
                        >
                          Release
                        </Button>
                      )}
                      {t.status !== 'claimed' && t.status !== 'in_progress' && (
                        <Popover
                          opened={confirmingDelete === t.id}
                          onChange={(opened) => !opened && setConfirmingDelete(null)}
                          position="left"
                          withArrow
                        >
                          <Popover.Target>
                            <ActionIcon
                              variant="subtle"
                              color="red"
                              size="sm"
                              onClick={(e) => { e.stopPropagation(); setConfirmingDelete(t.id); }}
                            >
                              <IconTrash size={14} />
                            </ActionIcon>
                          </Popover.Target>
                          <Popover.Dropdown>
                            <Stack gap="xs">
                              <Text size="sm">Delete task #{t.id}?</Text>
                              <Group gap="xs">
                                <Button size="xs" color="red" onClick={(e) => { e.stopPropagation(); handleDelete(t.id); }}>
                                  Yes
                                </Button>
                                <Button size="xs" variant="default" onClick={(e) => { e.stopPropagation(); setConfirmingDelete(null); }}>
                                  No
                                </Button>
                              </Group>
                            </Stack>
                          </Popover.Dropdown>
                        </Popover>
                      )}
                    </Group>
                  </Table.Td>
                </Table.Tr>
                {expanded === t.id && (
                  <Table.Tr>
                    <Table.Td colSpan={7}>
                      <Collapse in={expanded === t.id}>
                        <Stack gap="xs" p="sm">
                          {t.description && (
                            <div>
                              <Text size="xs" fw={600} c="dimmed">Description</Text>
                              <Text size="sm">{t.description}</Text>
                            </div>
                          )}
                          {t.acceptanceCriteria && (
                            <div>
                              <Text size="xs" fw={600} c="dimmed">Acceptance Criteria</Text>
                              <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>{t.acceptanceCriteria}</Text>
                            </div>
                          )}
                          {t.progressLog && (
                            <div>
                              <Text size="xs" fw={600} c="dimmed">Progress Log</Text>
                              <Code block>{t.progressLog}</Code>
                            </div>
                          )}
                          {t.result != null && (
                            <div>
                              <Text size="xs" fw={600} c="dimmed">Result</Text>
                              <Code block>{JSON.stringify(t.result, null, 2)}</Code>
                            </div>
                          )}
                          <Group gap="xs">
                            {t.claimedAt && (
                              <Text size="xs" c="dimmed">Claimed: <RelativeTime date={t.claimedAt} /></Text>
                            )}
                            {t.completedAt && (
                              <Text size="xs" c="dimmed">Completed: <RelativeTime date={t.completedAt} /></Text>
                            )}
                          </Group>
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
