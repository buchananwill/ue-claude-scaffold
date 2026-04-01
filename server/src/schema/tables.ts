import {
  pgTable,
  text,
  serial,
  integer,
  timestamp,
  jsonb,
  primaryKey,
  uniqueIndex,
  index,
  check,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// 1. agents
export const agents = pgTable('agents', {
  name: text('name').primaryKey(),
  projectId: text('project_id').notNull().default('default'),
  worktree: text('worktree').notNull(),
  planDoc: text('plan_doc'),
  status: text('status').notNull().default('idle'),
  mode: text('mode').notNull().default('single'),
  registeredAt: timestamp('registered_at').defaultNow(),
  containerHost: text('container_host'),
  sessionToken: text('session_token').unique(),
});

// 2. ubtLock — singleton mutex per project
export const ubtLock = pgTable('ubt_lock', {
  projectId: text('project_id').primaryKey().default('default'),
  holder: text('holder'),
  acquiredAt: timestamp('acquired_at'),
  priority: integer('priority').default(0),
});

// 3. ubtQueue — FIFO with priority
export const ubtQueue = pgTable('ubt_queue', {
  id: serial('id').primaryKey(),
  projectId: text('project_id').notNull().default('default'),
  agent: text('agent').notNull(),
  priority: integer('priority').default(0),
  requestedAt: timestamp('requested_at').defaultNow(),
});

// 4. buildHistory
export const buildHistory = pgTable('build_history', {
  id: serial('id').primaryKey(),
  projectId: text('project_id').notNull().default('default'),
  agent: text('agent').notNull(),
  type: text('type').notNull(),
  startedAt: timestamp('started_at').notNull().defaultNow(),
  durationMs: integer('duration_ms'),
  success: integer('success'),
  output: text('output'),
  stderr: text('stderr'),
}, (table) => [
  check('build_history_type_check', sql`${table.type} IN ('build', 'test')`),
]);

// 5. messages
export const messages = pgTable('messages', {
  id: serial('id').primaryKey(),
  projectId: text('project_id').notNull().default('default'),
  fromAgent: text('from_agent').notNull(),
  channel: text('channel').notNull(),
  type: text('type').notNull(),
  payload: jsonb('payload').notNull(),
  claimedBy: text('claimed_by'),
  claimedAt: timestamp('claimed_at'),
  resolvedAt: timestamp('resolved_at'),
  result: jsonb('result'),
  createdAt: timestamp('created_at').defaultNow(),
}, (table) => [
  index('idx_messages_channel').on(table.channel),
  index('idx_messages_channel_id').on(table.channel, table.id),
  index('idx_messages_claimed').on(table.claimedBy),
]);

// 6. tasks
export const tasks = pgTable('tasks', {
  id: serial('id').primaryKey(),
  projectId: text('project_id').notNull().default('default'),
  title: text('title').notNull(),
  description: text('description').default(''),
  sourcePath: text('source_path'),
  acceptanceCriteria: text('acceptance_criteria'),
  status: text('status').notNull().default('pending'),
  priority: integer('priority').notNull().default(0),
  basePriority: integer('base_priority').notNull().default(0),
  claimedBy: text('claimed_by'),
  claimedAt: timestamp('claimed_at'),
  completedAt: timestamp('completed_at'),
  result: jsonb('result'),
  progressLog: text('progress_log'),
  createdAt: timestamp('created_at').defaultNow(),
}, (table) => [
  check('tasks_status_check', sql`${table.status} IN ('pending','claimed','in_progress','completed','failed','integrated','cycle')`),
  index('idx_tasks_status').on(table.status),
  index('idx_tasks_priority').on(table.priority, table.id),
]);

// 7. files
export const files = pgTable('files', {
  projectId: text('project_id').notNull().default('default'),
  path: text('path').notNull(),
  claimant: text('claimant'),
  claimedAt: timestamp('claimed_at'),
}, (table) => [
  primaryKey({ columns: [table.projectId, table.path] }),
]);

// 8. taskFiles
export const taskFiles = pgTable('task_files', {
  taskId: integer('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  filePath: text('file_path').notNull(),
}, (table) => [
  primaryKey({ columns: [table.taskId, table.filePath] }),
  index('idx_task_files_path').on(table.filePath),
]);

// 9. taskDependencies
export const taskDependencies = pgTable('task_dependencies', {
  taskId: integer('task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  dependsOn: integer('depends_on').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
}, (table) => [
  primaryKey({ columns: [table.taskId, table.dependsOn] }),
  check('task_deps_no_self', sql`${table.taskId} != ${table.dependsOn}`),
  index('idx_task_deps_task').on(table.taskId),
  index('idx_task_deps_dep').on(table.dependsOn),
]);

// 10. rooms
export const rooms = pgTable('rooms', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().default('default'),
  name: text('name').notNull(),
  type: text('type').notNull(),
  createdBy: text('created_by').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
}, (table) => [
  check('rooms_type_check', sql`${table.type} IN ('group','direct')`),
]);

// 11. roomMembers
export const roomMembers = pgTable('room_members', {
  roomId: text('room_id').notNull().references(() => rooms.id, { onDelete: 'cascade' }),
  member: text('member').notNull(),
  joinedAt: timestamp('joined_at').defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.roomId, table.member] }),
]);

// 12. chatMessages
export const chatMessages = pgTable('chat_messages', {
  id: serial('id').primaryKey(),
  roomId: text('room_id').notNull().references(() => rooms.id, { onDelete: 'cascade' }),
  sender: text('sender').notNull(),
  content: text('content').notNull(),
  replyTo: integer('reply_to'),
  createdAt: timestamp('created_at').defaultNow(),
}, (table) => [
  index('idx_chat_room_id').on(table.roomId, table.id),
]);

// 13. teams
export const teams = pgTable('teams', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().default('default'),
  name: text('name').notNull(),
  briefPath: text('brief_path'),
  status: text('status').notNull().default('active'),
  deliverable: text('deliverable'),
  createdAt: timestamp('created_at').defaultNow(),
  dissolvedAt: timestamp('dissolved_at'),
}, (table) => [
  check('teams_status_check', sql`${table.status} IN ('active','converging','dissolved')`),
]);

// 14. teamMembers
export const teamMembers = pgTable('team_members', {
  teamId: text('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
  agentName: text('agent_name').notNull(),
  role: text('role').notNull(),
  isLeader: integer('is_leader').notNull().default(0),
}, (table) => [
  primaryKey({ columns: [table.teamId, table.agentName] }),
  uniqueIndex('idx_team_leader').on(table.teamId).where(sql`is_leader = 1`),
]);
