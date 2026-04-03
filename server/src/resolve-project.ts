import type { ScaffoldConfig, MergedProjectConfig } from './config.js';
import { getProject } from './config.js';
import type { DrizzleDb } from './drizzle-instance.js';
import * as projectsQ from './queries/projects.js';

/**
 * Resolve a project by merging the DB row (if any) with JSON config.
 *
 * This is the canonical helper for the repeated pattern:
 *   const dbRow = await projectsQ.getById(db, projectId);
 *   const project = getProject(config, projectId, dbRow ?? undefined);
 *
 * Callers should handle the thrown Error (which has a sanitised message)
 * according to their route's error convention.
 */
export async function resolveProject(
  config: ScaffoldConfig,
  db: DrizzleDb,
  projectId: string,
): Promise<MergedProjectConfig> {
  const dbRow = await projectsQ.getById(db, projectId);
  return getProject(config, projectId, dbRow ?? undefined);
}
