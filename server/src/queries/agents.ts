import { eq, ne, and, sql } from 'drizzle-orm';
import { agents } from '../schema/tables.js';
import type { DrizzleDb } from '../drizzle-instance.js';

export interface RegisterOpts {
  name: string;
  worktree: string;
  planDoc?: string | null;
  mode?: string;
  containerHost?: string | null;
  sessionToken?: string | null;
  projectId?: string;
}

export async function register(db: DrizzleDb, opts: RegisterOpts) {
  const {
    name,
    worktree,
    planDoc = null,
    mode = 'single',
    containerHost = null,
    sessionToken = null,
    projectId = 'default',
  } = opts;

  await db
    .insert(agents)
    .values({
      name,
      worktree,
      planDoc,
      status: 'idle',
      mode,
      registeredAt: sql`now()`,
      containerHost,
      sessionToken,
      projectId,
    })
    .onConflictDoUpdate({
      target: agents.name,
      set: {
        worktree,
        planDoc,
        status: 'idle',
        mode,
        registeredAt: sql`now()`,
        containerHost: sql`COALESCE(excluded.container_host, ${agents.containerHost})`,
        sessionToken,
        projectId,
      },
    });
}

export async function getAll(db: DrizzleDb, projectId?: string) {
  if (projectId) {
    return db.select().from(agents).where(eq(agents.projectId, projectId));
  }
  return db.select().from(agents);
}

export async function getByName(db: DrizzleDb, name: string) {
  const rows = await db.select().from(agents).where(eq(agents.name, name));
  return rows[0] ?? null;
}

export async function updateStatus(db: DrizzleDb, name: string, status: string) {
  await db.update(agents).set({ status }).where(eq(agents.name, name));
}

export async function softDelete(db: DrizzleDb, name: string) {
  await db.update(agents).set({ status: 'stopping' }).where(eq(agents.name, name));
}

export async function hardDelete(db: DrizzleDb, name: string) {
  await db.delete(agents).where(eq(agents.name, name));
}

export async function deleteAll(db: DrizzleDb) {
  const rows = await db.delete(agents).returning();
  return rows.length;
}

export async function getByToken(db: DrizzleDb, sessionToken: string) {
  const rows = await db
    .select()
    .from(agents)
    .where(eq(agents.sessionToken, sessionToken));
  return rows[0] ?? null;
}

export async function getActiveNames(db: DrizzleDb) {
  const rows = await db
    .select({ name: agents.name })
    .from(agents)
    .where(ne(agents.status, 'stopping'));
  return rows.map((r) => r.name);
}

export async function getWorktreeInfo(db: DrizzleDb, name: string) {
  const rows = await db
    .select({
      name: agents.name,
      worktree: agents.worktree,
      projectId: agents.projectId,
    })
    .from(agents)
    .where(eq(agents.name, name));
  return rows[0] ?? null;
}

export async function getProjectId(db: DrizzleDb, name: string) {
  const rows = await db
    .select({ projectId: agents.projectId })
    .from(agents)
    .where(eq(agents.name, name));
  return rows[0]?.projectId ?? 'default';
}
