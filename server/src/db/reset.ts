import { fileURLToPath } from "node:url";
import { rm } from "node:fs/promises";
import { getDb } from "./index.js";
import { logger } from "../logger.js";
import { env } from "../config.js";
import { repoPath } from "../paths.js";

/**
 * Destructive. Drops every table in the public schema and re-runs migrations.
 * Guarded so it cannot run against a configured production database.
 */
export async function reset(): Promise<void> {
  if (env.DATABASE_URL.trim()) {
    const host = new URL(env.DATABASE_URL).hostname;
    const allowed = ["localhost", "127.0.0.1", "postgres", "db"];
    if (!allowed.includes(host) || env.isProd) {
      throw new Error(
        `Refusing to reset a database at '${host}'. db:reset only targets local development databases.`
      );
    }
  }

  if (env.usingPglite) {
    const dir = repoPath(process.env.PGLITE_DIR ?? "data/pg");
    // Deliberately not opening the database first. The whole operation is to
    // delete this directory, and opening it is the one thing guaranteed to
    // fail when the directory is corrupt, locked by a stale process, or was
    // left half-written — which are exactly the cases reset exists to recover
    // from. A previous revision called getDb() here, so a corrupt data
    // directory made db:reset abort and left no way back short of deleting the
    // folder by hand.
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    logger.info(`Removed embedded database at ${dir}`);
    return;
  }

  const db = await getDb();
  await db.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
  logger.warn("Dropped and recreated the public schema on the configured development database");
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  reset()
    .then(async () => {
      // Reopening after a PGlite reset would recreate an empty database that
      // migrate then has to initialise. Only the external-Postgres branch
      // needs a handle to close.
      if (!env.usingPglite) {
        const db = await getDb();
        await db.close();
      }
      process.exit(0);
    })
    .catch((err) => {
      logger.error("Reset failed", err);
      process.exit(1);
    });
}
