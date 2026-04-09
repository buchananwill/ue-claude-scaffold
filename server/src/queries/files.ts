import { eq, and, asc, isNull, isNotNull } from 'drizzle-orm';
import { files } from '../schema/tables.js';
import type { DrizzleDb } from '../drizzle-instance.js';

export interface ListOpts {
  claimantAgentId?: string;
  unclaimed?: boolean;
}

export async function list(db: DrizzleDb, projectId: string, opts?: ListOpts): Promise<(typeof files.$inferSelect)[]> {
  const conditions = [eq(files.projectId, projectId)];

  if (opts?.claimantAgentId) {
    conditions.push(eq(files.claimantAgentId, opts.claimantAgentId));
  } else if (opts?.unclaimed) {
    conditions.push(isNull(files.claimantAgentId));
  }

  return db
    .select()
    .from(files)
    .where(and(...conditions))
    .orderBy(asc(files.path));
}

export async function releaseByClaimantAgentId(db: DrizzleDb, projectId: string, agentId: string): Promise<void> {
  await db
    .update(files)
    .set({ claimantAgentId: null, claimedAt: null })
    .where(and(eq(files.projectId, projectId), eq(files.claimantAgentId, agentId)));
}

export async function releaseAll(db: DrizzleDb, projectId: string): Promise<void> {
  await db
    .update(files)
    .set({ claimantAgentId: null, claimedAt: null })
    .where(and(eq(files.projectId, projectId), isNotNull(files.claimantAgentId)));
}
