import { config as loadDotenv } from "dotenv";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
export { repoRoot };
for (const candidate of [join(repoRoot, ".env"), join(here, "..", ".env")]) {
  if (existsSync(candidate)) {
    loadDotenv({ path: candidate });
    break;
  }
}

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8082),

  // Database - embedded PGlite (dev) or Postgres (production).
  // This must be the SAME database the server reads, since the indexer writes
  // into the server-owned `transactions` table.
  DATABASE_URL: z.string().optional().default(""),
  PGPOOL_MAX: z.coerce.number().int().positive().default(10),

  // Bitcoin - mempool.space or self-hosted
  MEMPOOL_API: z.string().url().default("https://mempool.space/api"),
  MEMPOOL_WS: z.string().url().optional(),

  // Ethereum - JSON-RPC endpoints (dedicated nodes in production)
  ETH_RPC_URL: z.string().url().default("https://ethereum-rpc.publicnode.com"),
  ETH_WS_URL: z.string().url().optional(),
  ETHERSCAN_API_KEY: z.string().optional().default(""),

  // Polygon
  POLYGON_RPC_URL: z.string().url().default("https://polygon-bor-rpc.publicnode.com"),
  POLYGON_WS_URL: z.string().url().optional(),
  POLYGONSCAN_API_KEY: z.string().optional().default(""),

  // Tron
  TRONGRID_API: z.string().url().default("https://api.trongrid.io"),
  TRONGRID_API_KEY: z.string().optional().default(""),

  // Indexing settings
  INDEX_BATCH_SIZE: z.coerce.number().int().positive().default(100),
  INDEX_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(12000),
  REORG_DEPTH: z.coerce.number().int().positive().default(6),
  START_BLOCK: z.coerce.number().int().nonnegative().optional(),

  // Health/metrics
  METRICS_ENABLED: z.enum(["true", "false"]).default("true"),
  METRICS_PORT: z.coerce.number().int().positive().default(9090)
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
  console.error(`Invalid environment configuration:\n${issues}`);
  process.exit(1);
}

export const env = {
  ...parsed.data,
  isProd: parsed.data.NODE_ENV === "production",
  usingPglite: parsed.data.DATABASE_URL.trim() === ""
};

/**
 * Hostnames of free public endpoints that are fine for a local smoke test but
 * unacceptable in production: they rate-limit hard, serve stale data, and cannot
 * carry a case load. Production must point at self-hosted or paid dedicated nodes.
 */
const PUBLIC_RPC_HOSTS = [
  "mempool.space",
  "publicnode.com",
  "api.trongrid.io",
  "infura.io",
  "alchemy.com",
  "llamarpc.com"
];

function assertDedicatedEndpoints(): void {
  if (!env.isProd) return;

  const offenders = [
    `MEMPOOL_API=${env.MEMPOOL_API}`,
    `ETH_RPC_URL=${env.ETH_RPC_URL}`,
    `POLYGON_RPC_URL=${env.POLYGON_RPC_URL}`,
    `TRONGRID_API=${env.TRONGRID_API}`
  ].filter((entry) => PUBLIC_RPC_HOSTS.some((host) => entry.includes(host)));

  if (offenders.length > 0) {
    console.error(
      "Refusing to start in production with public/shared RPC endpoints:\n  " +
        offenders.join("\n  ") +
        "\n\nSet each to a self-hosted or paid dedicated node. " +
        "Use NODE_ENV=development to run against public endpoints locally."
    );
    process.exit(1);
  }

  if (env.usingPglite) {
    console.error(
      "Refusing to start in production with embedded PGlite. Set DATABASE_URL to a real Postgres instance."
    );
    process.exit(1);
  }
}

assertDedicatedEndpoints();