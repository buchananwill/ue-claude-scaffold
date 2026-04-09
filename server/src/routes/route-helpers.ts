import * as agentsQ from '../queries/agents.js';
import type { AgentPublicRow } from '../queries/agents.js';
import type { DrizzleDb } from '../drizzle-instance.js';

/**
 * Resolve an agent name to its database row.
 * Returns the agent row if found, or null if no agent with that name exists
 * in the given project.
 */
export async function resolveAgentId(
  db: DrizzleDb,
  projectId: string,
  name: string,
): Promise<AgentPublicRow | null> {
  return agentsQ.getByName(db, projectId, name);
}
