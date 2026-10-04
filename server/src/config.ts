import { config as loadDotenv } from "dotenv";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// .env lives at the repository root so the web and server workspaces share it.
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
for (const candidate of [join(repoRoot, ".env"), join(here, "..", ".env")]) {
  if (existsSync(candidate)) {
    loadDotenv({ path: candidate });
    break;
  }
}

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8080),
  // Interface to bind. 127.0.0.1 keeps the app reachable only from this
  // machine. 0.0.0.0 would also expose it to every device on the network,
  // which is never what you want for a case-management app holding
  // investigation data. Set 0.0.0.0 deliberately to serve the LAN.
  HOST: z.string().default("127.0.0.1"),
  CORS_ORIGIN: z.string().default("http://localhost:8080"),
  WS_PORT: z.coerce.number().int().positive().default(8081),

  JWT_SECRET: z.string().min(16, "JWT_SECRET must be at least 16 characters"),
  JWT_EXPIRES_IN: z.string().default("15m"),
  JWT_REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(7),

  DATABASE_URL: z.string().optional().default(""),
  PGPOOL_MAX: z.coerce.number().int().positive().default(10),

  MEMPOOL_API: z.string().url().default("https://mempool.space/api"),
  ETH_RPC_URL: z.string().url().default("https://ethereum-rpc.publicnode.com"),
  /** Comma-separated extras, tried when the primary is down or throttled. */
  ETH_RPC_FALLBACKS: z
    .string()
    .optional()
    .default("https://eth.llamarpc.com,https://eth.drpc.org,https://1rpc.io/eth"),
  POLYGON_RPC_URL: z.string().url().default("https://polygon-bor-rpc.publicnode.com"),
  POLYGON_RPC_FALLBACKS: z
    .string()
    .optional()
    .default("https://polygon.drpc.org,https://1rpc.io/matic"),
  ETHERSCAN_API_KEY: z.string().optional().default(""),
  TRONGRID_API: z.string().url().default("https://api.trongrid.io"),
  TRONGRID_API_KEY: z.string().optional().default(""),
  POLYGONSCAN_API_KEY: z.string().optional().default(""),
  SAHYOG_API_URL: z.string().url().default("https://api.sahyog.gov.in"),
  SAHYOG_API_KEY: z.string().optional().default(""),
  NCRP_API_URL: z.string().url().default("https://api.ncrp.gov.in"),
  NCRP_API_KEY: z.string().optional().default(""),

  // ---- AI document analysis ----
  // Blank disables every AI route with a typed 503, so the platform stays fully
  // usable without a key rather than failing at import time.
  OPENAI_API_KEY: z.string().optional().default(""),
  OPENAI_MODEL: z.string().default("gpt-4o-mini"),
  /** Optional custom base URL (e.g. "https://openrouter.ai/api/v1" for OpenRouter). */
  // Tolerates an empty string. Container runtimes hand an unset variable through
  // as "", and `z.string().url().optional()` rejects "" (only `undefined` skips
  // the check), which made the app refuse to boot whenever the variable was
  // declared but left blank.
  OPENAI_BASE_URL: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().url().optional()
  ),
  /** Master switch. Distinct from a missing key: this turns AI off on purpose. */
  AI_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  /** Upload ceiling for case documents. */
  AI_MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(100).default(20),
  /** Characters of extracted text sent per analysis call. */
  AI_MAX_INPUT_CHARS: z.coerce.number().int().min(2_000).max(400_000).default(60_000),
  /** Per-call wall-clock budget. Extraction is a request-path operation. */
  AI_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(300_000).default(90_000),
  /** Concurrent analyses allowed at once, to bound upstream spend. */
  AI_MAX_CONCURRENT: z.coerce.number().int().min(1).max(16).default(3),

  // ---- Advisory ML risk service ----
  // Empty disables the advisory entirely. This is the normal state: there is no
  // fitted model to serve, so pointing at the service only buys a null score.
  //
  // Validated as "URL or blank" rather than a bare z.url(): a template .env
  // carries `RISK_SERVICE_URL=` with nothing after it, and z.url() rejects an
  // empty string, which would stop the server booting on a stock config.
  RISK_SERVICE_URL: z
    .string()
    .optional()
    .transform((v) => v?.trim() ?? "")
    .refine((v) => v === "" || z.string().url().safeParse(v).success, {
      message: "must be a URL, or empty to disable the advisory"
    }),
  /**
   * Per-call budget. The advisory sits on the case-creation and address-lookup
   * request path, so it must never be the reason a request fails. Kept short
   * deliberately: a slow second opinion is worth less than no second opinion.
   */
  RISK_SERVICE_TIMEOUT_MS: z.coerce.number().int().min(200).max(10_000).default(1_500)
});

