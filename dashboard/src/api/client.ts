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

export async function apiPost<T = unknown>(path: string, body?: unknown, projectId?: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...projectHeaders(projectId) },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) {
    throw new ApiError(await extractError(res), res.status);
  }
  return res.json();
}

export async function apiPatch<T = unknown>(path: string, body?: unknown, projectId?: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...projectHeaders(projectId) },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) {
    throw new ApiError(await extractError(res), res.status);
  }
  return res.json();
}

export async function apiDelete<T = unknown>(path: string, projectId?: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { method: 'DELETE', headers: { ...projectHeaders(projectId) } });
  if (!res.ok) {
    throw new ApiError(await extractError(res), res.status);
  }
  return res.json();
}
