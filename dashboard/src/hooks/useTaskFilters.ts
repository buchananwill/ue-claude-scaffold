import { useState, useMemo, useCallback, useReducer } from 'react';
import type { Task } from '../api/types.ts';

export type SortDir = 'asc' | 'desc';
export type SortColumn = 'id' | 'priority' | 'status' | 'title' | 'claimedBy' | 'createdAt' | null;

type SortState = { column: SortColumn; dir: SortDir };
type SortAction = { type: 'cycle'; col: NonNullable<SortColumn> } | { type: 'reset' };

function sortReducer(state: SortState, action: SortAction): SortState {
  if (action.type === 'reset') return { column: null, dir: 'asc' };
  const col = action.col;
  if (state.column !== col) return { column: col, dir: 'asc' };
  if (state.dir === 'asc') return { column: col, dir: 'desc' };
  return { column: null, dir: 'asc' };
}

const UNASSIGNED = '__unassigned__';

export { UNASSIGNED };

export const TASK_STATUSES = ['pending', 'claimed', 'in_progress', 'completed', 'failed'] as const;

export function useTaskFilters(tasks: Task[]) {
  const [{ column: sortColumn, dir: sortDir }, dispatchSort] = useReducer(sortReducer, { column: null, dir: 'asc' });
  const [agentFilter, setAgentFilter] = useState<Set<string>>(new Set());
  const [priorityFilter, setPriorityFilter] = useState<Set<number>>(new Set());
  const [statusFilter, setStatusFilter] = useState<Set<string>>(new Set());

  const cycleSort = useCallback((col: NonNullable<SortColumn>) => {
    dispatchSort({ type: 'cycle', col });
  }, []);

  const uniqueAgents = useMemo(() => {
    const agents: string[] = [];
    const seen = new Set<string>();
    let hasNull = false;
    for (const t of tasks) {
      if (t.claimedBy === null) {
        hasNull = true;
      } else if (!seen.has(t.claimedBy)) {
        seen.add(t.claimedBy);
        agents.push(t.claimedBy);
      }
    }
    agents.sort((a, b) => a.localeCompare(b));
    if (hasNull) agents.unshift(UNASSIGNED);
    return agents;
  }, [tasks]);

  const uniquePriorities = useMemo(() => {
    const set = new Set<number>();
    for (const t of tasks) set.add(t.priority);
    return Array.from(set).sort((a, b) => b - a);
  }, [tasks]);

  const displayedTasks = useMemo(() => {
    let result = tasks;

    if (agentFilter.size > 0) {
      result = result.filter((t) =>
        (agentFilter.has(UNASSIGNED) && t.claimedBy === null) ||
        (t.claimedBy !== null && agentFilter.has(t.claimedBy))
      );
    }

    if (priorityFilter.size > 0) {
      result = result.filter((t) => priorityFilter.has(t.priority));
    }

    if (statusFilter.size > 0) {
      result = result.filter((t) => statusFilter.has(t.status));
    }

    if (sortColumn !== null) {
      const col = sortColumn;
      const dir = sortDir === 'asc' ? 1 : -1;
      result = [...result].sort((a, b) => {
        const av = a[col];
        const bv = b[col];
        if (av == null && bv == null) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        if (col === 'createdAt' || col === 'claimedBy' || col === 'status' || col === 'title') {
          return String(av).localeCompare(String(bv)) * dir;
        }
        return ((av as number) - (bv as number)) * dir;
      });
    }

    return result;
  }, [tasks, agentFilter, priorityFilter, statusFilter, sortColumn, sortDir]);

  const hasActiveFilters = agentFilter.size > 0 || priorityFilter.size > 0 || statusFilter.size > 0 || sortColumn !== null;

  const clearAllFilters = useCallback(() => {
    setAgentFilter(new Set());
    setPriorityFilter(new Set());
    setStatusFilter(new Set());
    dispatchSort({ type: 'reset' });
  }, []);

  return {
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
  };
}

export type TaskFilters = ReturnType<typeof useTaskFilters>;
