import type { FastifyPluginAsync } from 'fastify';
import { getDb } from '../drizzle-instance.js';
import * as projectsQ from '../queries/projects.js';

const projectsPlugin: FastifyPluginAsync = async (fastify) => {
  // GET /projects - list all projects
  fastify.get('/projects', async () => {
    const db = getDb();
    const rows = await projectsQ.getAll(db);
    return rows;
  });

  // GET /projects/:id - get single project
  fastify.get<{ Params: { id: string } }>('/projects/:id', async (request, reply) => {
    const db = getDb();
    const row = await projectsQ.getById(db, request.params.id);
    if (!row) {
      return reply.notFound(`Project not found: ${request.params.id}`);
    }
    return row;
  });

  // POST /projects - create a new project
  fastify.post<{
    Body: {
      id: string;
      name: string;
      engineVersion?: string;
      seedBranch?: string;
      buildTimeoutMs?: number;
      testTimeoutMs?: number;
    };
  }>('/projects', async (request, reply) => {
    const db = getDb();
    const { id, name, engineVersion, seedBranch, buildTimeoutMs, testTimeoutMs } = request.body;

    if (!id || !name) {
      return reply.badRequest('id and name are required');
    }

    if (!projectsQ.isValidProjectId(id)) {
      return reply.badRequest(`Invalid project ID: must match [a-zA-Z0-9_-]{1,64}`);
    }

    const existing = await projectsQ.getById(db, id);
    if (existing) {
      throw fastify.httpErrors.conflict(`Project already exists: ${id}`);
    }

    const row = await projectsQ.create(db, {
      id,
      name,
      engineVersion: engineVersion ?? null,
      seedBranch: seedBranch ?? null,
      buildTimeoutMs: buildTimeoutMs ?? null,
      testTimeoutMs: testTimeoutMs ?? null,
    });

    reply.code(201);
    return row;
  });

  // PATCH /projects/:id - update project config
  fastify.patch<{
    Params: { id: string };
    Body: {
      name?: string;
      engineVersion?: string | null;
      seedBranch?: string | null;
      buildTimeoutMs?: number | null;
      testTimeoutMs?: number | null;
    };
  }>('/projects/:id', async (request, reply) => {
    const db = getDb();
    const { id } = request.params;

    const existing = await projectsQ.getById(db, id);
    if (!existing) {
      return reply.notFound(`Project not found: ${id}`);
    }

    const updated = await projectsQ.update(db, id, request.body);
    return updated;
  });

  // DELETE /projects/:id - reject with 409 if any data exists
  fastify.delete<{ Params: { id: string } }>('/projects/:id', async (request, reply) => {
    const db = getDb();
    const { id } = request.params;

    const existing = await projectsQ.getById(db, id);
    if (!existing) {
      return reply.notFound(`Project not found: ${id}`);
    }

    const hasData = await projectsQ.hasReferencingData(db, id);
    if (hasData) {
      throw fastify.httpErrors.conflict(
        `Cannot delete project "${id}": it has associated data. Remove all agents, tasks, messages, builds, and other data first.`
      );
    }

    await projectsQ.remove(db, id);
    return { ok: true };
  });
};

export default projectsPlugin;
