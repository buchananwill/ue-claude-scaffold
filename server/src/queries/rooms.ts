import { eq, and, desc, sql } from 'drizzle-orm';
import { rooms, roomMembers, agents } from '../schema/tables.js';
import type { DrizzleDb } from '../drizzle-instance.js';

export interface CreateRoomOpts {
  id: string;
  name: string;
  type: string;
  createdBy: string;
  projectId?: string;
}

export async function createRoom(db: DrizzleDb, opts: CreateRoomOpts) {
  const rows = await db
    .insert(rooms)
    .values({
      id: opts.id,
      name: opts.name,
      type: opts.type,
      createdBy: opts.createdBy,
      projectId: opts.projectId ?? 'default',
    })
    .returning();
  return rows[0];
}

export async function getRoom(db: DrizzleDb, id: string) {
  const rows = await db.select().from(rooms).where(eq(rooms.id, id));
  return rows[0] ?? null;
}

export interface ListRoomsOpts {
  member?: string;
  projectId?: string;
}

export async function listRooms(db: DrizzleDb, opts: ListRoomsOpts = {}) {
  if (opts.member) {
    // JOIN room_members to filter by member
    const rows = await db
      .select({
        id: rooms.id,
        projectId: rooms.projectId,
        name: rooms.name,
        type: rooms.type,
        createdBy: rooms.createdBy,
        createdAt: rooms.createdAt,
      })
      .from(rooms)
      .innerJoin(roomMembers, eq(rooms.id, roomMembers.roomId))
      .where(
        opts.projectId
          ? and(eq(roomMembers.member, opts.member), eq(rooms.projectId, opts.projectId))
          : eq(roomMembers.member, opts.member),
      )
      .orderBy(desc(rooms.createdAt));
    return rows;
  }

  const conditions = [];
  if (opts.projectId) {
    conditions.push(eq(rooms.projectId, opts.projectId));
  }

  return db
    .select()
    .from(rooms)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(rooms.createdAt));
}

export async function deleteRoom(db: DrizzleDb, id: string): Promise<boolean> {
  const rows = await db.delete(rooms).where(eq(rooms.id, id)).returning();
  return rows.length > 0;
}

export async function addMember(db: DrizzleDb, roomId: string, member: string) {
  await db
    .insert(roomMembers)
    .values({ roomId, member })
    .onConflictDoNothing();
}

export async function removeMember(db: DrizzleDb, roomId: string, member: string) {
  await db
    .delete(roomMembers)
    .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.member, member)));
}

export async function getMembers(db: DrizzleDb, roomId: string) {
  const rows = await db
    .select({ member: roomMembers.member })
    .from(roomMembers)
    .where(eq(roomMembers.roomId, roomId));
  return rows.map((r) => r.member);
}

export async function getPresence(db: DrizzleDb, roomId: string) {
  const rows = await db
    .select({
      member: roomMembers.member,
      joinedAt: roomMembers.joinedAt,
      agentStatus: agents.status,
      agentRegisteredAt: agents.registeredAt,
    })
    .from(roomMembers)
    .leftJoin(agents, eq(agents.name, roomMembers.member))
    .where(eq(roomMembers.roomId, roomId))
    .orderBy(roomMembers.member);

  return rows.map((r) => ({
    name: r.member,
    joinedAt: r.joinedAt,
    online: r.agentStatus !== null,
    status: r.agentStatus ?? 'not-registered',
  }));
}
