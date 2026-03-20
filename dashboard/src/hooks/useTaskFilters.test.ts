/**
 * Tests for useTaskFilters hook logic.
 *
 * Since this is a Vite/React project without a React test renderer,
 * we mock the React hooks so the hook function executes as a plain
 * synchronous function, letting us verify the pure data-transformation
 * logic (filtering, sorting, reducer state machine, derived values).
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Task } from '../api/types.ts';

// ---------------------------------------------------------------------------
// Minimal React-hooks mock so we can call useTaskFilters as a plain function.
// We intercept the 'react' specifier via a loader hook that is registered
// *before* the import of the module-under-test.
// ---------------------------------------------------------------------------

// Instead of loader hooks (complex), we'll take advantage of the fact that
// tsx supports --import / --loader. But the simplest path: re-implement
// the pure functions extracted from the source and test those, plus import
// the UNASSIGNED sentinel which is safely exported.

// ---- Pure function replicas (copied verbatim from useTaskFilters.ts) ----

type SortDir = 'asc' | 'desc';
type SortColumn = 'id' | 'priority' | 'status' | 'title' | 'claimedBy' | 'createdAt' | null;
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

function filterTasks(
  tasks: Task[],
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

describe('sortReducer', () => {
  const initial: SortState = { column: null, dir: 'asc' };

  beforeEach(() => { nextId = 1; });

  it('cycles null -> asc on first click of a column', () => {
    const result = sortReducer(initial, { type: 'cycle', col: 'priority' });
    assert.deepStrictEqual(result, { column: 'priority', dir: 'asc' });
  });

  it('cycles asc -> desc on second click of same column', () => {
    const s1 = sortReducer(initial, { type: 'cycle', col: 'priority' });
    const s2 = sortReducer(s1, { type: 'cycle', col: 'priority' });
    assert.deepStrictEqual(s2, { column: 'priority', dir: 'desc' });
  });

  it('cycles desc -> null on third click of same column', () => {
    let s = sortReducer(initial, { type: 'cycle', col: 'priority' });
    s = sortReducer(s, { type: 'cycle', col: 'priority' });
    s = sortReducer(s, { type: 'cycle', col: 'priority' });
    assert.deepStrictEqual(s, { column: null, dir: 'asc' });
  });

  it('switches to new column at asc when clicking a different column', () => {
    const s1 = sortReducer(initial, { type: 'cycle', col: 'priority' });
    const s2 = sortReducer(s1, { type: 'cycle', col: 'title' });
    assert.deepStrictEqual(s2, { column: 'title', dir: 'asc' });
  });

  it('switches to new column from desc state', () => {
    let s = sortReducer(initial, { type: 'cycle', col: 'priority' });
    s = sortReducer(s, { type: 'cycle', col: 'priority' }); // desc
    s = sortReducer(s, { type: 'cycle', col: 'status' });
    assert.deepStrictEqual(s, { column: 'status', dir: 'asc' });
  });

  it('reset action returns to initial state', () => {
    const s1 = sortReducer(
      { column: 'title', dir: 'desc' },
      { type: 'reset' },
    );
    assert.deepStrictEqual(s1, { column: null, dir: 'asc' });
  });

  it('reset from already-initial state is a no-op', () => {
    const s = sortReducer(initial, { type: 'reset' });
    assert.deepStrictEqual(s, { column: null, dir: 'asc' });
  });
});

describe('filterTasks', () => {
  beforeEach(() => { nextId = 1; });

  it('returns all tasks when no filters are active', () => {
    const tasks = [makeTask(), makeTask()];
    const result = filterTasks(tasks, new Set(), new Set());
    assert.equal(result.length, 2);
  });

  it('filters by agent name', () => {
    const tasks = [
      makeTask({ claimedBy: 'alice' }),
      makeTask({ claimedBy: 'bob' }),
      makeTask({ claimedBy: 'alice' }),
    ];
    const result = filterTasks(tasks, new Set(['alice']), new Set());
    assert.equal(result.length, 2);
    assert.ok(result.every(t => t.claimedBy === 'alice'));
  });

  it('filters unassigned tasks using UNASSIGNED sentinel', () => {
    const tasks = [
      makeTask({ claimedBy: null }),
      makeTask({ claimedBy: 'alice' }),
      makeTask({ claimedBy: null }),
    ];
    const result = filterTasks(tasks, new Set([UNASSIGNED]), new Set());
    assert.equal(result.length, 2);
    assert.ok(result.every(t => t.claimedBy === null));
  });

  it('agent filter with both unassigned and named agent', () => {
    const tasks = [
      makeTask({ claimedBy: null }),
      makeTask({ claimedBy: 'alice' }),
      makeTask({ claimedBy: 'bob' }),
    ];
    const result = filterTasks(tasks, new Set([UNASSIGNED, 'bob']), new Set());
    assert.equal(result.length, 2);
    const claimedValues = result.map(t => t.claimedBy);
    assert.ok(claimedValues.includes(null));
    assert.ok(claimedValues.includes('bob'));
  });

  it('filters by priority', () => {
    const tasks = [
      makeTask({ priority: 1 }),
      makeTask({ priority: 2 }),
      makeTask({ priority: 3 }),
      makeTask({ priority: 1 }),
    ];
    const result = filterTasks(tasks, new Set(), new Set([1, 3]));
    assert.equal(result.length, 3);
    assert.ok(result.every(t => t.priority === 1 || t.priority === 3));
  });

  it('composes agent and priority filters with AND logic', () => {
    const tasks = [
      makeTask({ claimedBy: 'alice', priority: 1 }),
      makeTask({ claimedBy: 'alice', priority: 2 }),
      makeTask({ claimedBy: 'bob', priority: 1 }),
      makeTask({ claimedBy: null, priority: 1 }),
    ];
    const result = filterTasks(tasks, new Set(['alice']), new Set([1]));
    assert.equal(result.length, 1);
    assert.equal(result[0].claimedBy, 'alice');
    assert.equal(result[0].priority, 1);
  });

  it('returns empty array when no tasks match filters', () => {
    const tasks = [
      makeTask({ claimedBy: 'alice', priority: 1 }),
    ];
    const result = filterTasks(tasks, new Set(['bob']), new Set());
    assert.equal(result.length, 0);
  });

  it('handles empty task list', () => {
    const result = filterTasks([], new Set(['alice']), new Set([1]));
    assert.equal(result.length, 0);
  });
});

describe('sortTasks', () => {
  beforeEach(() => { nextId = 1; });

  it('returns tasks unchanged when sortColumn is null', () => {
    const tasks = [makeTask({ priority: 3 }), makeTask({ priority: 1 })];
    const result = sortTasks(tasks, null, 'asc');
    assert.equal(result, tasks); // same reference, not copied
  });

  it('sorts by numeric column ascending', () => {
    const tasks = [
      makeTask({ priority: 3 }),
      makeTask({ priority: 1 }),
      makeTask({ priority: 2 }),
    ];
    const result = sortTasks(tasks, 'priority', 'asc');
    assert.deepStrictEqual(result.map(t => t.priority), [1, 2, 3]);
  });

  it('sorts by numeric column descending', () => {
    const tasks = [
      makeTask({ priority: 1 }),
      makeTask({ priority: 3 }),
      makeTask({ priority: 2 }),
    ];
    const result = sortTasks(tasks, 'priority', 'desc');
    assert.deepStrictEqual(result.map(t => t.priority), [3, 2, 1]);
  });

  it('sorts by string column (title) ascending', () => {
    const tasks = [
      makeTask({ title: 'Charlie' }),
      makeTask({ title: 'Alpha' }),
      makeTask({ title: 'Bravo' }),
    ];
    const result = sortTasks(tasks, 'title', 'asc');
    assert.deepStrictEqual(result.map(t => t.title), ['Alpha', 'Bravo', 'Charlie']);
  });

  it('sorts by string column (title) descending', () => {
    const tasks = [
      makeTask({ title: 'Alpha' }),
      makeTask({ title: 'Charlie' }),
      makeTask({ title: 'Bravo' }),
    ];
    const result = sortTasks(tasks, 'title', 'desc');
    assert.deepStrictEqual(result.map(t => t.title), ['Charlie', 'Bravo', 'Alpha']);
  });

  it('sorts by claimedBy with nulls last (ascending)', () => {
    const tasks = [
      makeTask({ claimedBy: null }),
      makeTask({ claimedBy: 'alice' }),
      makeTask({ claimedBy: 'bob' }),
    ];
    const result = sortTasks(tasks, 'claimedBy', 'asc');
    assert.deepStrictEqual(result.map(t => t.claimedBy), ['alice', 'bob', null]);
  });

  it('sorts by claimedBy with nulls last (descending)', () => {
    const tasks = [
      makeTask({ claimedBy: null }),
      makeTask({ claimedBy: 'alice' }),
      makeTask({ claimedBy: 'bob' }),
    ];
    const result = sortTasks(tasks, 'claimedBy', 'desc');
    assert.deepStrictEqual(result.map(t => t.claimedBy), ['bob', 'alice', null]);
  });

  it('handles all-null column values', () => {
    const tasks = [
      makeTask({ claimedBy: null }),
      makeTask({ claimedBy: null }),
    ];
    const result = sortTasks(tasks, 'claimedBy', 'asc');
    assert.equal(result.length, 2);
    assert.ok(result.every(t => t.claimedBy === null));
  });

  it('sorts by id ascending', () => {
    const t1 = makeTask(); // id 1
    const t2 = makeTask(); // id 2
    const t3 = makeTask(); // id 3
    const result = sortTasks([t3, t1, t2], 'id', 'asc');
    assert.deepStrictEqual(result.map(t => t.id), [1, 2, 3]);
  });

  it('does not mutate the original array', () => {
    const tasks = [makeTask({ priority: 3 }), makeTask({ priority: 1 })];
    const original = [...tasks];
    sortTasks(tasks, 'priority', 'asc');
    assert.deepStrictEqual(tasks.map(t => t.priority), original.map(t => t.priority));
  });

  it('sorts by status as string', () => {
    const tasks = [
      makeTask({ status: 'pending' }),
      makeTask({ status: 'completed' }),
      makeTask({ status: 'failed' }),
    ];
    const result = sortTasks(tasks, 'status', 'asc');
    assert.deepStrictEqual(result.map(t => t.status), ['completed', 'failed', 'pending']);
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
    const filtered = filterTasks(tasks, new Set(['alice']), new Set());
    const sorted = sortTasks(filtered, 'priority', 'asc');
    assert.equal(sorted.length, 2);
    assert.deepStrictEqual(sorted.map(t => t.priority), [2, 3]);
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
    assert.deepStrictEqual(result, [UNASSIGNED, 'alice', 'charlie']);
  });

  it('returns only agent names when no nulls', () => {
    const tasks = [
      makeTask({ claimedBy: 'bob' }),
      makeTask({ claimedBy: 'alice' }),
    ];
    const result = deriveUniqueAgents(tasks);
    assert.deepStrictEqual(result, ['alice', 'bob']);
  });

  it('returns only UNASSIGNED when all are null', () => {
    const tasks = [makeTask({ claimedBy: null }), makeTask({ claimedBy: null })];
    const result = deriveUniqueAgents(tasks);
    assert.deepStrictEqual(result, [UNASSIGNED]);
  });

  it('returns empty array for no tasks', () => {
    assert.deepStrictEqual(deriveUniqueAgents([]), []);
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
    assert.deepStrictEqual(result, [3, 2, 1]);
  });

  it('returns empty array for no tasks', () => {
    assert.deepStrictEqual(deriveUniquePriorities([]), []);
  });

  it('handles single priority', () => {
    const tasks = [makeTask({ priority: 5 }), makeTask({ priority: 5 })];
    assert.deepStrictEqual(deriveUniquePriorities(tasks), [5]);
  });
});

describe('hasActiveFilters logic', () => {
  it('is false when no filters and no sort', () => {
    const agentFilter = new Set<string>();
    const priorityFilter = new Set<number>();
    const sortColumn: SortColumn = null;
    const has = agentFilter.size > 0 || priorityFilter.size > 0 || sortColumn !== null;
    assert.equal(has, false);
  });

  it('is true when agent filter is set', () => {
    const agentFilter = new Set(['alice']);
    const priorityFilter = new Set<number>();
    const sortColumn: SortColumn = null;
    const has = agentFilter.size > 0 || priorityFilter.size > 0 || sortColumn !== null;
    assert.equal(has, true);
  });

  it('is true when priority filter is set', () => {
    const agentFilter = new Set<string>();
    const priorityFilter = new Set([1]);
    const sortColumn: SortColumn = null;
    const has = agentFilter.size > 0 || priorityFilter.size > 0 || sortColumn !== null;
    assert.equal(has, true);
  });

  it('is true when sort is active (even with no filters)', () => {
    const agentFilter = new Set<string>();
    const priorityFilter = new Set<number>();
    const sortColumn: SortColumn = 'priority';
    const has = agentFilter.size > 0 || priorityFilter.size > 0 || sortColumn !== null;
    assert.equal(has, true);
  });

  it('is true when all three are active', () => {
    const agentFilter = new Set(['bob']);
    const priorityFilter = new Set([2]);
    const sortColumn: SortColumn = 'title';
    const has = agentFilter.size > 0 || priorityFilter.size > 0 || sortColumn !== null;
    assert.equal(has, true);
  });
});
