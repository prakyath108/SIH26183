import { env } from "./config.js";

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const CURRENT_LEVEL = env.isProd ? LEVELS.info : LEVELS.debug;

function formatArgs(args: unknown[]): string {
  return args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ");
}

export const logger = {
  debug(...args: unknown[]): void {
    if (CURRENT_LEVEL <= LEVELS.debug) console.debug(`[DEBUG] ${new Date().toISOString()}`, formatArgs(args));
  },
  info(...args: unknown[]): void {
    if (CURRENT_LEVEL <= LEVELS.info) console.info(`[INFO] ${new Date().toISOString()}`, formatArgs(args));
  },
  warn(...args: unknown[]): void {
    if (CURRENT_LEVEL <= LEVELS.warn) console.warn(`[WARN] ${new Date().toISOString()}`, formatArgs(args));
  },
  error(...args: unknown[]): void {
    if (CURRENT_LEVEL <= LEVELS.error) console.error(`[ERROR] ${new Date().toISOString()}`, formatArgs(args));
  }
};