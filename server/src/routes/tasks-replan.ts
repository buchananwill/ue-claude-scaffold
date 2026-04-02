import type { FastifyPluginAsync } from 'fastify';
import { getDb, tryGetDb } from '../drizzle-instance.js';
import * as replanQ from '../queries/tasks-replan.js';
import type { TasksOpts } from './tasks-files.js';

export async function runReplan() {
  const db = tryGetDb();
  if (!db) {
    // Drizzle not initialized — return empty result (migration transition)
    return { ok: true as const, replanned: 0, cycles: [] as { taskIds: number[]; titles: string[] }[], maxPriority: 0, roots: [] as number[] };
  }
  const rows = await replanQ.getNonTerminalTasks(db);
  if (rows.length === 0) {
    return { ok: true as const, replanned: 0, cycles: [] as { taskIds: number[]; titles: string[] }[], maxPriority: 0, roots: [] as number[] };
  }

  const edges = await replanQ.getNonTerminalDeps(db);

  const nodeMap = new Map<number, { title: string; basePriority: number }>();
  const inDegree = new Map<number, number>();
  const dependents = new Map<number, number[]>();
  const prerequisites = new Map<number, number[]>();

  for (const row of rows) {
    nodeMap.set(row.id, { title: row.title, basePriority: row.basePriority });
    inDegree.set(row.id, 0);
    dependents.set(row.id, []);
    prerequisites.set(row.id, []);
  }

  for (const edge of edges) {
    inDegree.set(edge.taskId, (inDegree.get(edge.taskId) || 0) + 1);
    dependents.get(edge.dependsOn)!.push(edge.taskId);
    prerequisites.get(edge.taskId)!.push(edge.dependsOn);
  }

  const queue: number[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }
  queue.sort((a, b) => a - b);

  const sorted: number[] = [];
  while (queue.length > 0) {
    const u = queue.shift()!;
    sorted.push(u);
    for (const v of dependents.get(u) || []) {
      const newDeg = (inDegree.get(v) || 1) - 1;
      inDegree.set(v, newDeg);
      if (newDeg === 0) queue.push(v);
    }
  }

  const sortedSet = new Set(sorted);
  const cycleIds = [...nodeMap.keys()].filter(id => !sortedSet.has(id));

  const cycleIdSet = new Set(cycleIds);

  // Tarjan's SCC on the unprocessed subgraph to distinguish actual cycle
  // members from nodes that are merely downstream of a cycle.
  const actualCycleIds: number[] = [];
  {
    let index = 0;
    const nodeIndex = new Map<number, number>();
    const nodeLowlink = new Map<number, number>();
    const onStack = new Set<number>();
    const stack: number[] = [];

    function strongconnect(v: number) {
      nodeIndex.set(v, index);
      nodeLowlink.set(v, index);
      index++;
      stack.push(v);
      onStack.add(v);

      for (const w of (dependents.get(v) || [])) {
        if (!cycleIdSet.has(w)) continue;
        if (!nodeIndex.has(w)) {
          strongconnect(w);
          nodeLowlink.set(v, Math.min(nodeLowlink.get(v)!, nodeLowlink.get(w)!));
        } else if (onStack.has(w)) {
          nodeLowlink.set(v, Math.min(nodeLowlink.get(v)!, nodeIndex.get(w)!));
        }
      }

      if (nodeLowlink.get(v) === nodeIndex.get(v)) {
        const scc: number[] = [];
        let w: number;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          scc.push(w);
        } while (w !== v);
        if (scc.length > 1) {
          actualCycleIds.push(...scc);
        }
      }
    }

    for (const id of cycleIds) {
      if (!nodeIndex.has(id)) {
        strongconnect(id);
      }
    }
  }

  const actualCycleIdSet = new Set(actualCycleIds);
  const visited = new Set<number>();
  const cycleGroups: { taskIds: number[]; titles: string[] }[] = [];

  for (const startId of actualCycleIds) {
    if (visited.has(startId)) continue;
    const group: number[] = [];
    const bfsQueue = [startId];
    visited.add(startId);
    while (bfsQueue.length > 0) {
      const node = bfsQueue.shift()!;
      group.push(node);
      for (const neighbor of [...(dependents.get(node) || []), ...(prerequisites.get(node) || [])]) {
        if (actualCycleIdSet.has(neighbor) && !visited.has(neighbor)) {
          visited.add(neighbor);
          bfsQueue.push(neighbor);
        }
      }
    }
    group.sort((a, b) => a - b);
    cycleGroups.push({
      taskIds: group,
      titles: group.map(id => nodeMap.get(id)!.title),
    });
  }

  const computedPriority = new Map<number, number>();
  for (const id of sorted) {
    computedPriority.set(id, nodeMap.get(id)!.basePriority);
  }
  // Walk in reverse topological order: leaves first, roots last.
  for (let i = sorted.length - 1; i >= 0; i--) {
    const id = sorted[i];
    const children = (dependents.get(id) || []).filter(c => sortedSet.has(c));
    if (children.length > 0) {
      let childSum = 0;
      for (const child of children) {
        childSum += computedPriority.get(child)!;
      }
      computedPriority.set(id, computedPriority.get(id)! + childSum + 1);
    }
  }

  const rootIds = sorted.filter(id => {
    const prereqs = prerequisites.get(id) || [];
    return prereqs.length === 0;
  });

  const maxPriority = sorted.length > 0 ? Math.max(...sorted.map(id => computedPriority.get(id)!)) : 0;

  await db.transaction(async (tx) => {
    for (const id of actualCycleIds) {
      await replanQ.markCycle(tx as any, id);
    }
    for (const id of sorted) {
      await replanQ.setPriority(tx as any, id, computedPriority.get(id)!);
    }
  });

  return {
    ok: true as const,
    replanned: sorted.length + actualCycleIds.length,
    cycles: cycleGroups,
    maxPriority,
    roots: rootIds,
  };
}

const tasksReplanPlugin: FastifyPluginAsync<TasksOpts> = async (fastify) => {
  // POST /tasks/replan — recompute priority via topological sort, detect cycles
  fastify.post('/tasks/replan', async () => {
    return runReplan();
  });
};

export default tasksReplanPlugin;
