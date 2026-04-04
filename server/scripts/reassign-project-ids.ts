/**
 * One-off script: reassign project_id for existing data.
 *
 * - agent-1's messages  -> content-catalogue-dashboard
 * - agent-2's messages  -> ue-claude-scaffold
 *
 * Also reassigns the agents themselves and their rooms.
 *
 * Usage:  npx tsx scripts/reassign-project-ids.ts
 */

import { PGlite } from '@electric-sql/pglite';

const DATA_DIR = './data/pglite';

const AGENT_PROJECT_MAP: Record<string, string> = {
  'agent-1': 'content-catalogue-dashboard',
  'agent-2': 'ue-claude-scaffold',
};

async function main() {
  const db = new PGlite(DATA_DIR);

  // Show current state
  const before = await db.query(`
    SELECT project_id, from_agent, count(*) as cnt
    FROM messages
    GROUP BY project_id, from_agent
    ORDER BY from_agent, project_id
  `);
  console.log('Messages before:');
  console.table(before.rows);

  const agentsBefore = await db.query(`
    SELECT name, project_id FROM agents ORDER BY name
  `);
  console.log('Agents before:');
  console.table(agentsBefore.rows);

  // Reassign messages
  for (const [agent, project] of Object.entries(AGENT_PROJECT_MAP)) {
    const res = await db.query(
      `UPDATE messages SET project_id = $1 WHERE from_agent = $2`,
      [project, agent],
    );
    console.log(`Messages: ${agent} -> ${project} (${res.affectedRows} rows)`);
  }

  // Reassign agents
  for (const [agent, project] of Object.entries(AGENT_PROJECT_MAP)) {
    const res = await db.query(
      `UPDATE agents SET project_id = $1 WHERE name = $2`,
      [project, agent],
    );
    console.log(`Agents:   ${agent} -> ${project} (${res.affectedRows} rows)`);
  }

  // Reassign rooms created by those agents
  for (const [agent, project] of Object.entries(AGENT_PROJECT_MAP)) {
    const res = await db.query(
      `UPDATE rooms SET project_id = $1 WHERE created_by = $2`,
      [project, agent],
    );
    console.log(`Rooms:    ${agent} -> ${project} (${res.affectedRows} rows)`);
  }

  // Reassign tasks claimed by those agents
  for (const [agent, project] of Object.entries(AGENT_PROJECT_MAP)) {
    const res = await db.query(
      `UPDATE tasks SET project_id = $1 WHERE claimed_by = $2`,
      [project, agent],
    );
    console.log(`Tasks:    ${agent} -> ${project} (${res.affectedRows} rows)`);
  }

  // Reassign build history
  for (const [agent, project] of Object.entries(AGENT_PROJECT_MAP)) {
    const res = await db.query(
      `UPDATE build_history SET project_id = $1 WHERE agent = $2`,
      [project, agent],
    );
    console.log(`Builds:   ${agent} -> ${project} (${res.affectedRows} rows)`);
  }

  // Show final state
  const after = await db.query(`
    SELECT project_id, from_agent, count(*) as cnt
    FROM messages
    GROUP BY project_id, from_agent
    ORDER BY from_agent, project_id
  `);
  console.log('\nMessages after:');
  console.table(after.rows);

  const agentsAfter = await db.query(`
    SELECT name, project_id FROM agents ORDER BY name
  `);
  console.log('Agents after:');
  console.table(agentsAfter.rows);

  await db.close();
  console.log('\nDone.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
