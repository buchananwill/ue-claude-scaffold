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
  createdAt: string;
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
  type: 'build' | 'test';
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
  requested_at: string;
}
