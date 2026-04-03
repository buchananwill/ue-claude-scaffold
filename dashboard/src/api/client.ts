const BASE = '/api';

let currentProjectId: string | null = null;

export function setCurrentProjectId(id: string | null) {
  currentProjectId = id;
}

export function getCurrentProjectId(): string | null {
  return currentProjectId;
}

function projectHeaders(): Record<string, string> {
  if (currentProjectId) {
    return { 'x-project-id': currentProjectId };
  }
  return {};
}

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
      // Fastify error responses: { error, message, statusCode }
      if (typeof body.message === 'string') return body.message;
      if (typeof body.error === 'string') return body.error;
    }
    return JSON.stringify(body);
  } catch {
    return `${res.status} ${res.statusText}`;
  }
}

export async function apiFetch<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { signal, headers: { ...projectHeaders() } });
  if (!res.ok) {
    throw new ApiError(await extractError(res), res.status);
  }
  return res.json();
}

export async function apiPost<T = unknown>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...projectHeaders() },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) {
    throw new ApiError(await extractError(res), res.status);
  }
  return res.json();
}

export async function apiPatch<T = unknown>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...projectHeaders() },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) {
    throw new ApiError(await extractError(res), res.status);
  }
  return res.json();
}

export async function apiDelete<T = unknown>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { method: 'DELETE', headers: { ...projectHeaders() } });
  if (!res.ok) {
    throw new ApiError(await extractError(res), res.status);
  }
  return res.json();
}
