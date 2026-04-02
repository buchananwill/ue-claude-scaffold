import { eq, and, asc, isNull, sql } from 'drizzle-orm';
import { files } from '../schema/tables.js';
import type { DrizzleDb } from '../drizzle-instance.js';

export interface ListOpts {
  claimant?: string;
  unclaimed?: boolean;
}

export async function list(db: DrizzleDb, projectId: string, opts?: ListOpts) {
  const conditions = [eq(files.projectId, projectId)];

  if (opts?.claimant) {
    conditions.push(eq(files.claimant, opts.claimant));
  } else if (opts?.unclaimed) {
    conditions.push(isNull(files.claimant));
  }

  return db
    .select()
    .from(files)
    .where(and(...conditions))
    .orderBy(asc(files.path));
}

export async function releaseByClaimant(db: DrizzleDb, claimant: string) {
  await db
    .update(files)
    .set({ claimant: null, claimedAt: null })
    .where(eq(files.claimant, claimant));
}

export async function releaseAll(db: DrizzleDb) {
  await db
    .update(files)
    .set({ claimant: null, claimedAt: null });
}
