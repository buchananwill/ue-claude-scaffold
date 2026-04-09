import { eq, ne, and, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { agents } from '../schema/tables.js';
import type { DrizzleDb } from '../drizzle-instance.js';

export interface RegisterOpts {
  name: string;
  projectId: string;
  worktree: string;
  planDoc?: string | null;
  mode?: string;
  containerHost?: string | null;
  sessionToken?: string | null;
}

export async function register(db: DrizzleDb, opts: RegisterOpts) {
  const {
    name,
    projectId,
    worktree,
    planDoc = null,
    mode = 'single',
    containerHost = null,
    sessionToken = null,
  } = opts;

  await db
    .insert(agents)
    .values({
      id: uuidv7(),
      name,
      projectId,
      worktree,
      planDoc,
      status: 'idle',
      mode,
      registeredAt: sql`now()`,
      containerHost,
      sessionToken,
    })
    .onConflictDoUpdate({
      target: [agents.projectId, agents.name],
      set: {
        worktree,
        planDoc,
        status: 'idle',
        mode,
        registeredAt: sql`now()`,
        containerHost: sql`COALESCE(excluded.container_host, ${agents.containerHost})`,
        sessionToken,
      },
    });
}

export async function getAll(db: DrizzleDb, projectId?: string) {
  if (projectId) {
    return db.select().from(agents).where(eq(agents.projectId, projectId));
  }
  return db.select().from(agents);
}

export async function getByName(db: DrizzleDb, projectId: string, name: string) {
  const rows = await db
    .select()
    .from(agents)
    .where(and(eq(agents.projectId, projectId), eq(agents.name, name)));
  return rows[0] ?? null;
}

export async function getByIdInProject(db: DrizzleDb, projectId: string, id: string) {
  const rows = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, id), eq(agents.projectId, projectId)));
  return rows[0] ?? null;
}

export async function updateStatus(db: DrizzleDb, projectId: string, name: string, status: string) {
  await db
    .update(agents)
    .set({ status })
    .where(and(eq(agents.projectId, projectId), eq(agents.name, name)));
}

export async function softDelete(db: DrizzleDb, projectId: string, name: string) {
  await db
    .update(agents)
    .set({ status: 'deleted' })
    .where(and(eq(agents.projectId, projectId), eq(agents.name, name)));
}

export async function stopAgent(db: DrizzleDb, projectId: string, name: string) {
  await db
    .update(agents)
    .set({ status: 'stopping' })
    .where(and(eq(agents.projectId, projectId), eq(agents.name, name)));
}

export async function deleteAllForProject(db: DrizzleDb, projectId: string) {
  const rows = await db
    .update(agents)
    .set({ status: 'deleted' })
    .where(and(eq(agents.projectId, projectId), ne(agents.status, 'deleted')))
    .returning();
  return rows.length;
}

export async function getByToken(db: DrizzleDb, sessionToken: string) {
  const rows = await db
    .select()
    .from(agents)
    .where(eq(agents.sessionToken, sessionToken));
  return rows[0] ?? null;
}

export async function getActiveNames(db: DrizzleDb, projectId: string) {
  const rows = await db
    .select({ name: agents.name })
    .from(agents)
    .where(
      and(
        ne(agents.status, 'stopping'),
        ne(agents.status, 'deleted'),
        eq(agents.projectId, projectId),
      ),
    );
  return rows.map((r) => r.name);
}

export async function getWorktreeInfo(db: DrizzleDb, projectId: string, name: string) {
  const rows = await db
    .select({
      name: agents.name,
      worktree: agents.worktree,
      projectId: agents.projectId,
    })
    .from(agents)
    .where(and(eq(agents.projectId, projectId), eq(agents.name, name)));
  return rows[0] ?? null;
}
