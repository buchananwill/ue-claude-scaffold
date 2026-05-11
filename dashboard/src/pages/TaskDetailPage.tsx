import { useState } from 'react';
import { useParams, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import {
  Accordion,
  Alert,
  Badge,
  Card,
  Code,
  Group,
  Loader,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useTask } from '../hooks/useTask.ts';
import { StatusBadge } from '../components/StatusBadge.tsx';
import { RelativeTime } from '../components/RelativeTime.tsx';
import { TaskDuration } from '../components/TaskDuration.tsx';
import { MarkdownContent } from '../components/MarkdownContent.tsx';
import { useProject } from '../contexts/ProjectContext.tsx';
import { useAgentNameMap } from '../hooks/useAgentNameMap.ts';
import { formatAgentRef } from '../utils/agentRef.ts';
import { usePollInterval } from '../hooks/usePollInterval.tsx';
import { fetchReviewCycle, fetchTaskArbitrations } from '../api/client.ts';
import type {
  ArbitrationRun,
  ReviewFinding,
  ReviewRun,
  ReviewerVerdict,
} from '../api/types.ts';

const VERDICT_COLORS: Record<ReviewerVerdict, string> = {
  pending: 'gray',
  approve: 'green',
  request_changes: 'red',
  out_of_scope: 'blue',
};

function severityColor(severity: 'BLOCKING' | 'NOTE'): string {
  return severity === 'BLOCKING' ? 'red' : 'gray';
}

export function TaskDetailPage() {
  const params = useParams({ from: '/$projectId/tasks/$taskId' });
  const { projectId } = useProject();
  const agentNames = useAgentNameMap();
  const taskId = Number(params.taskId);
  const { data: task, isLoading, error } = useTask(taskId);

  if (isNaN(taskId)) return <Text c="red">Invalid task ID</Text>;
  if (isLoading) return <Loader display="block" mx="auto" my="xl" />;
  if (error) {
    return (
      <Text c="red" ta="center" py="xl">
        {error instanceof Error ? error.message : String(error)}
      </Text>
    );
  }
  if (!task) {
    return (
      <Text c="dimmed" ta="center" py="xl">
        Task not found
      </Text>
    );
  }

  return (
    <Stack gap="md">
      {/* prev: any — TanStack Router doesn't infer search param types for cross-route Links */}
      <Text fz="sm">
        <Link
          to="/$projectId"
          params={{ projectId }}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          search={(prev: any) => prev}
          style={{ textDecoration: 'none' }}
        >
          &larr; Back to overview
        </Link>
      </Text>

      <Card withBorder p="md">
        <Group gap="sm" mb="md">
          <Title order={3}>
            #{task.id} {task.title}
          </Title>
          <StatusBadge value={task.status} />
          <Text size="sm" c="dimmed">
            Priority {task.priority}
          </Text>
        </Group>

        <Stack gap="sm">
          <div>
            <Text size="xs" fw={600} c="dimmed">
              Description
            </Text>
            {task.description ? (
              <Text size="sm">{task.description}</Text>
            ) : (
              <Text size="sm" c="dimmed" fs="italic">
                &mdash;
              </Text>
            )}
          </div>

          <div>
            <Text size="xs" fw={600} c="dimmed">
              Acceptance Criteria
            </Text>
            {task.acceptanceCriteria ? (
              <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                {task.acceptanceCriteria}
              </Text>
            ) : (
              <Text size="sm" c="dimmed" fs="italic">
                &mdash;
              </Text>
            )}
          </div>

          <div>
            <Text size="xs" fw={600} c="dimmed">
              Progress Log
            </Text>
            {task.progressLog ? (
              <Code block>{task.progressLog}</Code>
            ) : (
              <Text size="sm" c="dimmed" fs="italic">
                &mdash;
              </Text>
            )}
          </div>

          <div>
            <Text size="xs" fw={600} c="dimmed">
              Result
            </Text>
            {task.result != null ? (
              <Code block>{JSON.stringify(task.result, null, 2)}</Code>
            ) : (
              <Text size="sm" c="dimmed" fs="italic">
                &mdash;
              </Text>
            )}
          </div>

          <div>
            <Text size="xs" fw={600} c="dimmed">
              Files
            </Text>
            {task.files && task.files.length > 0 ? (
              <Stack gap={2}>
                {task.files.map((f) => (
                  <Text key={f} size="sm" ff="monospace">
                    {f}
                  </Text>
                ))}
              </Stack>
            ) : (
              <Text size="sm" c="dimmed" fs="italic">
                (none)
              </Text>
            )}
          </div>

          <div>
            <Text size="xs" fw={600} c="dimmed">
              Dependencies
            </Text>
            {task.dependsOn && task.dependsOn.length > 0 ? (
              <Group gap="xs">
                {task.dependsOn.map((depId) => (
                  <Group key={depId} gap={4}>
                    <Text fz="sm" span>
                      <Link
                        to="/$projectId/tasks/$taskId"
                        params={{ projectId, taskId: String(depId) }}
                        style={{ textDecoration: 'none' }}
                      >
                        #{depId}
                      </Link>
                    </Text>
                    {task.blockedBy?.includes(depId) && (
                      <Badge size="xs" color="orange" variant="light">
                        blocking
                      </Badge>
                    )}
                  </Group>
                ))}
              </Group>
            ) : (
              <Text size="sm" c="dimmed" fs="italic">
                (none)
              </Text>
            )}
          </div>

          {task.blockReasons?.length > 0 && (
            <div>
              <Text size="xs" fw={600} c="dimmed">
                Block Reasons
              </Text>
              <Stack gap={2} mt={4}>
                {task.blockReasons.map((r, i) => (
                  <Text key={i} size="sm" c="red">
                    {r}
                  </Text>
                ))}
              </Stack>
            </div>
          )}

          <div>
            <Text size="xs" fw={600} c="dimmed">
              Source Path
            </Text>
            {task.sourcePath ? (
              <Text size="sm" ff="monospace">
                {task.sourcePath}
              </Text>
            ) : (
              <Text size="sm" c="dimmed" fs="italic">
                &mdash;
              </Text>
            )}
          </div>

          <Group gap="md">
            <Text size="xs" c="dimmed">
              Created: <RelativeTime date={task.createdAt} />
            </Text>
            <Text size="xs" c="dimmed">
              Claimed:{' '}
              {task.claimedAt ? (
                <RelativeTime date={task.claimedAt} />
              ) : (
                <Text span size="xs" c="dimmed" fs="italic">
                  &mdash;
                </Text>
              )}
            </Text>
            <Text size="xs" c="dimmed">
              Completed:{' '}
              {task.completedAt ? (
                <RelativeTime date={task.completedAt} />
              ) : (
                <Text span size="xs" c="dimmed" fs="italic">
                  &mdash;
                </Text>
              )}
            </Text>
          </Group>
          <Text size="xs" c="dimmed">
            Duration:{' '}
            <TaskDuration
              claimedAt={task.claimedAt}
              completedAt={task.completedAt}
              status={task.status}
            />
          </Text>

          <div>
            <Text size="xs" fw={600} c="dimmed">
              Claimed By
            </Text>
            {task.claimedBy ? (
              <Text fz="sm" span>
                <Link
                  to="/$projectId/agents/$agentName"
                  params={{
                    projectId,
                    agentName: formatAgentRef(task.claimedBy, agentNames),
                  }}
                >
                  {formatAgentRef(task.claimedBy, agentNames)}
                </Link>
              </Text>
            ) : (
              <Text size="sm" c="dimmed" fs="italic">
                &mdash;
              </Text>
            )}
          </div>
        </Stack>
      </Card>

      <FsmStrip
        status={task.status}
        cycleCount={task.reviewCycleCount}
        cycleBudget={task.reviewCycleBudget}
        verdicts={task.reviewerVerdicts}
        failureReason={task.failureReason}
        failureDetail={task.failureDetail}
        arbitrationPendingTrigger={task.arbitrationPendingTrigger}
      />

      <ArbitrationSection taskId={task.id} projectId={projectId} />

      <ReviewsSection
        taskId={task.id}
        projectId={projectId}
        currentCycle={task.reviewCycleCount}
        verdicts={task.reviewerVerdicts}
      />
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// FSM strip — status, cycle counter, reviewer-verdict chips, failure banner.
// ---------------------------------------------------------------------------

interface FsmStripProps {
  status: string;
  cycleCount: number;
  cycleBudget: number;
  verdicts: import('../api/types.ts').ReviewerVerdictMap;
  failureReason: import('../api/types.ts').FailureReason | null;
  failureDetail: string | null;
  arbitrationPendingTrigger: string | null;
}

function FsmStrip({
  status,
  cycleCount,
  cycleBudget,
  verdicts,
  failureReason,
  failureDetail,
  arbitrationPendingTrigger,
}: FsmStripProps) {
  const verdictEntries = Object.entries(verdicts ?? {}) as [string, ReviewerVerdict][];

  return (
    <Card withBorder p="md">
      <Title order={5} mb="xs">Review state</Title>
      <Group gap="md" mb="xs">
        <Group gap={6}>
          <Text size="xs" c="dimmed">Status:</Text>
          <StatusBadge value={status} />
        </Group>
        <Group gap={6}>
          <Text size="xs" c="dimmed">Cycle:</Text>
          <Text size="sm" fw={500}>
            {cycleCount} / {cycleBudget}
          </Text>
        </Group>
      </Group>

      {verdictEntries.length > 0 ? (
        <Group gap="xs">
          {verdictEntries.map(([role, verdict]) => (
            <Badge
              key={role}
              color={VERDICT_COLORS[verdict] ?? 'gray'}
              variant={verdict === 'pending' ? 'outline' : 'light'}
              size="md"
            >
              {role}: {verdict}
            </Badge>
          ))}
        </Group>
      ) : (
        <Text size="sm" c="dimmed" fs="italic">
          No reviewer verdicts recorded yet.
        </Text>
      )}

      {status === 'arbitrating' && (
        <Alert color="pink" mt="md" icon={<IconAlertTriangle size={16} />} title="Arbitration pending">
          Trigger: <Code>{arbitrationPendingTrigger ?? 'unspecified'}</Code>. Waiting for arbitrator ruling.
        </Alert>
      )}

      {status === 'failed' && failureReason && (
        <Alert color="red" mt="md" icon={<IconAlertTriangle size={16} />} title={`Failed: ${failureReason}`}>
          {failureDetail ? (
            <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>{failureDetail}</Text>
          ) : (
            <Text size="sm" c="dimmed" fs="italic">No additional detail recorded.</Text>
          )}
        </Alert>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Reviews — per-cycle, per-reviewer markdown + structured findings.
// ---------------------------------------------------------------------------

interface ReviewsSectionProps {
  taskId: number;
  projectId: string;
  currentCycle: number;
  verdicts: import('../api/types.ts').ReviewerVerdictMap;
}

function ReviewsSection({ taskId, projectId, currentCycle, verdicts }: ReviewsSectionProps) {
  // Track which reviewer the operator clicked from the FSM strip so we can
  // open the matching Accordion item in the current cycle.
  const [pinnedReviewer, setPinnedReviewer] = useState<string | null>(null);

  if (currentCycle <= 0) {
    return (
      <Card withBorder p="md">
        <Title order={5} mb="xs">Reviews</Title>
        <Text size="sm" c="dimmed" fs="italic">No review cycles recorded yet.</Text>
      </Card>
    );
  }

  // Render cycles in descending order so the current one is at the top.
  const cycleNumbers: number[] = [];
  for (let c = currentCycle; c >= 1; c -= 1) cycleNumbers.push(c);

  return (
    <Card withBorder p="md">
      <Title order={5} mb="xs">Reviews</Title>

      {/* Quick-jump chip strip: clicking a request_changes reviewer pins the
          accordion open on that reviewer's run in the current cycle. */}
      {Object.keys(verdicts ?? {}).length > 0 && (
        <Group gap="xs" mb="sm">
          <Text size="xs" c="dimmed">Jump to reviewer:</Text>
          {(Object.entries(verdicts ?? {}) as [string, ReviewerVerdict][]).map(([role, verdict]) => (
            <Badge
              key={role}
              component="button"
              color={VERDICT_COLORS[verdict] ?? 'gray'}
              variant={pinnedReviewer === role ? 'filled' : 'light'}
              size="sm"
              style={{ cursor: 'pointer', background: 'none', border: 'none' }}
              onClick={() => setPinnedReviewer((cur) => (cur === role ? null : role))}
            >
              {role}: {verdict}
            </Badge>
          ))}
        </Group>
      )}

      <Stack gap="sm">
        {cycleNumbers.map((cycle) => (
          <CycleBlock
            key={cycle}
            taskId={taskId}
            projectId={projectId}
            cycle={cycle}
            isCurrent={cycle === currentCycle}
            pinnedReviewer={cycle === currentCycle ? pinnedReviewer : null}
          />
        ))}
      </Stack>
    </Card>
  );
}

interface CycleBlockProps {
  taskId: number;
  projectId: string;
  cycle: number;
  isCurrent: boolean;
  pinnedReviewer: string | null;
}

function CycleBlock({ taskId, projectId, cycle, isCurrent, pinnedReviewer }: CycleBlockProps) {
  const { intervalMs } = usePollInterval();
  const { data, isLoading, error } = useQuery({
    queryKey: ['task-reviews', taskId, cycle, projectId],
    queryFn: ({ signal }) => fetchReviewCycle(taskId, cycle, signal, projectId),
    refetchInterval: isCurrent ? intervalMs : false,
    staleTime: 2000,
  });

  // Controlled Accordion state: tracks which reviewer panels are open. We use
  // `multiple` mode so the operator can keep several reviewers expanded at
  // once. Initialise from `pinnedReviewer` (the chip-strip selection in the
  // parent). When the chip-strip selection changes we merge the new pin into
  // the open set during render via the "store previous prop" pattern — that
  // avoids a setState-in-useEffect cascade. Changing the prop must NOT close
  // panels the operator already opened, so we union rather than replace.
  const [openItems, setOpenItems] = useState<string[]>(
    pinnedReviewer ? [pinnedReviewer] : [],
  );
  const [lastPinnedReviewer, setLastPinnedReviewer] = useState<string | null>(pinnedReviewer);
  if (pinnedReviewer !== lastPinnedReviewer) {
    setLastPinnedReviewer(pinnedReviewer);
    if (pinnedReviewer && !openItems.includes(pinnedReviewer)) {
      setOpenItems([...openItems, pinnedReviewer]);
    }
  }

  return (
    <Card withBorder p="sm" bg={isCurrent ? 'var(--mantine-color-gray-0)' : undefined}>
      <Group gap="sm" mb="xs">
        <Title order={6}>Cycle {cycle}</Title>
        {isCurrent && <Badge size="xs" variant="light">current</Badge>}
      </Group>

      {isLoading ? (
        <Loader size="sm" />
      ) : error ? (
        <Text c="red" size="sm">
          {error instanceof Error ? error.message : String(error)}
        </Text>
      ) : !data || data.runs.length === 0 ? (
        <Text size="sm" c="dimmed" fs="italic">No reviewer runs posted for this cycle.</Text>
      ) : (
        <Accordion
          variant="separated"
          multiple
          value={openItems}
          onChange={setOpenItems}
        >
          {data.runs.map((run) => (
            <ReviewRunItem key={run.reviewerRole} run={run} />
          ))}
        </Accordion>
      )}
    </Card>
  );
}

function ReviewRunItem({ run }: { run: ReviewRun }) {
  return (
    <Accordion.Item value={run.reviewerRole}>
      <Accordion.Control>
        <Group gap="sm" wrap="nowrap">
          <Text size="sm" fw={600}>{run.reviewerRole}</Text>
          <Badge color={VERDICT_COLORS[run.verdict] ?? 'gray'} variant="light" size="sm">
            {run.verdict}
          </Badge>
          <Text size="xs" c="dimmed">
            <RelativeTime date={run.postedAt} />
          </Text>
          {run.findings.length > 0 && (
            <Text size="xs" c="dimmed">
              {run.findings.length} finding{run.findings.length === 1 ? '' : 's'}
            </Text>
          )}
        </Group>
      </Accordion.Control>
      <Accordion.Panel>
        <Stack gap="sm">
          <MarkdownContent content={run.rawMarkdown} />
          <FindingsTable findings={run.findings} />
        </Stack>
      </Accordion.Panel>
    </Accordion.Item>
  );
}

function FindingsTable({ findings }: { findings: ReviewFinding[] }) {
  if (findings.length === 0) {
    return <Text size="xs" c="dimmed" fs="italic">No structured findings.</Text>;
  }

  return (
    <Accordion variant="contained" multiple>
      {findings.map((f) => (
        <Accordion.Item key={f.id} value={String(f.id)}>
          <Accordion.Control>
            <Group gap="sm" wrap="nowrap">
              <Badge color={severityColor(f.severity)} variant="light" size="xs">
                {f.severity}
              </Badge>
              <Text size="xs" c="dimmed">B{f.ordinal}</Text>
              {f.filePath && (
                <Text size="xs" ff="monospace">
                  {f.filePath}{f.line !== null ? `:${f.line}` : ''}
                </Text>
              )}
              <Text size="sm">{f.title}</Text>
            </Group>
          </Accordion.Control>
          <Accordion.Panel>
            <Stack gap={6}>
              <div>
                <Text size="xs" fw={600} c="dimmed">Description</Text>
                <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>{f.description}</Text>
              </div>
              {f.evidence && (
                <div>
                  <Text size="xs" fw={600} c="dimmed">Evidence</Text>
                  <Code block>{f.evidence}</Code>
                </div>
              )}
              {f.fix && (
                <div>
                  <Text size="xs" fw={600} c="dimmed">Fix</Text>
                  <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>{f.fix}</Text>
                </div>
              )}
            </Stack>
          </Accordion.Panel>
        </Accordion.Item>
      ))}
    </Accordion>
  );
}

// ---------------------------------------------------------------------------
// Arbitration — list of arbitration rulings (at most one per trigger).
// ---------------------------------------------------------------------------

interface ArbitrationSectionProps {
  taskId: number;
  projectId: string;
}

function ArbitrationSection({ taskId, projectId }: ArbitrationSectionProps) {
  const { intervalMs } = usePollInterval();
  const { data, isLoading, error } = useQuery({
    queryKey: ['task-arbitrations', taskId, projectId],
    queryFn: ({ signal }) => fetchTaskArbitrations(taskId, signal, projectId),
    refetchInterval: intervalMs,
    staleTime: 2000,
  });

  if (isLoading) {
    return (
      <Card withBorder p="md">
        <Title order={5} mb="xs">Arbitration</Title>
        <Loader size="sm" />
      </Card>
    );
  }

  if (error) {
    return (
      <Card withBorder p="md">
        <Title order={5} mb="xs">Arbitration</Title>
        <Text c="red" size="sm">
          {error instanceof Error ? error.message : String(error)}
        </Text>
      </Card>
    );
  }

  const runs = data?.runs ?? [];
  if (runs.length === 0) {
    return null;
  }

  return (
    <Card withBorder p="md">
      <Title order={5} mb="xs">Arbitration</Title>
      <Stack gap="sm">
        {runs.map((run) => (
          <ArbitrationRunBlock key={run.id} run={run} projectId={projectId} />
        ))}
      </Stack>
    </Card>
  );
}

function ArbitrationRunBlock({ run, projectId }: { run: ArbitrationRun; projectId: string }) {
  return (
    <Card withBorder p="sm" bg="var(--mantine-color-gray-0)">
      <Group gap="sm" mb="xs">
        <Badge color="pink" variant="light" size="sm">{run.trigger}</Badge>
        <Badge color={run.ruling === 'escalate' ? 'red' : run.ruling === 'rule' ? 'orange' : 'green'} variant="filled" size="sm">
          {run.ruling}
        </Badge>
        <Text size="xs" c="dimmed">
          <RelativeTime date={run.postedAt} />
        </Text>
      </Group>

      <MarkdownContent content={run.rulingMarkdown} />

      {run.ruling === 'rule' && run.contradictionResolution && (
        <Alert color="orange" mt="sm" title="Contradiction resolution">
          <Stack gap={4}>
            <Text size="sm">
              Upheld finding:{' '}
              <FindingIdLink
                findingId={run.contradictionResolution.upheldFindingId}
                projectId={projectId}
              />
            </Text>
            <Text size="sm">
              Retired finding:{' '}
              <FindingIdLink
                findingId={run.contradictionResolution.retiredFindingId}
                projectId={projectId}
              />
            </Text>
            <div>
              <Text size="xs" fw={600} c="dimmed">Rationale</Text>
              <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                {run.contradictionResolution.rationale}
              </Text>
            </div>
          </Stack>
        </Alert>
      )}
    </Card>
  );
}

/**
 * Click-through wrapper for a finding ID. Routes to the project Findings page
 * with `highlight=<id>` so the matching row flashes / scrolls into view if it
 * is in the current page; otherwise the operator lands on the queryable
 * findings table and can locate the row via filters.
 */
function FindingIdLink({ findingId, projectId }: { findingId: number; projectId: string }) {
  return (
    <Link
      to="/$projectId/findings"
      params={{ projectId }}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      search={(prev: any) => ({ ...prev, highlight: String(findingId) })}
      style={{ textDecoration: 'none' }}
    >
      <Code style={{ cursor: 'pointer' }}>#{findingId}</Code>
    </Link>
  );
}
