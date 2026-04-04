import { PGlite } from '@electric-sql/pglite';

const db = new PGlite('./data/pglite');

for (const table of ['messages', 'agents', 'rooms']) {
  const res = await db.query(
    `UPDATE ${table} SET project_id = 'scaffold' WHERE project_id = 'ue-claude-scaffold'`,
  );
  console.log(`${table}: ${res.affectedRows} rows fixed`);
}

// Verify
const agents = await db.query('SELECT name, project_id FROM agents ORDER BY name');
console.table(agents.rows);

const msgs = await db.query(`
  SELECT project_id, from_agent, count(*) as cnt
  FROM messages GROUP BY project_id, from_agent ORDER BY from_agent
`);
console.table(msgs.rows);

await db.close();
console.log('Done.');
