/**
 * Click-through Link primitives that target the Findings and Task Detail
 * pages with the search-param contract those routes expect. Centralising
 * these wrappers removes three near-identical `<Link to=".../findings"
 * search={(prev: any) => ...}>` copies and eliminates two of the three
 * `@typescript-eslint/no-explicit-any` disables that the inline callbacks
 * required.
 *
 * The remaining `any` on the search-callback parameter is unavoidable until
 * TanStack Router exposes the per-route search-schema type to cross-route
 * `Link` callers. It is contained here, in one place, with a comment.
 */
import { Link } from '@tanstack/react-router';
import { Code } from '@mantine/core';
import type { ReactNode } from 'react';
import type { Severity } from '../constants/finding-styling.ts';

interface FindingHighlightLinkProps {
  /** Finding ID to land on; rendered as `#<id>` in a `<Code>` span by default. */
  id: number;
  projectId: string;
  /**
   * If supplied, switches the findings table to this severity tab in addition
   * to highlighting the row. NOTE-pattern example links pass `'NOTE'` so the
   * row is on the page the operator lands on.
   */
  severity?: Severity;
  /** Override the rendered label; defaults to `<Code>#<id></Code>`. */
  children?: ReactNode;
}

/**
 * Link to the Findings page with `?highlight=<id>` (and optionally
 * `severity=`) so the matching row is emphasised when it is present in the
 * current page of results.
 */
export function FindingHighlightLink({
  id,
  projectId,
  severity,
  children,
}: FindingHighlightLinkProps) {
  return (
    <Link
      to="/$projectId/findings"
      params={{ projectId }}
      // TanStack Router does not infer the cross-route search schema from the
      // `to` string, so the callback param is untyped at this call site.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      search={(prev: any) => {
        const next = { ...prev, highlight: String(id) };
        if (severity) next.severity = severity;
        return next;
      }}
      style={{ textDecoration: 'none', cursor: 'pointer' }}
    >
      {children ?? <Code style={{ cursor: 'pointer' }}>#{id}</Code>}
    </Link>
  );
}

interface TaskHighlightLinkProps {
  taskId: number | string;
  projectId: string;
  children?: ReactNode;
}

/**
 * Link to a task's detail page. The label defaults to `#<taskId>`.
 */
export function TaskHighlightLink({ taskId, projectId, children }: TaskHighlightLinkProps) {
  return (
    <Link
      to="/$projectId/tasks/$taskId"
      params={{ projectId, taskId: String(taskId) }}
      style={{ textDecoration: 'none', cursor: 'pointer' }}
    >
      {children ?? `#${taskId}`}
    </Link>
  );
}
