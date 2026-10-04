import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { env, repoRoot } from "./config.js";
import { logger } from "./logger.js";
import type { Chain, IndexedTransaction } from "./types.js";

export type SqlParam = string | number | boolean | null | Date | object;

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

/**
 * Uniform query interface over two Postgres engines:
 *  - PGlite (embedded WASM Postgres) when DATABASE_URL is empty: zero-install dev/CI
 *  - node-postgres Pool when DATABASE_URL points at a real server
 *
 * Deliberately not better-sqlite3: this indexer must write into the *same*
 * `transactions` table the server reads for tracing, reports and AI tools, and
 * that table is Postgres with JSONB/NUMERIC/timestamptz columns.
 */
export interface Db {
  query<T = Record<string, unknown>>(text: string, params?: SqlParam[]): Promise<QueryResult<T>>;
  /** Multi-statement script. No parameters; for DDL only. */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
  driver: "pglite" | "pg";
}

class PgDb implements Db {
  readonly driver = "pg" as const;
  private pool: pg.Pool;
  private closed = false;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: env.PGPOOL_MAX });
    this.pool.on("error", (err) => logger.error("Unexpected postgres pool error", { error: err.message }));
  }

  async query<T = Record<string, unknown>>(text: string, params: SqlParam[] = []): Promise<QueryResult<T>> {
    const res = await this.pool.query(text, params as unknown[]);
    return { rows: res.rows as T[], rowCount: res.rowCount ?? res.rows.length };
  }

  async exec(sql: string): Promise<void> {
    await this.pool.query(sql);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.pool.end();
  }
}

class PgliteDb implements Db {
  readonly driver = "pglite" as const;
  private pg: PGlite;
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

  /** PGlite routes parameterised queries through the extended protocol (one statement). */
  async exec(sql: string): Promise<void> {
    await this.pg.exec(sql);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.pg.close();
  }
}

let instance: Db | null = null;

/**
 * Resolves the connection and creates `indexer_state` / `blocks` if missing.
 *
 * The shared `transactions` table is intentionally NOT created here: it is owned
 * by the server (`server/src/db/schema.sql`), which is the single source of truth
 * for its columns. This indexer only writes into it, so a column drift surfaces
 * as a loud query error instead of a silently forked duplicate table.
 */
export async function getDb(): Promise<Db> {
  if (instance) return instance;

  if (env.usingPglite) {
    // Must resolve to the *same* directory the server opens, or dev silently
    // splits into two databases and indexed rows stay invisible to the server.
    // The server anchors on repoPath("data") from server/src/paths.ts, i.e.
    // <repo>/server/data; mirror that instead of trusting process.cwd().
    const dir = resolve(process.env.PGLITE_DIR ?? join(repoRoot, "server", "data", "pg"));
    mkdirSync(dir, { recursive: true });
    logger.info(`Using embedded Postgres (PGlite) at ${dir} — set DATABASE_URL for a real server`);
    const db = new PgliteDb(dir);
    await db.init();
    instance = db;
  } else {
    logger.info("Using PostgreSQL pool");
    instance = new PgDb(env.DATABASE_URL);
  }

  await initSchema(instance);
  return instance;
}

