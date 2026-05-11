/**
 * Uniform loading / error / empty wrapper for sidebar panels that fan out
 * from a TanStack Query. Replaces three near-identical
 *   `if (loading) ... if (error) ... if (isEmpty) ...`
 * blocks at the top of `FindingsTable`, `PatternList`, and
 * `FailureReasonsPanel` in FindingsPage.tsx.
 *
 * Callers pass the query result fields (`loading`, `error`, `isEmpty`) plus
 * the success-state children. The panel renders one of:
 *   - a Mantine `<Loader>` while `loading` is true,
 *   - a red error message when `error` is non-null,
 *   - a dimmed `emptyText` line when `isEmpty` is true,
 *   - the supplied `children` otherwise.
 */
import { Loader, Text } from '@mantine/core';
import type { ReactNode } from 'react';

interface QueryPanelProps {
  loading: boolean;
  error: unknown;
  isEmpty: boolean;
  emptyText: string;
  children: ReactNode;
}

export function QueryPanel({ loading, error, isEmpty, emptyText, children }: QueryPanelProps) {
  if (loading) return <Loader size="sm" />;
  if (error) {
    return (
      <Text c="red" size="sm">
        {error instanceof Error ? error.message : String(error)}
      </Text>
    );
  }
  if (isEmpty) {
    return <Text c="dimmed" size="sm">{emptyText}</Text>;
  }
  return <>{children}</>;
}
