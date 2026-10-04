import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getDb } from "./index.js";
import { logger } from "../logger.js";

const here = dirname(fileURLToPath(import.meta.url));

export async function migrate(): Promise<void> {
  const db = await getDb();
  const sql = await readFile(join(here, "schema.sql"), "utf8");
  const started = Date.now();
  await db.exec(sql);

  // Add columns to existing graph_edges tables (CREATE TABLE IF NOT EXISTS
  // does not add columns). These are idempotent: IF NOT EXISTS has no effect
  // if the column already exists.
  const alters = [
    `ALTER TABLE IF EXISTS graph_edges ADD COLUMN IF NOT EXISTS fee_native NUMERIC(38, 18)`,
    `ALTER TABLE IF EXISTS graph_edges ADD COLUMN IF NOT EXISTS evidence_source TEXT NOT NULL DEFAULT 'stored'`,
    `ALTER TABLE IF EXISTS graph_edges ADD COLUMN IF NOT EXISTS evidence_reasons JSONB NOT NULL DEFAULT '[]'::jsonb`
  ];
  for (const stmt of alters) {
    await db.query(stmt);
  }

  logger.info(`Schema applied (${db.driver}) in ${Date.now() - started}ms`);
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  migrate()
    .then(async () => {
      const db = await getDb();
      await db.close();
      process.exit(0);
    })
    .catch((err) => {
      logger.error("Migration failed", err);
      process.exit(1);
    });
}