async function initSchema(db: Db): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS indexer_state (
      chain             TEXT PRIMARY KEY,
      last_indexed_block BIGINT NOT NULL DEFAULT 0,
      last_indexed_time  BIGINT NOT NULL DEFAULT 0,
      is_indexing        BOOLEAN NOT NULL DEFAULT FALSE
    );

    CREATE TABLE IF NOT EXISTS blocks (
      chain      TEXT NOT NULL,
      height     BIGINT NOT NULL,
      hash       TEXT NOT NULL,
      timestamp  BIGINT NOT NULL,
      tx_count   INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (chain, height)
    );
  `);
}

interface StateRow {
  chain: string;
  last_indexed_block: string | number;
  last_indexed_time: string | number;
  is_indexing: boolean;
}

export async function getIndexerState(chain: Chain): Promise<IndexerStateRow> {
  const db = await getDb();
  const { rows } = await db.query<StateRow>(
    `SELECT * FROM indexer_state WHERE chain = $1`,
    [chain]
  );
  const row = rows[0];

  if (!row) {
    const startBlock = env.START_BLOCK ?? 0;
    await db.query(
      `INSERT INTO indexer_state (chain, last_indexed_block, last_indexed_time, is_indexing)
       VALUES ($1, $2, 0, FALSE)
       ON CONFLICT (chain) DO NOTHING`,
      [chain, startBlock]
    );
    return { chain, lastIndexedBlock: startBlock, lastIndexedTime: 0, isIndexing: false };
  }

  return {
    chain: row.chain as Chain,
    lastIndexedBlock: Number(row.last_indexed_block),
    lastIndexedTime: Number(row.last_indexed_time),
    isIndexing: row.is_indexing === true
  };
}

export interface IndexerStateRow {
  chain: Chain;
  lastIndexedBlock: number;
  lastIndexedTime: number;
  isIndexing: boolean;
}

export async function setIndexerState(chain: Chain, state: Partial<IndexerStateRow>): Promise<void> {
  const db = await getDb();
  const updates: string[] = [];
  const params: SqlParam[] = [];

  // Params are appended in lockstep with `updates`, so the placeholder index is
  // simply the current param count. Postgres numbers placeholders 1-based.
  const add = (column: string, value: SqlParam) => {
    params.push(value);
    updates.push(`${column} = $${params.length}`);
  };

  if (state.lastIndexedBlock !== undefined) add("last_indexed_block", state.lastIndexedBlock);
  if (state.lastIndexedTime !== undefined) add("last_indexed_time", state.lastIndexedTime);
  if (state.isIndexing !== undefined) add("is_indexing", state.isIndexing);

  if (updates.length === 0) return;

  params.push(chain);
  await db.query(`UPDATE indexer_state SET ${updates.join(", ")} WHERE chain = $${params.length}`, params);
}

/**
 * Upserts into the server-owned `transactions` table.
 *
 * Column mapping is deliberate and must track `server/src/db/schema.sql`:
 *   blockTime -> timestamp (timestamptz), value -> value_native, fee -> fee_native.
 * `value`/`fee` arrive as exact decimal strings from formatUnits, so they are
 * handed to Postgres as text and cast by the NUMERIC(38,18) column.
 */
export async function storeTransactions(txs: IndexedTransaction[]): Promise<void> {
  if (txs.length === 0) return;
  const db = await getDb();

  for (const tx of txs) {
    await db.query(
      `INSERT INTO transactions
         (chain, tx_hash, block_height, timestamp, from_address, to_address,
          value_native, value_usd, fee_native, status, transfers, raw)
       VALUES ($1, $2, $3, to_timestamp($4), $5, $6, $7::numeric, $8::numeric, $9::numeric, $10, $11::jsonb, $12::jsonb)
       ON CONFLICT (chain, tx_hash) DO UPDATE SET
         block_height = EXCLUDED.block_height,
         timestamp    = EXCLUDED.timestamp,
         from_address = EXCLUDED.from_address,
         to_address   = EXCLUDED.to_address,
         value_native = EXCLUDED.value_native,
         value_usd    = EXCLUDED.value_usd,
         fee_native   = EXCLUDED.fee_native,
         status       = EXCLUDED.status,
         transfers    = EXCLUDED.transfers,
         raw          = EXCLUDED.raw`,
      [
        tx.chain,
        tx.txHash,
        tx.blockHeight,
        tx.blockTime,
        tx.from,
        tx.to,
        tx.value,
        tx.valueUsd,
        tx.fee,
        tx.status,
        JSON.stringify(tx.transfers ?? []),
        JSON.stringify(tx.raw ?? {})
      ]
    );
  }
}

export async function storeBlock(
  chain: Chain,
  height: number,
  hash: string,
  timestamp: number,
  txCount: number
): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO blocks (chain, height, hash, timestamp, tx_count)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (chain, height) DO UPDATE SET
       hash = EXCLUDED.hash, timestamp = EXCLUDED.timestamp, tx_count = EXCLUDED.tx_count`,
    [chain, height, hash, timestamp, txCount]
  );
}

export async function closeDb(): Promise<void> {
  if (instance) {
    await instance.close();
    instance = null;
  }
}