/** Split a comma-separated URL list, dropping blanks and duplicates. */
function urlList(value: string): string[] {
  return [...new Set(value.split(",").map((s) => s.trim()).filter(Boolean))];
}

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
  console.error(`Invalid environment configuration:\n${issues}`);
  console.error("\nCopy .env.example to .env and fill in the values.");
  process.exit(1);
}

const raw = parsed.data;

/**
 * Substrings that mark a value as a placeholder regardless of what surrounds
 * them. The previous check compared against four exact strings, so a near-miss
 * like `changeme-2026-production` sailed through.
 */
const PLACEHOLDER_TOKENS = [
  "change-me",
  "changeme",
  "change_me",
  "dev-only",
  "devonly",
  "insecure",
  "placeholder",
  "replace",
  "example",
  "your-secret",
  "yoursecret",
  "password",
  "secret123",
  "fixme",
  "todo",
  "dummy",
  "sample"
];

/**
 * Reasons a secret is rejected, or an empty array when it is acceptable.
 * Length alone is not evidence of strength: `aaaaaaaaaaaaaaaa` is 16 characters
 * long and carries four bits.
 */
function secretDefects(secret: string): string[] {
  const defects: string[] = [];
  const lower = secret.toLowerCase();

  if (secret.length < 32) defects.push(`is ${secret.length} characters; use at least 32`);
  if (new Set(secret).size < 12) defects.push("has too few distinct characters");

  const token = PLACEHOLDER_TOKENS.find((t) => lower.includes(t));
  if (token) defects.push(`contains the placeholder fragment "${token}"`);

  return defects;
}

if (raw.NODE_ENV === "production") {
  const defects = secretDefects(raw.JWT_SECRET);
  if (defects.length > 0) {
    console.error("Refusing to start: JWT_SECRET is not production-grade.");
    for (const defect of defects) console.error(`  - it ${defect}`);
    console.error(
      "\nGenerate one with:\n  node -e \"console.log(require('crypto').randomBytes(48).toString('hex'))\""
    );
    process.exit(1);
  }
}

export const env = {
  ...raw,
  isProd: raw.NODE_ENV === "production",
  corsOrigins: raw.CORS_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean),
  hasEtherscanKey: Boolean(raw.ETHERSCAN_API_KEY),
  hasTrongridKey: Boolean(raw.TRONGRID_API_KEY),
  hasSahyogKey: Boolean(raw.SAHYOG_API_KEY),
  hasNcrpKey: Boolean(raw.NCRP_API_KEY),
  usingPglite: raw.DATABASE_URL.trim() === "",
  /**
   * Public EVM endpoints are unreliable individually — Cloudflare's node
   * intermittently answers with `result: null` or a "Cannot fulfill request"
   * error body, which looks like a healthy response but carries no block data.
   * Rotating across a small pool keeps lookups working when one node degrades.
   */
  ethRpcUrls: [raw.ETH_RPC_URL, ...urlList(raw.ETH_RPC_FALLBACKS)],
  polygonRpcUrls: [raw.POLYGON_RPC_URL, ...urlList(raw.POLYGON_RPC_FALLBACKS)],
  seedAdminEmail: z.string().email().parse(process.env.SEED_ADMIN_EMAIL?.trim() || "admin@cryptotrace.local"),
  seedAdminPassword: z.string().min(12).parse(process.env.SEED_ADMIN_PASSWORD?.trim() || "ChangeMe!2026Admin"),
  hasOpenAiKey: raw.OPENAI_API_KEY.trim().length > 0,
  wsPort: raw.WS_PORT,
  /**
   * Both a switch and a key are required. `AI_ENABLED=false` lets an operator
   * keep the key in the environment while refusing to send case material to a
   * third party, which is the whole point of a switch.
   */
  aiAvailable: raw.AI_ENABLED && raw.OPENAI_API_KEY.trim().length > 0,
  riskServiceUrl: raw.RISK_SERVICE_URL.replace(/\/+$/, ""),
  riskServiceAvailable: raw.RISK_SERVICE_URL.length > 0
};

export type Env = typeof env;
