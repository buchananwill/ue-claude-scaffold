import {
  Table,
  Chip,
  Button,
  Text,
  Stack,
  Group,
  ActionIcon,
  Popover,
  Checkbox,
  Anchor,
  Badge,
  Tooltip,
} from '@mantine/core';
import {
  IconFilter,
  IconTrash,
} from '@tabler/icons-react';
import { Fragment, useState } from 'react';
import { Link } from '@tanstack/react-router';
import type { Task } from '../api/types.ts';
import type { TaskFilters } from '../hooks/useTaskFilters.ts';
import { useProject } from '../contexts/ProjectContext.tsx';
import { UNASSIGNED, TASK_STATUSES } from '../hooks/useTaskFilters.ts';
import { useTaskActions } from '../hooks/useTaskActions.ts';
import { SortHeader } from './SortHeader.tsx';
import { StatusBadge } from './StatusBadge.tsx';
import { RelativeTime } from './RelativeTime.tsx';
import { TaskDetailRow } from './TaskDetailRow.tsx';
import { TaskDuration } from './TaskDuration.tsx';

const STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  claimed: 'Claimed',
  in_progress: 'In Progress',
  completed: 'Completed',
  failed: 'Failed',
};

interface TasksPanelProps {
  tasks: Task[] | null;
  isFetching: boolean;
  filters: TaskFilters;
  excludeStatuses?: Set<string>;
}

export function TasksPanel({ tasks, isFetching, filters, excludeStatuses }: TasksPanelProps) {
  const { projectId } = useProject();
  const [expanded, setExpanded] = useState<number | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<number | null>(null);
  const [confirmingBulk, setConfirmingBulk] = useState(false);
  const [bulkDeleteTargets, setBulkDeleteTargets] = useState<Task[]>([]);

  const { handleRelease, handleDelete, handleBulkDelete } = useTaskActions({
    setConfirmingDelete,
    setBulkDeleteTargets,
    setConfirmingBulk,
    bulkDeleteTargets,
  });

  const {
    displayedTasks,
    sortColumn,
    sortDir,
    agentFilter,
    priorityFilter,
    statusFilter,
    setStatusFilter,
    cycleSort,
    setAgentFilter,
    setPriorityFilter,
    clearAllFilters,
    hasActiveFilters,
    uniqueAgents,
    uniquePriorities,
  } = filters;

  const deletableStatuses = new Set(['completed', 'failed', 'pending']);
  const bulkDeletable = displayedTasks.filter((t) => deletableStatuses.has(t.status));
  const showBulkDelete = bulkDeletable.length > 0;
  const bulkDeletableStatusSet = new Set(bulkDeletable.map((t) => t.status));
  const singleDeletableStatus = bulkDeletableStatusSet.size === 1 ? Array.from(bulkDeletableStatusSet)[0] : null;

  return (
    <Stack gap="sm">
      <Group justify="space-between" align="center">
        <Chip.Group
          multiple
          value={Array.from(statusFilter)}
          onChange={(vals: string[]) => setStatusFilter(new Set(vals))}
        >
          <Group gap="xs">
            {TASK_STATUSES.filter((s) => !excludeStatuses?.has(s)).map((s) => (
              <Chip key={s} size="xs" value={s}>{STATUS_LABELS[s] ?? s}</Chip>
            ))}
          </Group>
        </Chip.Group>
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
                  Delete {bulkDeletable.length}{singleDeletableStatus ? ` ${singleDeletableStatus}` : ' deletable'} task{bulkDeletable.length !== 1 ? 's' : ''}
                </Button>
              </Popover.Target>
              <Popover.Dropdown>
                <Stack gap="xs">
                  <Text size="sm" fw={500}>
                    Delete {bulkDeleteTargets.length}{singleDeletableStatus ? ` ${singleDeletableStatus}` : ' deletable'} task{bulkDeleteTargets.length !== 1 ? 's' : ''}?
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
      ) : displayedTasks.length === 0 ? (
        <Stack gap="xs" align="center" py="md">
          <Text c="dimmed" size="sm">No tasks match the current filters.</Text>
          {hasActiveFilters && (
            <Anchor size="sm" onClick={clearAllFilters}>Clear all filters</Anchor>
          )}
        </Stack>
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
              <Table.Th>Duration</Table.Th>
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
                  <Table.Td>
                    <Group gap={4} wrap="nowrap">
                      <StatusBadge value={t.status} />
                      {t.status === 'pending' && t.blockedBy && t.blockedBy.length > 0 && (
                        <Badge size="xs" color="orange" variant="dot">blocked</Badge>
                      )}
                      {t.status === 'pending' && t.blockReasons?.length > 0 && (
                        <Tooltip label={t.blockReasons.join('\n')} multiline maw={320} withArrow>
                          <Badge size="xs" color="red" variant="dot" style={{ cursor: 'default' }}>
                            warning
                          </Badge>
                        </Tooltip>
                      )}
                    </Group>
                  </Table.Td>
                  <Table.Td fw={500}>
                    <Link
                      to="/$projectId/tasks/$taskId"
                      params={{ projectId, taskId: String(t.id) }}
                      style={{ textDecoration: 'none', color: 'inherit', fontWeight: 500 }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {t.title}
                    </Link>
                  </Table.Td>
                  <Table.Td>
                    {t.claimedBy ? (
                      <Link
                        to="/$projectId/agents/$agentName"
                        params={{ projectId, agentName: t.claimedBy }}
                        style={{ textDecoration: 'none' }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <Text size="xs">{t.claimedBy}</Text>
                      </Link>
                    ) : (
                      <Text size="xs" c="dimmed">{'\u2014'}</Text>
                    )}
                  </Table.Td>
                  <Table.Td><RelativeTime date={t.createdAt} /></Table.Td>
                  <Table.Td><TaskDuration claimedAt={t.claimedAt} completedAt={t.completedAt} status={t.status} /></Table.Td>
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
                  <TaskDetailRow task={t} expanded={expanded === t.id} />
                )}
              </Fragment>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Stack>
  );
}
