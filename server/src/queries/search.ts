import { sql, and, eq } from 'drizzle-orm';
import { tasks, messages, agents } from '../schema/tables.js';
import type { DrizzleDb } from '../drizzle-instance.js';

export interface SearchTasksOpts {
  projectId?: string;
  limit?: number;
}

export async function searchTasks(db: DrizzleDb, query: string, opts: SearchTasksOpts = {}) {
  const limitVal = opts.limit ?? 20;
  const pattern = `%${query}%`;

  const conditions = [
    sql`(${tasks.title} ILIKE ${pattern} OR ${tasks.description} ILIKE ${pattern} OR ${tasks.progressLog} ILIKE ${pattern} OR ${tasks.acceptanceCriteria} ILIKE ${pattern})`,
  ];

  if (opts.projectId) {
    conditions.push(eq(tasks.projectId, opts.projectId));
  }

  return db
    .select()
    .from(tasks)
    .where(and(...conditions))
    .limit(limitVal);
}

export interface SearchMessagesOpts {
  limit?: number;
}

export async function searchMessages(db: DrizzleDb, query: string, opts: SearchMessagesOpts = {}) {
  const limitVal = opts.limit ?? 20;
  const pattern = `%${query}%`;

  return db
    .select()
    .from(messages)
    .where(
      sql`(${messages.payload}::text ILIKE ${pattern} OR ${messages.fromAgent} ILIKE ${pattern})`,
    )
    .limit(limitVal);
}

export interface SearchAgentsOpts {
  limit?: number;
}

export async function searchAgents(db: DrizzleDb, query: string, opts: SearchAgentsOpts = {}) {
  const limitVal = opts.limit ?? 20;
  const pattern = `%${query}%`;

  return db
    .select()
    .from(agents)
    .where(
      sql`(${agents.name} ILIKE ${pattern} OR ${agents.worktree} ILIKE ${pattern})`,
    )
    .limit(limitVal);
}
