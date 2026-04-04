import { PGlite } from '@electric-sql/pglite';
const db = new PGlite('./data/pglite');
const res = await db.query('SELECT id, name FROM projects ORDER BY id');
console.table(res.rows);
await db.close();
