import { eq, ne, and, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { agents } from '../schema/tables.js';
import type { DrizzleDb } from '../drizzle-instance.js';

type AgentRow = typeof agents.$inferSelect;

const VALID_STATUSES = new Set(['idle', 'working', 'done', 'error', 'paused', 'stopping', 'deleted']);
const VALID_MODES = new Set(['single', 'pump']);

function byProjectAndName(projectId: string, name: string) {
  return and(eq(agents.projectId, projectId), eq(agents.name, name));
}

export interface RegisterOpts {
  name: string;
  projectId: string;
  worktree: string;
  planDoc?: string | null;
  mode?: string;
  containerHost?: string | null;
  sessionToken?: string | null;
}

export async function register(db: DrizzleDb, opts: RegisterOpts): Promise<void> {
  const {
    name,
    projectId,
    worktree,
    planDoc = null,
    mode = 'single',
    containerHost = null,
    sessionToken = null,
  } = opts;

  if (!VALID_MODES.has(mode)) {
    throw new Error(`Invalid agent mode: ${mode}`);
  }

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

export async function getAll(db: DrizzleDb, projectId?: string): Promise<AgentRow[]> {
  if (projectId) {
    return db.select().from(agents).where(eq(agents.projectId, projectId));
  }
  return db.select().from(agents);
}

export async function getByName(db: DrizzleDb, projectId: string, name: string): Promise<AgentRow | null> {
  const rows = await db
    .select()
    .from(agents)
    .where(byProjectAndName(projectId, name));
  return rows[0] ?? null;
}

export async function getByIdInProject(db: DrizzleDb, projectId: string, id: string): Promise<AgentRow | null> {
  const rows = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, id), eq(agents.projectId, projectId)));
  return rows[0] ?? null;
}

export async function updateStatus(db: DrizzleDb, projectId: string, name: string, status: string): Promise<void> {
  if (!VALID_STATUSES.has(status)) {
    throw new Error(`Invalid agent status: ${status}`);
  }

  await db
    .update(agents)
    .set({ status })
    .where(byProjectAndName(projectId, name));
}

export async function softDelete(db: DrizzleDb, projectId: string, name: string): Promise<void> {
  await updateStatus(db, projectId, name, 'deleted');
}

export async function stopAgent(db: DrizzleDb, projectId: string, name: string): Promise<void> {
  await updateStatus(db, projectId, name, 'stopping');
}

export async function deleteAllForProject(db: DrizzleDb, projectId: string): Promise<number> {
  const rows = await db
    .update(agents)
    .set({ status: 'deleted' })
    .where(and(eq(agents.projectId, projectId), ne(agents.status, 'deleted')))
    .returning();
  return rows.length;
}

export async function getByToken(db: DrizzleDb, sessionToken: string): Promise<AgentRow | null> {
  const rows = await db
    .select()
    .from(agents)
    .where(eq(agents.sessionToken, sessionToken));
  return rows[0] ?? null;
}

export async function getActiveNames(db: DrizzleDb, projectId: string): Promise<string[]> {
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

export async function getWorktreeInfo(db: DrizzleDb, projectId: string, name: string): Promise<{ name: string; worktree: string; projectId: string } | null> {
  const rows = await db
    .select({
      name: agents.name,
      worktree: agents.worktree,
      projectId: agents.projectId,
    })
    .from(agents)
    .where(byProjectAndName(projectId, name));
  return rows[0] ?? null;
}
