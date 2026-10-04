import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { join, resolve } from "node:path";
import { env } from "../config.js";
import { logger } from "../logger.js";
import { dataDir, ensureDir } from "../paths.js";

export type SqlParam = string | number | boolean | null | Date | Buffer | object;

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

/**
 * Thin uniform query interface over two Postgres engines:
 *  - PGlite (embedded, WASM Postgres) when DATABASE_URL is empty: zero-install dev/CI
 *  - node-postgres Pool when DATABASE_URL points at a real server
 * Both speak the same SQL. Nothing else in the codebase touches the driver.
 */
export interface Db {
  query<T = Record<string, unknown>>(text: string, params?: SqlParam[]): Promise<QueryResult<T>>;
  /** Multi-statement script. No parameters; for DDL and migrations only. */
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  driver: "pglite" | "pg";
}

export class PgDb implements Db {
  readonly driver = "pg" as const;
  private pool: pg.Pool;
  private client: pg.PoolClient | null = null;
  /**
   * False for a transaction-scoped view, which borrows the parent's pool and
   * must never close it. Without this, every `transaction()` call would build a
   * second pool that nothing ever ends.
   */
  private ownsPool = true;
  private closed = false;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: env.PGPOOL_MAX });
    this.pool.on("error", (err) => logger.error("Unexpected postgres pool error", err));
  }

  /** A view of the same pool pinned to one checked-out client. */
  private scopedTo(client: pg.PoolClient): PgDb {
    const view = Object.create(PgDb.prototype) as PgDb;
    view.pool = this.pool;
    view.client = client;
    view.ownsPool = false;
    view.closed = false;
    return view;
  }

  async query<T = Record<string, unknown>>(text: string, params: SqlParam[] = []): Promise<QueryResult<T>> {
    const runner = this.client ?? this.pool;
    const res = await runner.query(text, params as unknown[]);
    return { rows: res.rows as T[], rowCount: res.rowCount ?? res.rows.length };
  }

  async exec(sql: string): Promise<void> {
    const runner = this.client ?? this.pool;
    await runner.query(sql);
  }

  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    if (this.client) return fn(this); // already inside a transaction
    const client = await this.pool.connect();
    const scoped = this.scopedTo(client);
    try {
      await client.query("BEGIN");
      const out = await fn(scoped);
      await client.query("COMMIT");
      return out;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.ownsPool) await this.pool.end();
  }
}

class PgliteDb implements Db {
  readonly driver = "pglite" as const;
  private pg: PGlite;
  private inTx = false;
  private closed = false;

  constructor(dataDir: string) {
    this.pg = new PGlite(dataDir);
  }

  async init(): Promise<void> {
    await this.pg.waitReady;
  }

  async query<T = Record<string, unknown>>(text: string, params: SqlParam[] = []): Promise<QueryResult<T>> {
    const res = await this.pg.query<T>(text, params as unknown[]);
    return { rows: res.rows, rowCount: res.affectedRows ?? res.rows.length };
  }

  /**
   * PGlite routes parameterised queries through the extended protocol, which
   * accepts one statement only. DDL scripts go through exec() instead.
   */
  async exec(sql: string): Promise<void> {
    await this.pg.exec(sql);
  }

  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    if (this.inTx) return fn(this);
    this.inTx = true;
    try {
      await this.pg.query("BEGIN");
      const out = await fn(this);
      await this.pg.query("COMMIT");
      return out;
    } catch (err) {
      await this.pg.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      this.inTx = false;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.pg.close();
  }
}

let instance: Db | null = null;
export async function getDb(): Promise<Db> {
  if (instance) return instance;

  if (env.usingPglite) {
    const dir = ensureDir(process.env.PGLITE_DIR ? resolve(process.env.PGLITE_DIR) : join(dataDir, "pg"));
    logger.info(`Using embedded Postgres (PGlite) at ${dir} — set DATABASE_URL for a real server`);
    const db = new PgliteDb(dir);
    await db.init();
    instance = db;
  } else {
    logger.info("Using PostgreSQL pool");
    instance = new PgDb(env.DATABASE_URL);
  }
  return instance;
}

export function setDb(db: Db): void {
  instance = db;
}

/** Convenience: run a query and return the first row, if any. */
export async function one<T = Record<string, unknown>>(db: Db, text: string, params: SqlParam[] = []): Promise<T | null> {
  const { rows } = await db.query<T>(text, params);
  return rows[0] ?? null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Cases are addressable by internal UUID or by human case_ref (CT-2026-0001).
 *
 * A single `WHERE id = $1 OR case_ref = $1` cannot work: the driver sends $1 as
 * text, and Postgres has no `text = uuid` operator, so the query fails at plan
 * time. We therefore branch on the shape of the input and keep the column
 * comparison typed, which also lets Postgres use the primary key / unique index.
 *
 * Returns null when the input is neither a UUID nor a well-formed case ref,
 * so callers do not need to pre-validate.
 */
export async function findCaseByIdOrRef<T = Record<string, unknown>>(db: Db, raw: string): Promise<T | null> {
  const value = raw.trim();
  if (UUID_RE.test(value)) {
    return one<T>(db, `SELECT * FROM cases WHERE id = $1::uuid`, [value]);
  }
  if (/^CT-\d{4}-\d{4,}$/i.test(value)) {
    return one<T>(db, `SELECT * FROM cases WHERE case_ref = $1`, [value.toUpperCase()]);
  }
  return null;
}

/** Convenience: run a query and return all rows. */
export async function many<T = Record<string, unknown>>(db: Db, text: string, params: SqlParam[] = []): Promise<T[]> {
  const { rows } = await db.query<T>(text, params);
  return rows;
}
