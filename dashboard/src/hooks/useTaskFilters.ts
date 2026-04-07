import { useMemo, useState, useCallback } from 'react';
import { useSearch, useNavigate } from '@tanstack/react-router';
import type { Task } from '../api/types.js';
export { TASK_STATUSES, STATUS_LABELS } from '../constants/task-statuses.js';

export type SortDir = 'asc' | 'desc' | null;
export type SortColumn = 'id' | 'priority' | 'status' | 'title' | 'claimedBy' | 'createdAt' | null;

// Must match server/src/queries/tasks-core.ts VALID_SORT_COLUMNS
export const VALID_SORT_COLUMNS = new Set<string>(['id', 'priority', 'status', 'title', 'claimedBy', 'createdAt']);

/**
 * Sentinel value for filtering tasks with no assigned agent.
 * Recognized by the server's GET /tasks handler (see server/src/routes/tasks.ts)
 * which translates it into a `claimed_by IS NULL` condition.
 */
const UNASSIGNED = '__unassigned__';

export { UNASSIGNED };

interface FilterState {
  statusFilter: Set<string>;
  agentFilter: Set<string>;
  priorityFilter: Set<number>;
  sortColumn: SortColumn;
  sortDir: SortDir;
  setStatusFilter: (val: Set<string>) => void;
  setAgentFilter: (val: Set<string>) => void;
  setPriorityFilter: (val: Set<number>) => void;
  cycleSort: (col: NonNullable<SortColumn>) => void;
  clearAllFilters: () => void;
}

function useFilteredTasks(tasks: Task[], filters: FilterState) {
  const {
    statusFilter, agentFilter, priorityFilter,
    sortColumn, sortDir,
  } = filters;

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

  return {
    displayedTasks,
    hasActiveFilters,
    uniqueAgents,
    uniquePriorities,
  };
}

/**
 * Client-side task filtering and sorting hook. Manages filter/sort state in
 * React state and applies filtering/sorting to the provided `tasks` array
 * in-memory.
 *
 * WARNING: Do NOT use this with paginated server-side responses. When the
 * server returns a page of tasks, client-side filtering would hide results
 * that exist on other pages, producing incorrect counts and missing items.
 * For paginated/server-filtered views, use {@link useTaskFiltersUrlBacked}
 * instead.
 */
export function useTaskFilters(tasks: Task[]) {
  const [statusFilter, setStatusFilterRaw] = useState<Set<string>>(() => new Set());
  const [agentFilter, setAgentFilterRaw] = useState<Set<string>>(() => new Set());
  const [priorityFilter, setPriorityFilterRaw] = useState<Set<number>>(() => new Set());
  const [sortColumn, setSortColumn] = useState<SortColumn>(null);
  const [sortDir, setSortDir] = useState<SortDir>(null);

  const setStatusFilter = useCallback((val: Set<string>) => setStatusFilterRaw(val), []);
  const setAgentFilter = useCallback((val: Set<string>) => setAgentFilterRaw(val), []);
  const setPriorityFilter = useCallback((val: Set<number>) => setPriorityFilterRaw(val), []);

  const cycleSort = useCallback((col: NonNullable<SortColumn>) => {
    setSortColumn((prevCol) => {
      if (prevCol !== col) {
        setSortDir('asc');
        return col;
      }
      setSortDir((prevDir) => {
        if (prevDir === 'asc') {
          return 'desc';
        }
        setSortColumn(null);
        return null;
      });
      return prevCol;
    });
  }, []);

  const clearAllFilters = useCallback(() => {
    setStatusFilterRaw(new Set());
    setAgentFilterRaw(new Set());
    setPriorityFilterRaw(new Set());
    setSortColumn(null);
    setSortDir(null);
  }, []);

  const filters: FilterState = { statusFilter, agentFilter, priorityFilter, sortColumn, sortDir, setStatusFilter, setAgentFilter, setPriorityFilter, cycleSort, clearAllFilters };
  const derived = useFilteredTasks(tasks, filters);

  return {
    ...filters,
    ...derived,
  };
}

