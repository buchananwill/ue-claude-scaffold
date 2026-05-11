/**
 * Per-cycle reviews section for the task detail page. Renders the chip-strip
 * jump targets, the descending list of CycleBlocks, the per-reviewer
 * accordion controls, and the structured findings table inside each
 * reviewer's accordion panel.
 *
 * Extracted verbatim from TaskDetailPage. The CycleBlock "store previous
 * prop" pattern is preserved as-is (NOTE finding N3 — not in scope this
 * cycle).
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Accordion, Badge, Card, Code, Group, Loader, Stack, Text, Title } from '@mantine/core';
import { MarkdownContent } from './MarkdownContent.tsx';
import { RelativeTime } from './RelativeTime.tsx';
import { usePollInterval } from '../hooks/usePollInterval.tsx';
import { fetchReviewCycle } from '../api/client.ts';
import { SEVERITY_COLORS, VERDICT_COLORS } from '../constants/finding-styling.ts';
import type {
  ReviewFinding,
  ReviewRun,
  ReviewerVerdict,
  ReviewerVerdictMap,
} from '../api/types.ts';

interface TaskReviewsSectionProps {
  taskId: number;
  projectId: string;
  currentCycle: number;
  verdicts: ReviewerVerdictMap;
}

export function TaskReviewsSection({
  taskId,
  projectId,
  currentCycle,
  verdicts,
}: TaskReviewsSectionProps) {
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

/**
 * Single-letter ordinal prefix that reflects a finding's severity tier so
 * the accordion row label reads e.g. "B0" for BLOCKING, "N1" for NOTE. The
 * schema only models BLOCKING and NOTE today; any future severity additions
 * should extend this mapping rather than fall through to the default.
 */
function severityOrdinalPrefix(severity: 'BLOCKING' | 'NOTE'): string {
  return severity === 'BLOCKING' ? 'B' : 'N';
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
              <Badge color={SEVERITY_COLORS[f.severity]} variant="light" size="xs">
                {f.severity}
              </Badge>
              <Text size="xs" c="dimmed">{severityOrdinalPrefix(f.severity)}{f.ordinal}</Text>
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
