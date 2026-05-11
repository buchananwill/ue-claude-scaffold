import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import {
  Accordion,
  Badge,
  Card,
  Grid,
  Group,
  Pagination,
  SegmentedControl,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import {
  fetchArbitrationPatterns,
  fetchFailureReasons,
  fetchFindings,
  fetchNotePatterns,
} from '../api/client.ts';
import { useProject } from '../contexts/ProjectContext.tsx';
import { usePollInterval } from '../hooks/usePollInterval.tsx';
import { RelativeTime } from '../components/RelativeTime.tsx';
import { QueryPanel } from '../components/QueryPanel.tsx';
import { FindingHighlightLink, TaskHighlightLink } from '../components/FindingLinks.tsx';
import { SEVERITY_COLORS } from '../constants/finding-styling.ts';
import {
  FAILURE_REASONS,
  type FailureReason,
  type FailureReasonPattern,
} from '../api/types.ts';

const PAGE_SIZE = 50;

/**
 * Failure reasons that warrant operator attention beyond the raw count. Under
 * the new FSM design (Plan: Durable Task FSM and Parallel Role Sessions),
 * `role_session_no_op` is the only clean-exit terminal failure path that does
 * NOT surface through the abnormal-exit circuit breaker — so a non-zero count
 * is the operator's only routine signal that this failure mode is firing.
 */
const FLAGGED_FAILURE_REASONS: ReadonlySet<FailureReason> = new Set<FailureReason>([
  'role_session_no_op',
]);

export function FindingsPage() {
  const { projectId } = useProject();
  const { intervalMs } = usePollInterval();
  const search = useSearch({ from: '/$projectId/findings' });
  const navigate = useNavigate({ from: '/$projectId/findings' });

  const severity = search.severity ?? 'BLOCKING';
  const reviewer = search.reviewer ?? '';
  const since = search.since ?? '';
  const page = search.page ?? 1;
  const offset = (page - 1) * PAGE_SIZE;
  // Optional finding-ID highlight (set by click-through Links from arbitration
  // rulings and NOTE-pattern example IDs). When the matching row is on the
  // current page, the table emphasises it; otherwise the operator lands on the
  // unfiltered findings list and can browse to it.
  const highlightFindingId = search.highlight ? Number(search.highlight) : null;

  const findings = useQuery({
    queryKey: ['findings', projectId, severity, reviewer, since, offset],
    queryFn: ({ signal }) =>
      fetchFindings(
        { severity, reviewer: reviewer || undefined, since: since || undefined, limit: PAGE_SIZE, offset },
        signal,
        projectId,
      ),
    refetchInterval: intervalMs,
    staleTime: 2000,
  });

  const notePatterns = useQuery({
    queryKey: ['findings/note-patterns', projectId, since],
    queryFn: ({ signal }) => fetchNotePatterns({ since: since || undefined, limit: 20 }, signal, projectId),
    refetchInterval: intervalMs,
    staleTime: 2000,
  });

  const arbitrationPatterns = useQuery({
    queryKey: ['arbitrations', projectId, since],
    queryFn: ({ signal }) => fetchArbitrationPatterns({ since: since || undefined }, signal, projectId),
    refetchInterval: intervalMs,
    staleTime: 2000,
  });

  const failureReasons = useQuery({
    queryKey: ['failures/reasons', projectId, since],
    queryFn: ({ signal }) => fetchFailureReasons({ since: since || undefined }, signal, projectId),
    refetchInterval: intervalMs,
    staleTime: 2000,
  });

  /**
   * Pad the server's failure-reason response so all six enum values appear in
   * the panel, sorted by count descending then by enum order for ties (the
   * server only returns rows with count > 0).
   */
  const paddedFailureReasons = useMemo<FailureReasonPattern[]>(() => {
    const seen = new Map<FailureReason, FailureReasonPattern>();
    for (const p of failureReasons.data?.patterns ?? []) {
      seen.set(p.failureReason, p);
    }
    const padded: FailureReasonPattern[] = FAILURE_REASONS.map((reason) => {
      const existing = seen.get(reason);
      if (existing) return existing;
      return { failureReason: reason, count: 0, exampleTaskIds: [] };
    });
    return padded.sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      // Stable secondary sort by enum order to keep the panel deterministic.
      return FAILURE_REASONS.indexOf(a.failureReason) - FAILURE_REASONS.indexOf(b.failureReason);
    });
  }, [failureReasons.data]);

  const totalPages = Math.max(1, Math.ceil((findings.data?.total ?? 0) / PAGE_SIZE));

  return (
    <Stack gap="md">
      <Title order={3}>Findings</Title>

      <Card withBorder p="sm">
        <Group gap="md" align="flex-end">
          <div>
            <Text size="xs" fw={500} mb={4}>Severity</Text>
            <SegmentedControl
              size="xs"
              data={[
                { label: 'BLOCKING', value: 'BLOCKING' },
                { label: 'NOTE', value: 'NOTE' },
              ]}
              value={severity}
              onChange={(v) => {
                navigate({ search: (prev) => ({ ...prev, severity: v as 'BLOCKING' | 'NOTE', page: undefined }) });
              }}
            />
          </div>
          <TextInput
            label="Reviewer role"
            placeholder="e.g. safety"
            size="xs"
            value={reviewer}
            onChange={(e) => {
              const v = e.currentTarget.value;
              navigate({ search: (prev) => ({ ...prev, reviewer: v || undefined, page: undefined }) });
            }}
            w={180}
          />
          <TextInput
            label="Since"
            placeholder="YYYY-MM-DD"
            size="xs"
            value={since}
            onChange={(e) => {
              const v = e.currentTarget.value;
              navigate({ search: (prev) => ({ ...prev, since: v || undefined, page: undefined }) });
            }}
            w={160}
          />
        </Group>
      </Card>

      <Grid>
        <Grid.Col span={{ base: 12, md: 7 }}>
          <Card withBorder p="sm">
            <Group justify="space-between" mb="xs">
              <Title order={5}>Recent {severity} findings</Title>
              <Text size="xs" c="dimmed">
                {findings.data ? `${findings.data.total} total` : ''}
              </Text>
            </Group>
            <FindingsTable
              loading={findings.isLoading}
              error={findings.error}
              projectId={projectId}
              rows={findings.data?.findings ?? []}
              highlightFindingId={highlightFindingId}
            />
            {totalPages > 1 && (
              <Group justify="center" mt="sm">
                <Pagination
                  total={totalPages}
                  value={page}
                  onChange={(p) => navigate({ search: (prev) => ({ ...prev, page: p === 1 ? undefined : p }) })}
                  size="sm"
                />
              </Group>
            )}
          </Card>
        </Grid.Col>

        <Grid.Col span={{ base: 12, md: 5 }}>
          <Stack gap="md">
            <Card withBorder p="sm">
              <Title order={5} mb="xs">NOTE patterns (30 days)</Title>
              <PatternList
                loading={notePatterns.isLoading}
                error={notePatterns.error}
                projectId={projectId}
                exampleKind="finding"
                items={notePatterns.data?.patterns.map((p) => ({
                  key: p.title,
                  label: p.title,
                  count: p.count,
                  examples: p.exampleFindingIds.map(String),
                })) ?? []}
                emptyText="No NOTE findings in the window."
              />
            </Card>

            <Card withBorder p="sm">
              <Title order={5} mb="xs">Arbitration patterns (30 days)</Title>
              <PatternList
                loading={arbitrationPatterns.isLoading}
                error={arbitrationPatterns.error}
                projectId={projectId}
                exampleKind="task"
                items={arbitrationPatterns.data?.patterns.map((p) => ({
                  key: `${p.trigger}::${p.ruling}`,
                  label: `${p.trigger} → ${p.ruling}`,
                  count: p.count,
                  examples: p.exampleTaskIds.map(String),
                })) ?? []}
                emptyText="No arbitrations in the window."
              />
            </Card>

            <Card withBorder p="sm">
              <Title order={5} mb="xs">Failure reasons (30 days)</Title>
              <FailureReasonsPanel
                loading={failureReasons.isLoading}
                error={failureReasons.error}
                projectId={projectId}
                rows={paddedFailureReasons}
              />
            </Card>
          </Stack>
        </Grid.Col>
      </Grid>
    </Stack>
  );
}

