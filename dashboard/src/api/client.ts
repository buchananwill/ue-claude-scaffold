import type {
  ArbitrationPatternsResponse,
  ArbitrationRun,
  FailureReasonsResponse,
  FindingsResponse,
  NotePatternsResponse,
  ReviewCycleResponse,
} from './types.js';

const BASE = '/api';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function extractError(res: Response): Promise<string> {
  try {
    const body = await res.json();
    if (typeof body === 'object' && body !== null) {
      // For 5xx responses, return a generic message to avoid leaking server internals
      if (res.status >= 500) return 'Server error';
      // Fastify error responses: { error, message, statusCode }
      if (typeof body.message === 'string') return body.message;
      if (typeof body.error === 'string') return body.error;
    }
    if (res.status >= 500) return 'Server error';
    return JSON.stringify(body);
  } catch {
    if (res.status >= 500) return 'Server error';
    return `${res.status} ${res.statusText}`;
  }
}

function projectHeaders(projectId?: string): Record<string, string> {
  if (projectId) {
    return { 'x-project-id': projectId };
  }
  return {};
}

export async function apiFetch<T>(path: string, signal?: AbortSignal, projectId?: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { signal, headers: { ...projectHeaders(projectId) } });
  if (!res.ok) {
    throw new ApiError(await extractError(res), res.status);
  }
  return res.json();
}

async function apiMutate<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  projectId?: string,
): Promise<T> {
  const headers: Record<string, string> = { ...projectHeaders(projectId) };
  const init: RequestInit = { method, headers };
  if (body !== undefined || method === 'POST' || method === 'PATCH') {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body ?? {});
  }
  const res = await fetch(`${BASE}${path}`, init);
  if (!res.ok) {
    throw new ApiError(await extractError(res), res.status);
  }
  return res.json();
}

export async function apiPost<T = unknown>(path: string, body?: unknown, projectId?: string): Promise<T> {
  return apiMutate<T>('POST', path, body, projectId);
}

export async function apiPatch<T = unknown>(path: string, body?: unknown, projectId?: string): Promise<T> {
  return apiMutate<T>('PATCH', path, body, projectId);
}

export async function apiDelete<T = unknown>(path: string, projectId?: string): Promise<T> {
  return apiMutate<T>('DELETE', path, undefined, projectId);
}

// ---------------------------------------------------------------------------
// Typed helpers for the Phase 3 review / findings / arbitration endpoints.
// ---------------------------------------------------------------------------

/** Append only the params with defined string-coercible values. */
function buildQuery(params: object): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    usp.set(k, String(v));
  }
  const qs = usp.toString();
  return qs ? `?${qs}` : '';
}

/** GET /tasks/:id/reviews/:cycle */
export function fetchReviewCycle(
  taskId: number,
  cycle: number,
  signal: AbortSignal | undefined,
  projectId: string,
): Promise<ReviewCycleResponse> {
  return apiFetch<ReviewCycleResponse>(`/tasks/${taskId}/reviews/${cycle}`, signal, projectId);
}

/** GET /tasks/:id/arbitrations — list of arbitration runs for a task. */
export function fetchTaskArbitrations(
  taskId: number,
  signal: AbortSignal | undefined,
  projectId: string,
): Promise<{ runs: ArbitrationRun[] }> {
  return apiFetch<{ runs: ArbitrationRun[] }>(`/tasks/${taskId}/arbitrations`, signal, projectId);
}

export interface FindingsQuery {
  severity?: 'BLOCKING' | 'NOTE';
  reviewer?: string;
  since?: string;
  limit?: number;
  offset?: number;
}

/** GET /findings */
export function fetchFindings(
  query: FindingsQuery,
  signal: AbortSignal | undefined,
  projectId: string,
): Promise<FindingsResponse> {
  return apiFetch<FindingsResponse>(`/findings${buildQuery(query)}`, signal, projectId);
}

export interface NotePatternsQuery {
  since?: string;
  limit?: number;
}

/** GET /findings/note-patterns */
export function fetchNotePatterns(
  query: NotePatternsQuery,
  signal: AbortSignal | undefined,
  projectId: string,
): Promise<NotePatternsResponse> {
  return apiFetch<NotePatternsResponse>(`/findings/note-patterns${buildQuery(query)}`, signal, projectId);
}

export interface ArbitrationsQuery {
  since?: string;
}

/** GET /arbitrations — cross-task arbitration-pattern aggregation. */
export function fetchArbitrationPatterns(
  query: ArbitrationsQuery,
  signal: AbortSignal | undefined,
  projectId: string,
): Promise<ArbitrationPatternsResponse> {
  return apiFetch<ArbitrationPatternsResponse>(`/arbitrations${buildQuery(query)}`, signal, projectId);
}

export interface FailureReasonsQuery {
  since?: string;
}

/** GET /failures/reasons */
export function fetchFailureReasons(
  query: FailureReasonsQuery,
  signal: AbortSignal | undefined,
  projectId: string,
): Promise<FailureReasonsResponse> {
  return apiFetch<FailureReasonsResponse>(`/failures/reasons${buildQuery(query)}`, signal, projectId);
}
