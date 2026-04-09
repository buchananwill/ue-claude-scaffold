import { eq, ne, and, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { agents } from '../schema/tables.js';
import type { DrizzleDb, DbOrTx } from '../drizzle-instance.js';

export type AgentRow = typeof agents.$inferSelect;

/** Agent row with sessionToken omitted — safe for external consumption. */
export type AgentPublicRow = Omit<AgentRow, 'sessionToken'>;

export type AgentStatus = 'idle' | 'working' | 'done' | 'error' | 'paused' | 'stopping' | 'deleted';
export type AgentMode = 'single' | 'pump';

/** All valid statuses including 'deleted' — used for DB-level validation. */
const VALID_STATUSES: Set<string> = new Set<AgentStatus>(['idle', 'working', 'done', 'error', 'paused', 'stopping', 'deleted']);
const VALID_MODES: Set<string> = new Set<AgentMode>(['single', 'pump']);

function byProjectAndName(projectId: string, name: string) {
  return and(eq(agents.projectId, projectId), eq(agents.name, name));
}

export interface RegisterOpts {
  name: string;
  projectId: string;
  worktree: string;
  planDoc?: string | null;
  mode?: AgentMode;
  containerHost?: string | null;
  sessionToken?: string | null;
}

export interface RegisterResult {
  id: string;
  sessionToken: string;
}

export async function register(db: DrizzleDb, opts: RegisterOpts): Promise<RegisterResult> {
  const {
    name,
    projectId,
    worktree,
    planDoc = null,
    mode = 'single',
    containerHost = null,
    sessionToken = null,
  } = opts;

  if (!name || name.length > 128) {
    throw new Error('Invalid agent name');
  }
  if (!projectId || projectId.length > 128) {
    throw new Error('Invalid projectId');
  }

  if (!VALID_MODES.has(mode)) {
    throw new Error(`Invalid agent mode: ${mode}`);
  }

  const id = uuidv7();

  const rows = await db
    .insert(agents)
    .values({
      id,
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
    })
    .returning();

  const row = rows[0];
  const resolvedToken = row.sessionToken ?? sessionToken;
  if (!resolvedToken) {
    throw new Error('register: sessionToken is unexpectedly null after upsert');
  }
  return { id: row.id, sessionToken: resolvedToken };
}

/** Columns to select for public agent rows (excludes sessionToken). */
const publicColumns = {
  id: agents.id,
  name: agents.name,
  projectId: agents.projectId,
  worktree: agents.worktree,
  planDoc: agents.planDoc,
  status: agents.status,
  mode: agents.mode,
  registeredAt: agents.registeredAt,
  containerHost: agents.containerHost,
} as const;

/**
 * Returns agents, optionally filtered by project.
 * When called without projectId, returns all agents across all projects.
 * @internal The unscoped path is intended for administrative use only.
 */
export async function getAll(db: DrizzleDb, projectId?: string): Promise<AgentPublicRow[]> {
  if (projectId) {
    return db.select(publicColumns).from(agents).where(eq(agents.projectId, projectId));
  }
  return db.select(publicColumns).from(agents);
}

export async function getByName(db: DrizzleDb, projectId: string, name: string): Promise<AgentPublicRow | null> {
  const rows = await db
    .select(publicColumns)
    .from(agents)
    .where(byProjectAndName(projectId, name));
  return rows[0] ?? null;
}

/**
 * Like getByName but returns the full AgentRow including sessionToken.
 * Use only when token verification is needed (e.g. DELETE with sessionToken check).
 */
export async function getByNameFull(db: DrizzleDb, projectId: string, name: string): Promise<AgentRow | null> {
  const rows = await db
    .select()
    .from(agents)
    .where(byProjectAndName(projectId, name));
  return rows[0] ?? null;
}

export async function getByIdInProject(db: DrizzleDb, projectId: string, id: string): Promise<AgentPublicRow | null> {
  const rows = await db
    .select(publicColumns)
    .from(agents)
    .where(and(eq(agents.id, id), eq(agents.projectId, projectId)));
  return rows[0] ?? null;
}

export async function updateStatus(db: DbOrTx, projectId: string, name: string, status: AgentStatus): Promise<void> {
  if (!VALID_STATUSES.has(status)) {
    throw new Error(`Invalid agent status: ${status}`);
  }

  await db
    .update(agents)
    .set({ status })
    .where(byProjectAndName(projectId, name));
}

export async function softDelete(db: DbOrTx, projectId: string, name: string): Promise<void> {
  await updateStatus(db, projectId, name, 'deleted');
}

export async function stopAgent(db: DbOrTx, projectId: string, name: string): Promise<void> {
  await updateStatus(db, projectId, name, 'stopping');
}

export async function deleteAllForProject(db: DbOrTx, projectId: string): Promise<number> {
  const rows = await db
    .update(agents)
    .set({ status: 'deleted' })
    .where(and(eq(agents.projectId, projectId), ne(agents.status, 'deleted')))
    .returning();
  return rows.length;
}

/**
 * Looks up an agent by session token. Tokens are globally unique by construction.
 * Note: Returns the full agent row including sessionToken. Callers that forward
 * the result to HTTP responses must strip sensitive fields.
 */
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