interface FindingsTableProps {
  loading: boolean;
  error: unknown;
  projectId: string;
  rows: import('../api/types.ts').Finding[];
  highlightFindingId: number | null;
}

function FindingsTable({ loading, error, projectId, rows, highlightFindingId }: FindingsTableProps) {
  return (
    <QueryPanel
      loading={loading}
      error={error}
      isEmpty={rows.length === 0}
      emptyText="No findings in the window."
    >
      <Table fz="sm" striped highlightOnHover>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Severity</Table.Th>
            <Table.Th>Task</Table.Th>
            <Table.Th>Reviewer</Table.Th>
            <Table.Th>Title</Table.Th>
            <Table.Th>File</Table.Th>
            <Table.Th>Posted</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map((r) => (
            <Table.Tr
              key={r.id}
              bg={r.id === highlightFindingId ? 'var(--mantine-color-yellow-1)' : undefined}
            >
              <Table.Td>
                <Badge color={SEVERITY_COLORS[r.severity]} variant="light" size="xs">
                  {r.severity}
                </Badge>
              </Table.Td>
              <Table.Td>
                <TaskHighlightLink taskId={r.taskId} projectId={projectId}>
                  #{r.taskId} (cycle {r.cycle})
                </TaskHighlightLink>
              </Table.Td>
              <Table.Td>{r.reviewerRole}</Table.Td>
              <Table.Td>{r.title}</Table.Td>
              <Table.Td>
                {r.filePath ? (
                  <Text size="xs" ff="monospace">
                    {r.filePath}
                    {r.line !== null ? `:${r.line}` : ''}
                  </Text>
                ) : (
                  <Text size="xs" c="dimmed">—</Text>
                )}
              </Table.Td>
              <Table.Td>
                <RelativeTime date={r.postedAt} />
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </QueryPanel>
  );
}

interface PatternListItem {
  key: string;
  label: string;
  count: number;
  examples: string[];
}

interface PatternListProps {
  loading: boolean;
  error: unknown;
  items: PatternListItem[];
  emptyText: string;
  projectId: string;
  /**
   * Determines where each example ID navigates:
   * - `finding`: link to `/findings?highlight=<id>` so the row gets emphasised
   *   in the findings table (NOTE-pattern example finding IDs).
   * - `task`: link to `/tasks/<id>` (arbitration-pattern example task IDs).
   */
  exampleKind: 'finding' | 'task';
}

function PatternList({ loading, error, items, emptyText, projectId, exampleKind }: PatternListProps) {
  return (
    <QueryPanel loading={loading} error={error} isEmpty={items.length === 0} emptyText={emptyText}>
      <Accordion variant="separated" multiple>
        {items.map((item) => (
          <Accordion.Item key={item.key} value={item.key}>
            <Accordion.Control>
              <Group justify="space-between" wrap="nowrap">
                <Text size="sm" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {item.label}
                </Text>
                <Badge size="sm" variant="light">{item.count}</Badge>
              </Group>
            </Accordion.Control>
            <Accordion.Panel>
              {item.examples.length > 0 ? (
                <Stack gap={2}>
                  <Text size="xs" c="dimmed">Examples:</Text>
                  {item.examples.map((id) => (
                    <Text key={id} size="xs" ff="monospace">
                      {exampleKind === 'finding' ? (
                        <FindingHighlightLink
                          id={Number(id)}
                          projectId={projectId}
                          severity="NOTE"
                        >
                          #{id}
                        </FindingHighlightLink>
                      ) : (
                        <TaskHighlightLink taskId={id} projectId={projectId}>
                          #{id}
                        </TaskHighlightLink>
                      )}
                    </Text>
                  ))}
                </Stack>
              ) : (
                <Text size="xs" c="dimmed">No example IDs.</Text>
              )}
            </Accordion.Panel>
          </Accordion.Item>
        ))}
      </Accordion>
    </QueryPanel>
  );
}

interface FailureReasonsPanelProps {
  loading: boolean;
  error: unknown;
  projectId: string;
  rows: FailureReasonPattern[];
}

function FailureReasonsPanel({ loading, error, projectId, rows }: FailureReasonsPanelProps) {
  // The padded row list is always non-empty (we synthesise zero-count rows for
  // every failure-reason enum value), so the empty branch is unreachable in
  // practice — we pass `isEmpty={false}` rather than invent fake empty text.
  return (
    <QueryPanel loading={loading} error={error} isEmpty={false} emptyText="">
      <Stack gap={4}>
        {rows.map((r) => {
          const flagged = FLAGGED_FAILURE_REASONS.has(r.failureReason) && r.count > 0;
          const emphasised = r.count > 0;
          return (
            <Group key={r.failureReason} justify="space-between" wrap="nowrap" gap="xs">
              <Group gap={6} wrap="nowrap">
                {flagged && <IconAlertTriangle size={14} color="var(--mantine-color-red-6)" />}
                <Text size="sm" fw={emphasised ? 600 : 400} c={emphasised ? undefined : 'dimmed'}>
                  {r.failureReason}
                </Text>
              </Group>
              <Group gap={6} wrap="nowrap">
                {r.exampleTaskIds.slice(0, 3).map((id) => (
                  <Text key={id} size="xs" ff="monospace">
                    <TaskHighlightLink taskId={id} projectId={projectId}>
                      #{id}
                    </TaskHighlightLink>
                  </Text>
                ))}
                <Badge size="sm" variant={emphasised ? 'filled' : 'light'} color={flagged ? 'red' : emphasised ? 'orange' : 'gray'}>
                  {r.count}
                </Badge>
              </Group>
            </Group>
          );
        })}
      </Stack>
    </QueryPanel>
  );
}
