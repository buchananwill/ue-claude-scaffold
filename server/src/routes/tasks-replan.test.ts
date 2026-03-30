import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, createTestConfig, type TestContext } from '../test-helper.js';
import { db } from '../db.js';
import tasksPlugin from './tasks.js';

describe('tasks-replan routes', () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = await createTestApp();
    const config = createTestConfig();
    await ctx.app.register(tasksPlugin, { config });
  });

  afterEach(async () => {
    await ctx.app.close();
    ctx.cleanup();
  });

  describe('POST /tasks/replan', () => {
    /** Helper: create a task and return its id */
    async function createTask(title: string, priority?: number, dependsOn?: number[]): Promise<number> {
      const payload: Record<string, unknown> = { title };
      if (priority !== undefined) payload.priority = priority;
      if (dependsOn !== undefined) payload.dependsOn = dependsOn;
      const res = await ctx.app.inject({ method: 'POST', url: '/tasks', payload });
      assert.equal(res.statusCode, 200, `createTask '${title}' failed: ${res.body}`);
      return res.json().id;
    }

    /** Helper: add a dependency edge via direct DB insert (needed for cycles) */
    function addDep(taskId: number, dependsOn: number): void {
      db.prepare('INSERT OR IGNORE INTO task_dependencies (task_id, depends_on) VALUES (?, ?)').run(taskId, dependsOn);
    }

    it('empty queue returns zero counts', async () => {
      const res = await ctx.app.inject({ method: 'POST', url: '/tasks/replan' });
      assert.equal(res.statusCode, 200);
      const body = res.json();
      assert.deepEqual(body, { ok: true, replanned: 0, cycles: [], maxPriority: 0, roots: [] });
    });

    it('tasks with no dependencies returns all as roots with unchanged priorities', async () => {
      const idA = await createTask('A', 1);
      const idB = await createTask('B', 2);
      const idC = await createTask('C', 3);

      const res = await ctx.app.inject({ method: 'POST', url: '/tasks/replan' });
      assert.equal(res.statusCode, 200);
      const body = res.json();

      assert.equal(body.ok, true);
      assert.equal(body.replanned, 3);
      assert.deepEqual(body.cycles, []);
      assert.deepEqual(body.roots.sort((a: number, b: number) => a - b), [idA, idB, idC].sort((a, b) => a - b));

      // Verify priorities unchanged by fetching each task
      const tA = (await ctx.app.inject({ method: 'GET', url: `/tasks/${idA}` })).json();
      const tB = (await ctx.app.inject({ method: 'GET', url: `/tasks/${idB}` })).json();
      const tC = (await ctx.app.inject({ method: 'GET', url: `/tasks/${idC}` })).json();
      assert.equal(tA.priority, 1);
      assert.equal(tB.priority, 2);
      assert.equal(tC.priority, 3);
    });

    it('detects three-node cycle A->B->C->A', async () => {
      const idA = await createTask('A', 1);
      const idB = await createTask('B', 1);
      const idC = await createTask('C', 1);

      // A depends on B, B depends on C, C depends on A
      addDep(idA, idB);
      addDep(idB, idC);
      addDep(idC, idA);

      const res = await ctx.app.inject({ method: 'POST', url: '/tasks/replan' });
      assert.equal(res.statusCode, 200);
      const body = res.json();

      // All three should be in a cycle
      const tA = (await ctx.app.inject({ method: 'GET', url: `/tasks/${idA}` })).json();
      const tB = (await ctx.app.inject({ method: 'GET', url: `/tasks/${idB}` })).json();
      const tC = (await ctx.app.inject({ method: 'GET', url: `/tasks/${idC}` })).json();
      assert.equal(tA.status, 'cycle');
      assert.equal(tB.status, 'cycle');
      assert.equal(tC.status, 'cycle');

      assert.equal(body.cycles.length, 1);
      const cycleTaskIds = body.cycles[0].taskIds.sort((a: number, b: number) => a - b);
      assert.deepEqual(cycleTaskIds, [idA, idB, idC].sort((a, b) => a - b));
    });

    it('detects direct mutual cycle A<->B', async () => {
      const idA = await createTask('A', 1);
      const idB = await createTask('B', 1);

      // A depends on B, B depends on A
      addDep(idA, idB);
      addDep(idB, idA);

      const res = await ctx.app.inject({ method: 'POST', url: '/tasks/replan' });
      assert.equal(res.statusCode, 200);
      const body = res.json();

      const tA = (await ctx.app.inject({ method: 'GET', url: `/tasks/${idA}` })).json();
      const tB = (await ctx.app.inject({ method: 'GET', url: `/tasks/${idB}` })).json();
      assert.equal(tA.status, 'cycle');
      assert.equal(tB.status, 'cycle');

      assert.equal(body.cycles.length, 1);
      const cycleTaskIds = body.cycles[0].taskIds.sort((a: number, b: number) => a - b);
      assert.deepEqual(cycleTaskIds, [idA, idB].sort((a, b) => a - b));
    });

    it('does not affect acyclic tasks when cycle exists', async () => {
      const idA = await createTask('A', 1);
      const idB = await createTask('B', 1);
      const idC = await createTask('C', 5);

      // A<->B cycle, C is independent
      addDep(idA, idB);
      addDep(idB, idA);

      const res = await ctx.app.inject({ method: 'POST', url: '/tasks/replan' });
      assert.equal(res.statusCode, 200);

      const tA = (await ctx.app.inject({ method: 'GET', url: `/tasks/${idA}` })).json();
      const tB = (await ctx.app.inject({ method: 'GET', url: `/tasks/${idB}` })).json();
      const tC = (await ctx.app.inject({ method: 'GET', url: `/tasks/${idC}` })).json();
      assert.equal(tA.status, 'cycle');
      assert.equal(tB.status, 'cycle');
      assert.equal(tC.status, 'pending');
    });

    it('priority accumulation through chain', async () => {
      // Root (p=0, no deps) <- Middle (p=0, depends on Root) <- Leaf (p=10, depends on Middle)
      // Priority flows leaves->roots: Root accumulates all downstream weight.
      const idRoot = await createTask('Root', 0);
      const idMiddle = await createTask('Middle', 0, [idRoot]);
      const idLeaf = await createTask('Leaf', 10, [idMiddle]);

      const res = await ctx.app.inject({ method: 'POST', url: '/tasks/replan' });
      assert.equal(res.statusCode, 200);

      const tRoot = (await ctx.app.inject({ method: 'GET', url: `/tasks/${idRoot}` })).json();
      const tMiddle = (await ctx.app.inject({ method: 'GET', url: `/tasks/${idMiddle}` })).json();
      const tLeaf = (await ctx.app.inject({ method: 'GET', url: `/tasks/${idLeaf}` })).json();

      assert.equal(tLeaf.priority, 10);   // leaf: keeps base priority
      assert.equal(tMiddle.priority, 11); // 0 + (10 + 1) from child Leaf
      assert.equal(tRoot.priority, 12);   // 0 + (11 + 1) from child Middle
    });

    it('idempotent: calling twice returns same priorities', async () => {
      const idRoot = await createTask('Root', 0);
      const idMiddle = await createTask('Middle', 0, [idRoot]);
      const idLeaf = await createTask('Leaf', 10, [idMiddle]);

      // First replan
      await ctx.app.inject({ method: 'POST', url: '/tasks/replan' });
      const tRoot1 = (await ctx.app.inject({ method: 'GET', url: `/tasks/${idRoot}` })).json();
      const tMiddle1 = (await ctx.app.inject({ method: 'GET', url: `/tasks/${idMiddle}` })).json();
      const tLeaf1 = (await ctx.app.inject({ method: 'GET', url: `/tasks/${idLeaf}` })).json();

      // Second replan
      await ctx.app.inject({ method: 'POST', url: '/tasks/replan' });
      const tRoot2 = (await ctx.app.inject({ method: 'GET', url: `/tasks/${idRoot}` })).json();
      const tMiddle2 = (await ctx.app.inject({ method: 'GET', url: `/tasks/${idMiddle}` })).json();
      const tLeaf2 = (await ctx.app.inject({ method: 'GET', url: `/tasks/${idLeaf}` })).json();

      assert.equal(tRoot1.priority, tRoot2.priority);
      assert.equal(tMiddle1.priority, tMiddle2.priority);
      assert.equal(tLeaf1.priority, tLeaf2.priority);
    });

    it('invariant: every dependency has priority >= its dependents', async () => {
      // Build a non-trivial DAG:
      //   A (p=0) <- B (p=0) <- D (p=10)
      //   A (p=0) <- C (p=5) <- E (p=3)
      // After replan, A must have the highest priority (blocks everything).
      // Every parent must have priority >= each of its children.
      const idA = await createTask('A', 0);
      const idB = await createTask('B', 0, [idA]);
      const idC = await createTask('C', 5, [idA]);
      const idD = await createTask('D', 10, [idB]);
      const idE = await createTask('E', 3, [idC]);

      await ctx.app.inject({ method: 'POST', url: '/tasks/replan' });

      const tasks = await Promise.all(
        [idA, idB, idC, idD, idE].map(async (id) =>
          (await ctx.app.inject({ method: 'GET', url: `/tasks/${id}` })).json()
        )
      );
      const byId = new Map(tasks.map((t: { id: number; title: string; priority: number }) => [t.id, t]));

      // Check invariant: for every dependency edge, the parent's priority is strictly
      // greater than the child's. Strict inequality guarantees unambiguous ordering --
      // workers always pick the blocker before the thing it unblocks.
      const edges = [
        [idA, idB], [idA, idC], [idB, idD], [idC, idE],
      ];
      for (const [parentId, childId] of edges) {
        const parent = byId.get(parentId)!;
        const child = byId.get(childId)!;
        assert.ok(
          parent.priority > child.priority,
          `Dependency ${parent.title} (p=${parent.priority}) must have priority strictly > dependent ${child.title} (p=${child.priority})`
        );
      }

      // Root A should have the highest priority of all
      const maxPriority = Math.max(...tasks.map((t: { priority: number }) => t.priority));
      assert.equal(byId.get(idA)!.priority, maxPriority, 'Root blocker A should have highest priority');
    });

    it('reset accepts cycle status', async () => {
      const idA = await createTask('A', 1);
      const idB = await createTask('B', 1);

      // Create mutual cycle
      addDep(idA, idB);
      addDep(idB, idA);

      await ctx.app.inject({ method: 'POST', url: '/tasks/replan' });

      // Verify cycle status
      const tA = (await ctx.app.inject({ method: 'GET', url: `/tasks/${idA}` })).json();
      assert.equal(tA.status, 'cycle');

      // Reset one of the cycle tasks
      const resetRes = await ctx.app.inject({ method: 'POST', url: `/tasks/${idA}/reset` });
      assert.equal(resetRes.statusCode, 200);
      assert.equal(resetRes.json().ok, true);

      const tAReset = (await ctx.app.inject({ method: 'GET', url: `/tasks/${idA}` })).json();
      assert.equal(tAReset.status, 'pending');
    });

    it('task downstream of a cycle is not marked cycle', async () => {
      const idA = await createTask('A', 1);
      const idB = await createTask('B', 1, [idA]);
      const idC = await createTask('C', 1, [idA]); // C depends on A (downstream of cycle)

      // Create mutual cycle: A depends on B, B already depends on A
      addDep(idA, idB);

      const res = await ctx.app.inject({ method: 'POST', url: '/tasks/replan' });
      assert.equal(res.statusCode, 200);

      const tA = (await ctx.app.inject({ method: 'GET', url: `/tasks/${idA}` })).json();
      const tB = (await ctx.app.inject({ method: 'GET', url: `/tasks/${idB}` })).json();
      const tC = (await ctx.app.inject({ method: 'GET', url: `/tasks/${idC}` })).json();

      assert.equal(tA.status, 'cycle', 'A should be in cycle');
      assert.equal(tB.status, 'cycle', 'B should be in cycle');
      assert.equal(tC.status, 'pending', 'C depends on a cycle member but is not itself cyclic');
    });

    it('claim-next skips cycle-status tasks', async () => {
      // Create a cycle pair
      const idA = await createTask('CycleA', 1);
      const idB = await createTask('CycleB', 1);
      addDep(idA, idB);
      addDep(idB, idA);

      // Create a clean pending task
      const idC = await createTask('CleanTask', 5);

      // Replan to mark A and B as cycle
      await ctx.app.inject({ method: 'POST', url: '/tasks/replan' });

      // claim-next should return the clean task, not the cycle ones
      const claimRes = await ctx.app.inject({
        method: 'POST',
        url: '/tasks/claim-next',
        headers: { 'x-agent-name': 'agent-1' },
      });
      assert.equal(claimRes.statusCode, 200);
      const body = claimRes.json();
      assert.ok(body.task, 'expected a task to be claimed');
      assert.equal(body.task.id, idC);
      assert.equal(body.task.title, 'CleanTask');
    });
  });
});
