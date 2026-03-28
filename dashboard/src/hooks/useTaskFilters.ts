import { useMemo, useState, useCallback } from 'react';
import { useSearch, useNavigate } from '@tanstack/react-router';
import type { Task } from '../api/types.ts';

export type SortDir = 'asc' | 'desc' | null;
export type SortColumn = 'id' | 'priority' | 'status' | 'title' | 'claimedBy' | 'createdAt' | null;

const VALID_SORT_COLUMNS = new Set<string>(['id', 'priority', 'status', 'title', 'claimedBy', 'createdAt']);

const UNASSIGNED = '__unassigned__';

export { UNASSIGNED };

export const TASK_STATUSES = ['pending', 'claimed', 'in_progress', 'completed', 'failed'] as const;

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

export function useTaskFiltersUrlBacked(tasks: Task[]) {
  const search = useSearch({ from: '/' });
  const navigate = useNavigate({ from: '/' });

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
      search.priority.split(',').map(Number).filter((n) => !Number.isNaN(n))
    );
  }, [search.priority]);

  const sortColumn: SortColumn = useMemo(() => {
    if (search.sort && VALID_SORT_COLUMNS.has(search.sort)) return search.sort as NonNullable<SortColumn>;
    return null;
  }, [search.sort]);

  const sortDir: SortDir = sortColumn === null ? null : (search.dir === 'desc' ? 'desc' : 'asc');

  const page = search.page ?? 1;

  const setPage = (n: number) => {
    navigate({ search: (prev: any) => ({ ...prev, page: n > 1 ? String(n) : undefined }) });
  };

  const setStatusFilter = (val: Set<string>) => {
    navigate({ search: (prev) => ({ ...prev, status: val.size ? [...val].join(',') : undefined, page: undefined }) });
  };

  const setAgentFilter = (val: Set<string>) => {
    navigate({ search: (prev) => ({ ...prev, agent: val.size ? [...val].join(',') : undefined, page: undefined }) });
  };

  const setPriorityFilter = (val: Set<number>) => {
    navigate({ search: (prev) => ({ ...prev, priority: val.size ? [...val].join(',') : undefined, page: undefined }) });
  };

  const cycleSort = (col: NonNullable<SortColumn>) => {
    if (sortColumn !== col) {
      navigate({ search: (prev) => ({ ...prev, sort: col, dir: 'asc', page: undefined }) });
    } else if (sortDir === 'asc') {
      navigate({ search: (prev) => ({ ...prev, sort: col, dir: 'desc', page: undefined }) });
    } else {
      navigate({ search: (prev) => ({ ...prev, sort: undefined, dir: undefined, page: undefined }) });
    }
  };

  const clearAllFilters = () => {
    navigate({ search: (prev) => ({ ...prev, status: undefined, agent: undefined, priority: undefined, sort: undefined, dir: undefined, page: undefined }) });
  };

  const filters: FilterState = { statusFilter, agentFilter, priorityFilter, sortColumn, sortDir, setStatusFilter, setAgentFilter, setPriorityFilter, cycleSort, clearAllFilters };
  const derived = useFilteredTasks(tasks, filters);

  return {
    ...filters,
    ...derived,
    page,
    setPage,
  };
}

export type TaskFilters = ReturnType<typeof useTaskFilters>;
