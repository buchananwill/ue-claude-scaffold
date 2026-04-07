import { eq, and, desc, sql } from 'drizzle-orm';
import { teams, teamMembers, rooms, roomMembers } from '../schema/tables.js';
import type { DrizzleDb, DrizzleTx } from '../drizzle-instance.js';

/** Accept either a full DB instance or a transaction client. */
type DbOrTx = DrizzleDb | DrizzleTx;

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
  members: Array<{ agentName: string; role: string; isLeader?: boolean }>;
}

/**
 * Creates a team, its associated room, and adds members to both.
 * Mirrors the transaction logic in the teams route.
 */
export async function createWithRoom(db: DbOrTx, opts: CreateWithRoomOpts) {
  const team = await create(db, opts);

  // Add team members
  for (const m of opts.members) {
    await addMember(db, opts.id, m.agentName, m.role, m.isLeader);
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
      .values({ roomId: opts.id, member: m.agentName })
      .onConflictDoNothing();
  }
  // Always add 'user' to the room
  await db
    .insert(roomMembers)
    .values({ roomId: opts.id, member: 'user' })
    .onConflictDoNothing();

  return team;
}

export async function getById(db: DbOrTx, id: string) {
  const rows = await db.select().from(teams).where(eq(teams.id, id));
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

export async function dissolve(db: DbOrTx, id: string) {
  await db
    .update(teams)
    .set({ status: 'dissolved', dissolvedAt: sql`now()` })
    .where(eq(teams.id, id));
}

export async function updateStatus(db: DbOrTx, id: string, status: string) {
  await db.update(teams).set({ status }).where(eq(teams.id, id));
}

export async function updateDeliverable(db: DbOrTx, id: string, deliverable: string) {
  await db.update(teams).set({ deliverable }).where(eq(teams.id, id));
}

export async function deleteTeam(db: DbOrTx, id: string): Promise<boolean> {
  const rows = await db.delete(teams).where(eq(teams.id, id)).returning();
  return rows.length > 0;
}

export async function getMembers(db: DbOrTx, teamId: string) {
  return db
    .select({
      agentName: teamMembers.agentName,
      role: teamMembers.role,
      isLeader: teamMembers.isLeader,
    })
    .from(teamMembers)
    .where(eq(teamMembers.teamId, teamId));
}

export async function addMember(
  db: DbOrTx,
  teamId: string,
  agentName: string,
  role: string,
  isLeader?: boolean,
) {
  await db
    .insert(teamMembers)
    .values({
      teamId,
      agentName,
      role,
      isLeader: isLeader ?? false,
    })
    .onConflictDoUpdate({
      target: [teamMembers.teamId, teamMembers.agentName],
      set: { role, isLeader: isLeader ?? false },
    });
}

export async function removeMember(db: DbOrTx, teamId: string, agentName: string) {
  await db
    .delete(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.agentName, agentName)));
}