/**
 * URL-backed variant of task filter state for server-side filtering. Must only
 * be used in components rendered under the `/$projectId/` route, as it
 * reads/writes search params via that route.
 *
 * Unlike {@link useTaskFilters}, this variant does NOT do client-side filtering
 * or sorting. It only manages filter/sort state (backed by URL search params).
 * The caller is responsible for forwarding filter values to `useTasks()` which
 * passes them as query parameters for server-side filtering and pagination.
 *
 * This is the correct choice for any view that uses server-side pagination
 * (e.g. OverviewPage).
 */
export function useTaskFiltersUrlBacked() {
  const search = useSearch({ from: '/$projectId/' });
  const navigate = useNavigate({ from: '/$projectId/' });

  const statusFilter = useMemo(() => {
    if (!search.status) return new Set<string>();
    return new Set(search.status.split(',').filter(Boolean));
  }, [search.status]);

  const agentFilter = useMemo(() => {
    if (!search.agent) return new Set<string>();
    return new Set(search.agent.split(',').filter(Boolean));
  }, [search.agent]);

  const priorityFilter = useMemo(() => {
    if (!search.priority) return new Set<number>();
    return new Set(
      search.priority.split(',').filter(Boolean).map(Number).filter((n) => !Number.isNaN(n))
    );
  }, [search.priority]);

  const sortColumn: SortColumn = useMemo(() => {
    if (search.sort && VALID_SORT_COLUMNS.has(search.sort)) return search.sort as NonNullable<SortColumn>;
    return null;
  }, [search.sort]);

  const sortDir: SortDir = sortColumn === null ? null : (search.dir === 'desc' ? 'desc' : 'asc');

  const page = search.page ?? 1;

  const setPage = useCallback((n: number) => {
    navigate({ search: (prev) => ({ ...prev, page: n > 1 ? n : undefined }) });
  }, [navigate]);

  const setStatusFilter = useCallback((val: Set<string>) => {
    navigate({ search: (prev) => ({ ...prev, status: val.size ? [...val].join(',') : undefined, page: undefined }) });
  }, [navigate]);

  const setAgentFilter = useCallback((val: Set<string>) => {
    navigate({ search: (prev) => ({ ...prev, agent: val.size ? [...val].join(',') : undefined, page: undefined }) });
  }, [navigate]);

  const setPriorityFilter = useCallback((val: Set<number>) => {
    navigate({ search: (prev) => ({ ...prev, priority: val.size ? [...val].join(',') : undefined, page: undefined }) });
  }, [navigate]);

  const cycleSort = useCallback((col: NonNullable<SortColumn>) => {
    if (sortColumn !== col) {
      navigate({ search: (prev) => ({ ...prev, sort: col, dir: 'asc', page: undefined }) });
    } else if (sortDir === 'asc') {
      navigate({ search: (prev) => ({ ...prev, sort: col, dir: 'desc', page: undefined }) });
    } else {
      navigate({ search: (prev) => ({ ...prev, sort: undefined, dir: undefined, page: undefined }) });
    }
  }, [navigate, sortColumn, sortDir]);

  const clearAllFilters = useCallback(() => {
    navigate({ search: (prev) => ({ ...prev, status: undefined, agent: undefined, priority: undefined, sort: undefined, dir: undefined, page: undefined }) });
  }, [navigate]);

  const hasActiveFilters = agentFilter.size > 0 || priorityFilter.size > 0 || statusFilter.size > 0 || sortColumn !== null;

  return {
    statusFilter,
    agentFilter,
    priorityFilter,
    sortColumn,
    sortDir,
    setStatusFilter,
    setAgentFilter,
    setPriorityFilter,
    cycleSort,
    clearAllFilters,
    hasActiveFilters,
    page,
    setPage,
  };
}

export type TaskFilters = ReturnType<typeof useTaskFilters>;
export type TaskFiltersUrlBacked = ReturnType<typeof useTaskFiltersUrlBacked>;
