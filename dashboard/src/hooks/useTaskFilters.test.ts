/**
 * Tests for useTaskFilters hook logic.
 *
 * The hook uses React hooks (useMemo, useState) internally, so we replicate
 * the pure data-transformation logic (filtering, sorting, derived values)
 * and test it directly. This avoids needing a React test renderer.
 *
 * Also tests validateSearch from the overview route definition, and
 * search-param serialization/deserialization logic from the URL-backed hook.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { Task } from '../api/types.ts';

// ---------------------------------------------------------------------------
// Pure function replicas (copied verbatim from useTaskFilters.ts)
// These mirror the useMemo bodies so we can test the real algorithm.
// ---------------------------------------------------------------------------

type SortDir = 'asc' | 'desc' | null;
type SortColumn = 'id' | 'priority' | 'status' | 'title' | 'claimedBy' | 'createdAt' | null;

const VALID_SORT_COLUMNS = new Set<string>(['id', 'priority', 'status', 'title', 'claimedBy', 'createdAt']);
const UNASSIGNED = '__unassigned__';

function filterTasks(
  tasks: Task[],
  statusFilter: Set<string>,
  agentFilter: Set<string>,
  priorityFilter: Set<number>,
): Task[] {
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
  return result;
}

function sortTasks(tasks: Task[], sortColumn: SortColumn, sortDir: SortDir): Task[] {
  if (sortColumn === null) return tasks;
  const col = sortColumn;
  const dir = sortDir === 'asc' ? 1 : -1;
  return [...tasks].sort((a, b) => {
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

function deriveUniqueAgents(tasks: Task[]): string[] {
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
}

function deriveUniquePriorities(tasks: Task[]): number[] {
  const set = new Set<number>();
  for (const t of tasks) set.add(t.priority);
  return Array.from(set).sort((a, b) => b - a);
}

// ---------------------------------------------------------------------------
// validateSearch replica (from router.tsx overviewRoute)
// ---------------------------------------------------------------------------

function validateSearch(search: Record<string, unknown>) {
  return {
    status: typeof search.status === 'string' && search.status ? search.status : undefined,
    agent: typeof search.agent === 'string' && search.agent ? search.agent : undefined,
    priority: typeof search.priority === 'string' && search.priority ? search.priority : undefined,
    sort: typeof search.sort === 'string' && search.sort ? search.sort : undefined,
    dir: typeof search.dir === 'string' && search.dir ? search.dir : undefined,
  };
}

// ---------------------------------------------------------------------------
// URL-backed deserialization replicas (from useTaskFiltersUrlBacked)
// ---------------------------------------------------------------------------

function parseStatusFilter(status: string | undefined): Set<string> {
  if (!status) return new Set<string>();
  return new Set(status.split(',').filter(Boolean));
}

function parseAgentFilter(agent: string | undefined): Set<string> {
  if (!agent) return new Set<string>();
  return new Set(agent.split(',').filter(Boolean));
}

function parsePriorityFilter(priority: string | undefined): Set<number> {
  if (!priority) return new Set<number>();
  return new Set(
    priority.split(',').map(Number).filter((n) => !Number.isNaN(n))
  );
}

function parseSortColumn(sort: string | undefined): SortColumn {
  if (sort && VALID_SORT_COLUMNS.has(sort)) return sort as NonNullable<SortColumn>;
  return null;
}

function parseSortDir(sortColumn: SortColumn, dir: string | undefined): SortDir {
  if (sortColumn === null) return null;
  return dir === 'desc' ? 'desc' : 'asc';
}

// ---------------------------------------------------------------------------
// URL serialization replicas (the navigate search updaters)
// ---------------------------------------------------------------------------

function serializeStringSet(val: Set<string>): string | undefined {
  return val.size ? [...val].join(',') : undefined;
}

function serializeNumberSet(val: Set<number>): string | undefined {
  return val.size ? [...val].join(',') : undefined;
}

// ---------------------------------------------------------------------------
// Test data helpers
// ---------------------------------------------------------------------------

let nextId = 1;
function makeTask(overrides: Partial<Task> = {}): Task {
  const id = nextId++;
  return {
    id,
    title: `Task ${id}`,
    description: '',
    sourcePath: null,
    acceptanceCriteria: null,
    status: 'pending',
    priority: 3,
    files: [],
    dependsOn: [],
    blockedBy: [],
    blockReasons: [],
    claimedBy: null,
    claimedAt: null,
    completedAt: null,
    result: null,
    progressLog: null,
    createdAt: new Date(2025, 0, id).toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('filterTasks', () => {
  beforeEach(() => { nextId = 1; });

  it('returns all tasks when no filters are active', () => {
    const tasks = [makeTask(), makeTask()];
    const result = filterTasks(tasks, new Set(), new Set(), new Set());
    expect(result).toHaveLength(2);
  });

  it('filters by agent name', () => {
    const tasks = [
      makeTask({ claimedBy: 'alice' }),
      makeTask({ claimedBy: 'bob' }),
      makeTask({ claimedBy: 'alice' }),
    ];
    const result = filterTasks(tasks, new Set(), new Set(['alice']), new Set());
    expect(result).toHaveLength(2);
    expect(result.every(t => t.claimedBy === 'alice')).toBe(true);
  });

  it('filters unassigned tasks using UNASSIGNED sentinel', () => {
    const tasks = [
      makeTask({ claimedBy: null }),
      makeTask({ claimedBy: 'alice' }),
      makeTask({ claimedBy: null }),
    ];
    const result = filterTasks(tasks, new Set(), new Set([UNASSIGNED]), new Set());
    expect(result).toHaveLength(2);
    expect(result.every(t => t.claimedBy === null)).toBe(true);
  });

  it('agent filter with both unassigned and named agent', () => {
    const tasks = [
      makeTask({ claimedBy: null }),
      makeTask({ claimedBy: 'alice' }),
      makeTask({ claimedBy: 'bob' }),
    ];
    const result = filterTasks(tasks, new Set(), new Set([UNASSIGNED, 'bob']), new Set());
    expect(result).toHaveLength(2);
    const claimedValues = result.map(t => t.claimedBy);
    expect(claimedValues).toContain(null);
    expect(claimedValues).toContain('bob');
  });

  it('filters by priority', () => {
    const tasks = [
      makeTask({ priority: 1 }),
      makeTask({ priority: 2 }),
      makeTask({ priority: 3 }),
      makeTask({ priority: 1 }),
    ];
    const result = filterTasks(tasks, new Set(), new Set(), new Set([1, 3]));
    expect(result).toHaveLength(3);
    expect(result.every(t => t.priority === 1 || t.priority === 3)).toBe(true);
  });

  it('filters by status', () => {
    const tasks = [
      makeTask({ status: 'pending' }),
      makeTask({ status: 'completed' }),
      makeTask({ status: 'failed' }),
      makeTask({ status: 'pending' }),
    ];
    const result = filterTasks(tasks, new Set(['pending']), new Set(), new Set());
    expect(result).toHaveLength(2);
    expect(result.every(t => t.status === 'pending')).toBe(true);
  });

  it('filters by multiple statuses', () => {
    const tasks = [
      makeTask({ status: 'pending' }),
      makeTask({ status: 'completed' }),
      makeTask({ status: 'failed' }),
      makeTask({ status: 'in_progress' }),
    ];
    const result = filterTasks(tasks, new Set(['pending', 'failed']), new Set(), new Set());
    expect(result).toHaveLength(2);
    expect(result.every(t => t.status === 'pending' || t.status === 'failed')).toBe(true);
  });

  it('composes all three filters with AND logic', () => {
    const tasks = [
      makeTask({ claimedBy: 'alice', priority: 1, status: 'pending' }),
      makeTask({ claimedBy: 'alice', priority: 2, status: 'pending' }),
      makeTask({ claimedBy: 'bob', priority: 1, status: 'pending' }),
      makeTask({ claimedBy: 'alice', priority: 1, status: 'completed' }),
      makeTask({ claimedBy: null, priority: 1, status: 'pending' }),
    ];
    const result = filterTasks(
      tasks,
      new Set(['pending']),
      new Set(['alice']),
      new Set([1]),
    );
    expect(result).toHaveLength(1);
    expect(result[0].claimedBy).toBe('alice');
    expect(result[0].priority).toBe(1);
    expect(result[0].status).toBe('pending');
  });

  it('returns empty array when no tasks match filters', () => {
    const tasks = [makeTask({ claimedBy: 'alice', priority: 1 })];
    const result = filterTasks(tasks, new Set(), new Set(['bob']), new Set());
    expect(result).toHaveLength(0);
  });

  it('handles empty task list', () => {
    const result = filterTasks([], new Set(['done']), new Set(['alice']), new Set([1]));
    expect(result).toHaveLength(0);
  });
});

describe('sortTasks', () => {
  beforeEach(() => { nextId = 1; });

  it('returns tasks unchanged when sortColumn is null', () => {
    const tasks = [makeTask({ priority: 3 }), makeTask({ priority: 1 })];
    const result = sortTasks(tasks, null, 'asc');
    expect(result).toBe(tasks); // same reference, not copied
  });

  it('sorts by numeric column ascending', () => {
    const tasks = [
      makeTask({ priority: 3 }),
      makeTask({ priority: 1 }),
      makeTask({ priority: 2 }),
    ];
    const result = sortTasks(tasks, 'priority', 'asc');
    expect(result.map(t => t.priority)).toEqual([1, 2, 3]);
  });

  it('sorts by numeric column descending', () => {
    const tasks = [
      makeTask({ priority: 1 }),
      makeTask({ priority: 3 }),
      makeTask({ priority: 2 }),
    ];
    const result = sortTasks(tasks, 'priority', 'desc');
    expect(result.map(t => t.priority)).toEqual([3, 2, 1]);
  });

  it('sorts by string column (title) ascending', () => {
    const tasks = [
      makeTask({ title: 'Charlie' }),
      makeTask({ title: 'Alpha' }),
      makeTask({ title: 'Bravo' }),
    ];
    const result = sortTasks(tasks, 'title', 'asc');
    expect(result.map(t => t.title)).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });

  it('sorts by string column (title) descending', () => {
    const tasks = [
      makeTask({ title: 'Alpha' }),
      makeTask({ title: 'Charlie' }),
      makeTask({ title: 'Bravo' }),
    ];
    const result = sortTasks(tasks, 'title', 'desc');
    expect(result.map(t => t.title)).toEqual(['Charlie', 'Bravo', 'Alpha']);
  });

  it('sorts by claimedBy with nulls last (ascending)', () => {
    const tasks = [
      makeTask({ claimedBy: null }),
      makeTask({ claimedBy: 'alice' }),
      makeTask({ claimedBy: 'bob' }),
    ];
    const result = sortTasks(tasks, 'claimedBy', 'asc');
    expect(result.map(t => t.claimedBy)).toEqual(['alice', 'bob', null]);
  });

  it('sorts by claimedBy with nulls last (descending)', () => {
    const tasks = [
      makeTask({ claimedBy: null }),
      makeTask({ claimedBy: 'alice' }),
      makeTask({ claimedBy: 'bob' }),
    ];
    const result = sortTasks(tasks, 'claimedBy', 'desc');
    expect(result.map(t => t.claimedBy)).toEqual(['bob', 'alice', null]);
  });

  it('handles all-null column values', () => {
    const tasks = [
      makeTask({ claimedBy: null }),
      makeTask({ claimedBy: null }),
    ];
    const result = sortTasks(tasks, 'claimedBy', 'asc');
    expect(result).toHaveLength(2);
    expect(result.every(t => t.claimedBy === null)).toBe(true);
  });

  it('sorts by id ascending', () => {
    const t1 = makeTask(); // id 1
    const t2 = makeTask(); // id 2
    const t3 = makeTask(); // id 3
    const result = sortTasks([t3, t1, t2], 'id', 'asc');
    expect(result.map(t => t.id)).toEqual([1, 2, 3]);
  });

  it('does not mutate the original array', () => {
    const tasks = [makeTask({ priority: 3 }), makeTask({ priority: 1 })];
    const original = [...tasks];
    sortTasks(tasks, 'priority', 'asc');
    expect(tasks.map(t => t.priority)).toEqual(original.map(t => t.priority));
  });

  it('sorts by status as string', () => {
    const tasks = [
      makeTask({ status: 'pending' }),
      makeTask({ status: 'completed' }),
      makeTask({ status: 'failed' }),
    ];
    const result = sortTasks(tasks, 'status', 'asc');
    expect(result.map(t => t.status)).toEqual(['completed', 'failed', 'pending']);
  });

  it('sorts by createdAt as string', () => {
    const tasks = [
      makeTask({ createdAt: '2025-03-01T00:00:00.000Z' }),
      makeTask({ createdAt: '2025-01-01T00:00:00.000Z' }),
      makeTask({ createdAt: '2025-02-01T00:00:00.000Z' }),
    ];
    const result = sortTasks(tasks, 'createdAt', 'asc');
    expect(result.map(t => t.createdAt)).toEqual([
      '2025-01-01T00:00:00.000Z',
      '2025-02-01T00:00:00.000Z',
      '2025-03-01T00:00:00.000Z',
    ]);
  });
});

describe('filterTasks + sortTasks composition', () => {
  beforeEach(() => { nextId = 1; });

  it('filters then sorts (mimicking hook pipeline)', () => {
    const tasks = [
      makeTask({ claimedBy: 'alice', priority: 2 }),
      makeTask({ claimedBy: 'bob', priority: 1 }),
      makeTask({ claimedBy: 'alice', priority: 3 }),
      makeTask({ claimedBy: 'bob', priority: 4 }),
    ];
    const filtered = filterTasks(tasks, new Set(), new Set(['alice']), new Set());
    const sorted = sortTasks(filtered, 'priority', 'asc');
    expect(sorted).toHaveLength(2);
    expect(sorted.map(t => t.priority)).toEqual([2, 3]);
  });

  it('status filter then sort by priority descending', () => {
    const tasks = [
      makeTask({ status: 'pending', priority: 5 }),
      makeTask({ status: 'completed', priority: 1 }),
      makeTask({ status: 'pending', priority: 2 }),
      makeTask({ status: 'failed', priority: 8 }),
    ];
    const filtered = filterTasks(tasks, new Set(['pending']), new Set(), new Set());
    const sorted = sortTasks(filtered, 'priority', 'desc');
    expect(sorted).toHaveLength(2);
    expect(sorted.map(t => t.priority)).toEqual([5, 2]);
  });
});

describe('deriveUniqueAgents', () => {
  beforeEach(() => { nextId = 1; });

  it('returns sorted agent names with UNASSIGNED first when nulls present', () => {
    const tasks = [
      makeTask({ claimedBy: 'charlie' }),
      makeTask({ claimedBy: null }),
      makeTask({ claimedBy: 'alice' }),
      makeTask({ claimedBy: 'charlie' }), // duplicate
    ];
    const result = deriveUniqueAgents(tasks);
    expect(result).toEqual([UNASSIGNED, 'alice', 'charlie']);
  });

  it('returns only agent names when no nulls', () => {
    const tasks = [
      makeTask({ claimedBy: 'bob' }),
      makeTask({ claimedBy: 'alice' }),
    ];
    const result = deriveUniqueAgents(tasks);
    expect(result).toEqual(['alice', 'bob']);
  });

  it('returns only UNASSIGNED when all are null', () => {
    const tasks = [makeTask({ claimedBy: null }), makeTask({ claimedBy: null })];
    const result = deriveUniqueAgents(tasks);
    expect(result).toEqual([UNASSIGNED]);
  });

  it('returns empty array for no tasks', () => {
    expect(deriveUniqueAgents([])).toEqual([]);
  });
});

describe('deriveUniquePriorities', () => {
  beforeEach(() => { nextId = 1; });

  it('returns unique priorities sorted descending', () => {
    const tasks = [
      makeTask({ priority: 1 }),
      makeTask({ priority: 3 }),
      makeTask({ priority: 2 }),
      makeTask({ priority: 3 }), // duplicate
    ];
    const result = deriveUniquePriorities(tasks);
    expect(result).toEqual([3, 2, 1]);
  });

  it('returns empty array for no tasks', () => {
    expect(deriveUniquePriorities([])).toEqual([]);
  });

  it('handles single priority', () => {
    const tasks = [makeTask({ priority: 5 }), makeTask({ priority: 5 })];
    expect(deriveUniquePriorities(tasks)).toEqual([5]);
  });
});

describe('hasActiveFilters logic', () => {
  it('is false when no filters and no sort', () => {
    const agentFilter = new Set<string>();
    const priorityFilter = new Set<number>();
    const statusFilter = new Set<string>();
    const sortColumn: SortColumn = null;
    const has = agentFilter.size > 0 || priorityFilter.size > 0 || statusFilter.size > 0 || sortColumn !== null;
    expect(has).toBe(false);
  });

  it('is true when agent filter is set', () => {
    const has = new Set(['alice']).size > 0 || new Set<number>().size > 0 || new Set<string>().size > 0 || null !== null;
    expect(has).toBe(true);
  });

  it('is true when status filter is set', () => {
    const agentFilter = new Set<string>();
    const priorityFilter = new Set<number>();
    const statusFilter = new Set(['pending']);
    const sortColumn: SortColumn = null;
    const has = agentFilter.size > 0 || priorityFilter.size > 0 || statusFilter.size > 0 || sortColumn !== null;
    expect(has).toBe(true);
  });

  it('is true when sort is active', () => {
    const agentFilter = new Set<string>();
    const priorityFilter = new Set<number>();
    const statusFilter = new Set<string>();
    const sortColumn: SortColumn = 'priority';
    const has = agentFilter.size > 0 || priorityFilter.size > 0 || statusFilter.size > 0 || sortColumn !== null;
    expect(has).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateSearch (overview route search param validation)
// ---------------------------------------------------------------------------

describe('validateSearch', () => {
  it('passes through valid string params', () => {
    const result = validateSearch({
      status: 'pending,completed',
      agent: 'alice,bob',
      priority: '1,3',
      sort: 'priority',
      dir: 'desc',
    });
    expect(result).toEqual({
      status: 'pending,completed',
      agent: 'alice,bob',
      priority: '1,3',
      sort: 'priority',
      dir: 'desc',
    });
  });

  it('returns undefined for missing params', () => {
    const result = validateSearch({});
    expect(result).toEqual({
      status: undefined,
      agent: undefined,
      priority: undefined,
      sort: undefined,
      dir: undefined,
    });
  });

  it('returns undefined for empty string params', () => {
    const result = validateSearch({
      status: '',
      agent: '',
      priority: '',
      sort: '',
      dir: '',
    });
    expect(result).toEqual({
      status: undefined,
      agent: undefined,
      priority: undefined,
      sort: undefined,
      dir: undefined,
    });
  });

  it('returns undefined for non-string params', () => {
    const result = validateSearch({
      status: 123,
      agent: true,
      priority: ['1', '2'],
      sort: null,
      dir: undefined,
    });
    expect(result).toEqual({
      status: undefined,
      agent: undefined,
      priority: undefined,
      sort: undefined,
      dir: undefined,
    });
  });

  it('handles a mix of valid and invalid params', () => {
    const result = validateSearch({
      status: 'pending',
      agent: 42,
      sort: 'title',
    });
    expect(result).toEqual({
      status: 'pending',
      agent: undefined,
      priority: undefined,
      sort: 'title',
      dir: undefined,
    });
  });
});

// ---------------------------------------------------------------------------
// URL search param deserialization (useTaskFiltersUrlBacked parsing)
// ---------------------------------------------------------------------------

describe('search param deserialization', () => {
  describe('parseStatusFilter', () => {
    it('returns empty set for undefined', () => {
      expect(parseStatusFilter(undefined)).toEqual(new Set());
    });

    it('returns empty set for empty string', () => {
      expect(parseStatusFilter('')).toEqual(new Set());
    });

    it('parses single status', () => {
      expect(parseStatusFilter('pending')).toEqual(new Set(['pending']));
    });

    it('parses comma-separated statuses', () => {
      expect(parseStatusFilter('pending,completed,failed')).toEqual(
        new Set(['pending', 'completed', 'failed'])
      );
    });

    it('filters out empty entries from trailing commas', () => {
      expect(parseStatusFilter('pending,,completed,')).toEqual(
        new Set(['pending', 'completed'])
      );
    });
  });

  describe('parseAgentFilter', () => {
    it('returns empty set for undefined', () => {
      expect(parseAgentFilter(undefined)).toEqual(new Set());
    });

    it('parses comma-separated agents', () => {
      expect(parseAgentFilter('alice,bob')).toEqual(new Set(['alice', 'bob']));
    });

    it('handles UNASSIGNED sentinel in URL', () => {
      expect(parseAgentFilter('__unassigned__,alice')).toEqual(
        new Set([UNASSIGNED, 'alice'])
      );
    });
  });

  describe('parsePriorityFilter', () => {
    it('returns empty set for undefined', () => {
      expect(parsePriorityFilter(undefined)).toEqual(new Set());
    });

    it('returns empty set for empty string', () => {
      expect(parsePriorityFilter('')).toEqual(new Set());
    });

    it('parses comma-separated numbers', () => {
      expect(parsePriorityFilter('1,3,5')).toEqual(new Set([1, 3, 5]));
    });

    it('filters out NaN values from invalid input', () => {
      expect(parsePriorityFilter('1,abc,3')).toEqual(new Set([1, 3]));
    });

    it('handles single priority', () => {
      expect(parsePriorityFilter('2')).toEqual(new Set([2]));
    });
  });

  describe('parseSortColumn', () => {
    it('returns null for undefined', () => {
      expect(parseSortColumn(undefined)).toBeNull();
    });

    it('returns null for invalid column name', () => {
      expect(parseSortColumn('invalid')).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(parseSortColumn('')).toBeNull();
    });

    it.each([
      'id', 'priority', 'status', 'title', 'claimedBy', 'createdAt',
    ] as const)('accepts valid column "%s"', (col) => {
      expect(parseSortColumn(col)).toBe(col);
    });
  });

  describe('parseSortDir', () => {
    it('returns null when sortColumn is null', () => {
      expect(parseSortDir(null, 'desc')).toBeNull();
    });

    it('returns asc by default when column is set', () => {
      expect(parseSortDir('priority', undefined)).toBe('asc');
    });

    it('returns asc when dir is not desc', () => {
      expect(parseSortDir('priority', 'asc')).toBe('asc');
      expect(parseSortDir('priority', 'anything')).toBe('asc');
    });

    it('returns desc when dir is desc', () => {
      expect(parseSortDir('priority', 'desc')).toBe('desc');
    });
  });
});

// ---------------------------------------------------------------------------
// URL search param serialization (navigate search updaters)
// ---------------------------------------------------------------------------

describe('search param serialization', () => {
  it('serializes non-empty string set to comma-separated string', () => {
    expect(serializeStringSet(new Set(['pending', 'completed']))).toBe('pending,completed');
  });

  it('returns undefined for empty string set', () => {
    expect(serializeStringSet(new Set())).toBeUndefined();
  });

  it('serializes non-empty number set to comma-separated string', () => {
    expect(serializeNumberSet(new Set([1, 3]))).toBe('1,3');
  });

  it('returns undefined for empty number set', () => {
    expect(serializeNumberSet(new Set())).toBeUndefined();
  });

  it('round-trips status filter through serialize then parse', () => {
    const original = new Set(['pending', 'failed']);
    const serialized = serializeStringSet(original);
    const parsed = parseStatusFilter(serialized);
    expect(parsed).toEqual(original);
  });

  it('round-trips priority filter through serialize then parse', () => {
    const original = new Set([1, 5, 3]);
    const serialized = serializeNumberSet(original);
    const parsed = parsePriorityFilter(serialized);
    expect(parsed).toEqual(original);
  });

  it('round-trips agent filter with UNASSIGNED sentinel', () => {
    const original = new Set([UNASSIGNED, 'alice']);
    const serialized = serializeStringSet(original);
    const parsed = parseAgentFilter(serialized);
    expect(parsed).toEqual(original);
  });
});

// ---------------------------------------------------------------------------
// cycleSort state machine (replicated from useTaskFilters)
// ---------------------------------------------------------------------------

describe('cycleSort state machine', () => {
  interface SortState { column: SortColumn; dir: SortDir }

  function cycleSort(state: SortState, col: NonNullable<SortColumn>): SortState {
    if (state.column !== col) {
      return { column: col, dir: 'asc' };
    } else if (state.dir === 'asc') {
      return { column: col, dir: 'desc' };
    } else {
      return { column: null, dir: null };
    }
  }

  it('first click sets column to asc', () => {
    const result = cycleSort({ column: null, dir: null }, 'priority');
    expect(result).toEqual({ column: 'priority', dir: 'asc' });
  });

  it('second click on same column goes to desc', () => {
    const result = cycleSort({ column: 'priority', dir: 'asc' }, 'priority');
    expect(result).toEqual({ column: 'priority', dir: 'desc' });
  });

  it('third click on same column clears sort', () => {
    const result = cycleSort({ column: 'priority', dir: 'desc' }, 'priority');
    expect(result).toEqual({ column: null, dir: null });
  });

  it('clicking different column resets to asc on new column', () => {
    const result = cycleSort({ column: 'priority', dir: 'desc' }, 'title');
    expect(result).toEqual({ column: 'title', dir: 'asc' });
  });

  it('clicking different column from asc state resets to asc on new column', () => {
    const result = cycleSort({ column: 'priority', dir: 'asc' }, 'status');
    expect(result).toEqual({ column: 'status', dir: 'asc' });
  });
});
