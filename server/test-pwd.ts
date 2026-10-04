import { getDb } from "./dist/db/index.js";
import { verifyPassword } from "./dist/security.js";

async function check() {
  const db = await getDb();
  const admin = await db.query('SELECT password_hash FROM users WHERE email = $1', ['admin@cryptotrace.local']);
  const hash = admin.rows[0].password_hash;
  const ok = await verifyPassword(hash, 'ChangeMe!2026Admin');
  console.log('Password test (correct order):', ok);
  await db.close();
}
check().catch(console.error);