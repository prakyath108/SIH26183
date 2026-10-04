import { getDb } from "./dist/db/index.js";

async function check() {
  const db = await getDb();
  const admin = await db.query('SELECT is_active FROM users WHERE email = $1', ['admin@cryptotrace.local']);
  console.log('is_active:', admin.rows[0]?.is_active);
  await db.close();
}
check().catch(console.error);