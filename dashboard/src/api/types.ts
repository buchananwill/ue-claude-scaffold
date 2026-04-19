export interface Project {
  id: string;
  name: string;
  engineVersion: string | null;
  seedBranch: string | null;
  buildTimeoutMs: number | null;
  testTimeoutMs: number | null;
  createdAt: string;
}

export interface HealthResponse {
  status: string;
  dbPath: string;
  config: {
    port: number;
    projectName: string;
    ubtLockTimeoutMs: number;
  };
}

export interface Agent {
  id: string;
  name: string;
  worktree: string;
  planDoc: string | null;
  status: string;
  registeredAt: string;
}

export interface Task {
  id: number;
  title: string;
  description: string;
  sourcePath: string | null;
  acceptanceCriteria: string | null;
  status: string;
  priority: number;
  files: string[];
  dependsOn: number[];
  blockedBy: number[];
  blockReasons: string[];
  claimedBy: string | null;
  claimedAt: string | null;
  completedAt: string | null;
  result: unknown;
  progressLog: string | null;
  agentTypeOverride: string | null;
  createdAt: string;
}

export interface TasksPage {
  tasks: Task[];
  total: number;
}

export interface Message {
  id: number;
  fromAgent: string;
  channel: string;
  type: string;
  payload: unknown;
  claimedBy: string | null;
  claimedAt: string | null;
  resolvedAt: string | null;
  result: unknown;
  createdAt: string;
}

export interface SearchResults {
  tasks: Task[];
  messages: Message[];
  agents: Agent[];
}

export interface BuildRecord {
  id: number;
  agent: string;
  type: "build" | "test";
  startedAt: string;
  durationMs: number | null;
  success: boolean | null;
  output: string | null;
  stderr: string | null;
}

export interface UbtStatus {
  holder: string | null;
  acquiredAt: string | null;
  stale?: boolean;
  queue: UbtQueueEntry[];
  estimatedWaitMs: number;
}

export interface UbtQueueEntry {
  id: number;
  agent: string;
  priority: number;
  requestedAt: string;
}

export interface Room {
  id: string;
  name: string;
  type: "group" | "direct";
  createdBy: string;
  createdAt: string;
  memberCount: number;
}

export interface RoomMember {
  member: string;
  joinedAt: string;
}

export interface RoomDetail {
  id: string;
  name: string;
  type: "group" | "direct";
  createdBy: string;
  createdAt: string;
  members: RoomMember[];
}

export interface ChatMessage {
  id: number;
  roomId: string;
  sender: string;
  content: string;
  replyTo: number | null;
  createdAt: string;
}

export interface Team {
  id: string;
  name: string;
  briefPath: string | null;
  status: string;
  deliverable: string | null;
  createdAt: string;
  dissolvedAt: string | null;
}

export interface TeamMember {
  agentName: string;
  role: string;
  isLeader: boolean;
}

export interface TeamDetail {
  id: string;
  name: string;
  briefPath: string | null;
  status: string;
  deliverable: string | null;
  createdAt: string;
  dissolvedAt: string | null;
  members: TeamMember[];
}
