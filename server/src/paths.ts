import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root, resolved from this file rather than process.cwd(). */
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Absolute path to a file inside the repository, whatever the cwd is. */
export function repoPath(...segments: string[]): string {
  return resolve(repoRoot, ...segments);
}

/** Create a directory (recursively) if it is missing and return its path. */
export function ensureDir(path: string): string {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
  return path;
}

/**
 * Root for everything the app writes at runtime: the embedded database and
 * uploaded case documents.
 *
 * One directory rather than two, so a container only has to mount a single
 * volume and so a backup of `data/` is a complete backup. Overridable because
 * the container layout puts it outside the repository tree.
 */
export const dataDir = ensureDir(
  process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : repoPath("data")
);

/** Uploaded case documents, kept apart from the database files. */
export const uploadsDir = join(dataDir, "uploads");
