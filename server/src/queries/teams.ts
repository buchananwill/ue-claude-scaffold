import { eq, and, desc, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { teams, teamMembers, rooms, roomMembers, agents } from '../schema/tables.js';
import type { DbOrTx } from '../drizzle-instance.js';

export interface CreateOpts {
  id: string;
  name: string;
  briefPath?: string | null;
  projectId?: string;
}

export async function create(db: DbOrTx, opts: CreateOpts) {
  const rows = await db
    .insert(teams)
    .values({
      id: opts.id,
      name: opts.name,
      briefPath: opts.briefPath ?? null,
      projectId: opts.projectId ?? 'default',
    })
    .returning();
  return rows[0];
}

export interface CreateWithRoomOpts extends CreateOpts {
  createdBy: string;
  members: Array<{ agentId: string; role: string; isLeader?: boolean }>;
}

/**
 * Creates a team, its associated room, and adds members to both.
 * Mirrors the transaction logic in the teams route.
 */
export async function createWithRoom(db: DbOrTx, opts: CreateWithRoomOpts) {
  const team = await create(db, opts);

  // Add team members
  for (const m of opts.members) {
    await addMember(db, opts.id, m.agentId, m.role, m.isLeader);
  }

  // Create associated room
  await db.insert(rooms).values({
    id: opts.id,
    name: opts.name,
    type: 'group',
    createdBy: opts.createdBy,
    projectId: opts.projectId ?? 'default',
  });

  // Add members to room
  for (const m of opts.members) {
    await db
      .insert(roomMembers)
      .values({ id: uuidv7(), roomId: opts.id, agentId: m.agentId })
      .onConflictDoNothing();
  }
  return team;
}

export async function getById(db: DbOrTx, id: string, projectId?: string) {
  const conditions = [eq(teams.id, id)];
  if (projectId) {
    conditions.push(eq(teams.projectId, projectId));
  }
  const rows = await db.select().from(teams).where(and(...conditions));
  return rows[0] ?? null;
}

export interface ListOpts {
  status?: string;
  projectId?: string;
}

export async function list(db: DbOrTx, opts: ListOpts = {}) {
  const conditions = [];

  if (opts.status) {
    conditions.push(eq(teams.status, opts.status));
  }
  if (opts.projectId) {
    conditions.push(eq(teams.projectId, opts.projectId));
  }

  return db
    .select()
    .from(teams)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(teams.createdAt));
}

export async function dissolve(db: DbOrTx, id: string, projectId: string) {
  await db
    .update(teams)
    .set({ status: 'dissolved', dissolvedAt: sql`now()` })
    .where(and(eq(teams.id, id), eq(teams.projectId, projectId)));
}

export async function updateStatus(db: DbOrTx, id: string, projectId: string, status: string) {
  await db.update(teams).set({ status }).where(and(eq(teams.id, id), eq(teams.projectId, projectId)));
}

export async function updateDeliverable(db: DbOrTx, id: string, projectId: string, deliverable: string) {
  await db.update(teams).set({ deliverable }).where(and(eq(teams.id, id), eq(teams.projectId, projectId)));
}

export async function deleteTeam(db: DbOrTx, id: string, projectId: string): Promise<boolean> {
  const rows = await db.delete(teams).where(and(eq(teams.id, id), eq(teams.projectId, projectId))).returning();
  return rows.length > 0;
}

export async function getMembers(db: DbOrTx, teamId: string) {
  return db
    .select({
      agentId: teamMembers.agentId,
      agentName: agents.name,
      role: teamMembers.role,
      isLeader: teamMembers.isLeader,
    })
    .from(teamMembers)
    .innerJoin(agents, eq(agents.id, teamMembers.agentId))
    .where(eq(teamMembers.teamId, teamId));
}

export async function addMember(
  db: DbOrTx,
  teamId: string,
  agentId: string,
  role: string,
  isLeader?: boolean,
) {
  await db
    .insert(teamMembers)
    .values({
      teamId,
      agentId,
      role,
      isLeader: isLeader ?? false,
    })
    .onConflictDoUpdate({
      target: [teamMembers.teamId, teamMembers.agentId],
      set: { role, isLeader: isLeader ?? false },
    });
}

export async function removeMember(db: DbOrTx, teamId: string, agentId: string) {
  await db
    .delete(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.agentId, agentId)));
}
