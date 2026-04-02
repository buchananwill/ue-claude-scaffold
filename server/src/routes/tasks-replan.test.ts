import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDrizzleTestApp, type DrizzleTestContext } from '../drizzle-test-helper.js';
import { createTestConfig } from '../test-helper.js';
import { tasks, taskDependencies } from '../schema/tables.js';
import { eq } from 'drizzle-orm';
import tasksReplanPlugin from './tasks-replan.js';

describe('tasks-replan routes (drizzle)', () => {
  let ctx: DrizzleTestContext;

  beforeEach(async () => {
    ctx = await createDrizzleTestApp();
    const config = createTestConfig();
    await ctx.app.register(tasksReplanPlugin, { config });
  });

  afterEach(async () => {
    await ctx.app.close();
    await ctx.cleanup();
  });

  describe('POST /tasks/replan', () => {
    /** Helper: create a task and return its id */
    async function createTask(title: string, priority?: number, dependsOn?: number[]): Promise<number> {
      const rows = await ctx.db.insert(tasks).values({
        title,
        priority: priority ?? 0,
        basePriority: priority ?? 0,
        projectId: 'default',
      }).returning();
      const taskId = rows[0].id;

      if (dependsOn?.length) {
        for (const depId of dependsOn) {
          await ctx.db.insert(taskDependencies).values({ taskId, dependsOn: depId });
        }
      }

      return taskId;
    }

    /** Helper: add a dependency edge */
    async function addDep(taskId: number, dependsOnId: number): Promise<void> {
      await ctx.db.insert(taskDependencies).values({ taskId, dependsOn: dependsOnId }).onConflictDoNothing();
    }

    /** Helper: get a task by id */
    async function getTask(id: number) {
      const rows = await ctx.db.select().from(tasks).where(eq(tasks.id, id));
      return rows[0];
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

      // Verify priorities unchanged
      const tA = await getTask(idA);
      const tB = await getTask(idB);
      const tC = await getTask(idC);
      assert.equal(tA.priority, 1);
      assert.equal(tB.priority, 2);
      assert.equal(tC.priority, 3);
    });

    it('detects three-node cycle A->B->C->A', async () => {
      const idA = await createTask('A', 1);
      const idB = await createTask('B', 1);
      const idC = await createTask('C', 1);

      // A depends on B, B depends on C, C depends on A
      await addDep(idA, idB);
      await addDep(idB, idC);
      await addDep(idC, idA);

      const res = await ctx.app.inject({ method: 'POST', url: '/tasks/replan' });
      assert.equal(res.statusCode, 200);
      const body = res.json();

      // All three should be in a cycle
      const tA = await getTask(idA);
      const tB = await getTask(idB);
      const tC = await getTask(idC);
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
      await addDep(idA, idB);
      await addDep(idB, idA);

      const res = await ctx.app.inject({ method: 'POST', url: '/tasks/replan' });
      assert.equal(res.statusCode, 200);
      const body = res.json();

      const tA = await getTask(idA);
      const tB = await getTask(idB);
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
      await addDep(idA, idB);
      await addDep(idB, idA);

      const res = await ctx.app.inject({ method: 'POST', url: '/tasks/replan' });
      assert.equal(res.statusCode, 200);

      const tA = await getTask(idA);
      const tB = await getTask(idB);
      const tC = await getTask(idC);
      assert.equal(tA.status, 'cycle');
      assert.equal(tB.status, 'cycle');
      assert.equal(tC.status, 'pending');
    });

    it('priority accumulation through chain', async () => {
      // Root (p=0, no deps) <- Middle (p=0, depends on Root) <- Leaf (p=10, depends on Middle)
      const idRoot = await createTask('Root', 0);
      const idMiddle = await createTask('Middle', 0, [idRoot]);
      const idLeaf = await createTask('Leaf', 10, [idMiddle]);

      const res = await ctx.app.inject({ method: 'POST', url: '/tasks/replan' });
      assert.equal(res.statusCode, 200);

      const tRoot = await getTask(idRoot);
      const tMiddle = await getTask(idMiddle);
      const tLeaf = await getTask(idLeaf);

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
      const tRoot1 = await getTask(idRoot);
      const tMiddle1 = await getTask(idMiddle);
      const tLeaf1 = await getTask(idLeaf);

      // Second replan
      await ctx.app.inject({ method: 'POST', url: '/tasks/replan' });
      const tRoot2 = await getTask(idRoot);
      const tMiddle2 = await getTask(idMiddle);
      const tLeaf2 = await getTask(idLeaf);

      assert.equal(tRoot1.priority, tRoot2.priority);
      assert.equal(tMiddle1.priority, tMiddle2.priority);
      assert.equal(tLeaf1.priority, tLeaf2.priority);
    });

    it('invariant: every dependency has priority >= its dependents', async () => {
      const idA = await createTask('A', 0);
      const idB = await createTask('B', 0, [idA]);
      const idC = await createTask('C', 5, [idA]);
      const idD = await createTask('D', 10, [idB]);
      const idE = await createTask('E', 3, [idC]);

      await ctx.app.inject({ method: 'POST', url: '/tasks/replan' });

      const allTasks = await Promise.all(
        [idA, idB, idC, idD, idE].map(async (id) => getTask(id))
      );
      const byId = new Map(allTasks.map((t) => [t.id, t]));

      const edges = [
        [idA, idB], [idA, idC], [idB, idD], [idC, idE],
      ];
      for (const [parentId, childId] of edges) {
        const parent = byId.get(parentId)!;
        const child = byId.get(childId)!;
        assert.ok(
          parent.priority! > child.priority!,
          `Dependency ${parent.title} (p=${parent.priority}) must have priority strictly > dependent ${child.title} (p=${child.priority})`
        );
      }

      // Root A should have the highest priority of all
      const maxPriority = Math.max(...allTasks.map((t) => t.priority!));
      assert.equal(byId.get(idA)!.priority, maxPriority, 'Root blocker A should have highest priority');
    });

    it('task downstream of a cycle is not marked cycle', async () => {
      const idA = await createTask('A', 1);
      const idB = await createTask('B', 1, [idA]);
      const idC = await createTask('C', 1, [idA]); // C depends on A (downstream of cycle)

      // Create mutual cycle: A depends on B, B already depends on A
      await addDep(idA, idB);

      const res = await ctx.app.inject({ method: 'POST', url: '/tasks/replan' });
      assert.equal(res.statusCode, 200);

      const tA = await getTask(idA);
      const tB = await getTask(idB);
      const tC = await getTask(idC);

      assert.equal(tA.status, 'cycle', 'A should be in cycle');
      assert.equal(tB.status, 'cycle', 'B should be in cycle');
      assert.equal(tC.status, 'pending', 'C depends on a cycle member but is not itself cyclic');
    });
  });
});
