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
  plan_doc: string | null;
  status: string;
  registered_at: string;
}

export interface Task {
  id: number;
  title: string;
  description: string;
  sourcePath: string | null;
  acceptanceCriteria: string | null;
  status: string;
  priority: number;
  claimedBy: string | null;
  claimedAt: string | null;
  completedAt: string | null;
  result: unknown;
  progressLog: string | null;
  createdAt: string;
}

export interface Message {
  id: number;
  from_agent: string;
  channel: string;
  type: string;
  payload: unknown;
  claimed_by: string | null;
  claimed_at: string | null;
  resolved_at: string | null;
  result: unknown;
  created_at: string;
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
