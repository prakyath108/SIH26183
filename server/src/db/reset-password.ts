import { fileURLToPath } from "node:url";
import { env } from "../config.js";
import { getDb, one } from "./index.js";
import { hashPassword } from "../security.js";
import { logger } from "../logger.js";

/**
 * Reset a user's password from the command line.
 *
 * This exists because `seed.ts` deliberately never overwrites `password_hash`
 * — its upsert updates display name, role and agency only. That is correct
 * behaviour for a seed (re-seeding must not silently reset a password someone
 * has since changed), but it leaves a trap: once a seeded account's password
 * differs from the value in the seed, re-running `db:seed` cannot restore it,
 * and every documented credential in the README fails with
 * `invalid_credentials`. Before this script the only way back was
 * `db:reset`, which throws away every case, note and piece of evidence in the
 * database.
 *
 * Guarded twice: it refuses to run in production, and it refuses to touch a
 * non-local Postgres host. It also revokes that user's sessions, so a password
 * reset genuinely ends access rather than leaving old refresh tokens live.
 *
 * Usage:
 *   npm run user:reset-password -- <email> [new-password]
 *
 * With no password argument a strong one is generated and printed once.
 */

const MIN_PASSWORD_LENGTH = 12;

function generatePassword(): string {
  // Avoids the punctuation set that trips shell quoting and password managers.
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghijkmnpqrstuvwxyz";
  const digits = "23456789";
  const all = upper + lower + digits;
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += all[bytes[i]! % all.length];
  // Guarantee the policy in security: upper, lower and numeric must all appear.
  return (
    upper[bytes[0]! % upper.length]! +
    lower[bytes[1]! % lower.length]! +
    digits[bytes[2]! % digits.length]! +
    out.slice(3)
  );
}

function assertLocalTarget(): void {
  if (env.isProd) {
    throw new Error("Refusing to reset a password with NODE_ENV=production.");
  }
  if (env.DATABASE_URL.trim()) {
    const host = new URL(env.DATABASE_URL).hostname;
    const allowed = ["localhost", "127.0.0.1", "postgres", "db"];
    if (!allowed.includes(host)) {
      throw new Error(`Refusing to reset a password against a database at '${host}'.`);
    }
  }
}

export async function resetPassword(email: string, supplied?: string): Promise<void> {
  assertLocalTarget();

  const target = email.trim().toLowerCase();
  if (!target) throw new Error("An email address is required.");

  const generated = !supplied;
  const password = supplied ?? generatePassword();

  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
    throw new Error("Password must include upper case, lower case and numeric characters.");
  }

  const db = await getDb();
  const user = await one<{ id: string; email: string }>(
    db,
    `SELECT id, email FROM users WHERE email = $1`,
    [target]
  );
  if (!user) throw new Error(`No user with email '${target}'.`);

  const hash = await hashPassword(password);
  await db.query(`UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1`, [user.id, hash]);
  await db.query(
    `UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = 'password_reset' WHERE user_id = $1 AND revoked_at IS NULL`,
    [user.id]
  );

  logger.info(`Password reset for ${user.email}; sessions revoked`);

  if (generated) {
    // Printed rather than logged, and only once — the operator has to capture it.
    process.stdout.write(`\n  ${user.email}  ->  ${password}\n\n`);
  }
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const [email, password] = process.argv.slice(2);
  resetPassword(email ?? "", password)
    .then(async () => {
      const db = await getDb();
      await db.close();
      process.exit(0);
    })
    .catch(async (err) => {
      logger.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
