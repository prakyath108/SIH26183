import argon2 from "argon2";
import crypto from "node:crypto";
import type { UserRole } from "./types.js";

export async function hashPassword(plain: string): Promise<string> {
  // OWASP-aligned argon2id parameters
  return argon2.hash(plain, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1
  });
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}

export function randomToken(bytes = 48): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function sha256(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Canonical JSON: object keys sorted lexicographically, arrays keep their order.
 *
 * The one property that matters for evidence digests is **idempotence** — the
 * artifact is hashed, stored in a JSONB column, read back and re-hashed, so
 * `canonicalJson(JSON.parse(stored))` must reproduce the original string byte
 * for byte. Anything that would not survive that round trip is normalised here
 * the same way `JSON.stringify` would normalise it:
 *
 *   - `undefined` members are dropped from objects, become `null` in arrays
 *   - non-finite numbers (`NaN`, `Infinity`) become `null`
 *   - `toJSON()` is honoured, so `Date`, `BigInt` and custom types hash as the
 *     database will actually store them
 *   - `bigint` becomes its decimal string (it would throw in `JSON.stringify`)
 */
export function canonicalJson(value: unknown): string {
  return encode(value, new Set<object>());
}

function encode(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "number":
      return Number.isFinite(value) ? JSON.stringify(value) : "null";
    case "bigint":
      return JSON.stringify(value.toString());
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "undefined":
    case "function":
    case "symbol":
      return "null";
  }

  const obj = value as object;
  if (ancestors.has(obj)) throw new Error("Cannot canonicalise a circular structure");
  ancestors.add(obj);
  try {
    const maybe = obj as { toJSON?: (key?: string) => unknown };
    if (typeof maybe.toJSON === "function") return encode(maybe.toJSON(), ancestors);

    if (Array.isArray(obj)) {
      return `[${obj.map((v) => encode(v, ancestors)).join(",")}]`;
    }

    const entries = Object.entries(obj as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${encode(v, ancestors)}`).join(",")}}`;
  } finally {
    ancestors.delete(obj);
  }
}

/** SHA-256 over the canonical form of a JSON value. */
export function sha256Json(value: unknown): string {
  return sha256(canonicalJson(value));
}

/** Constant-time string compare for opaque secrets. */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export const PERMISSIONS = {
  "case:read": ["admin", "investigator", "analyst", "viewer"],
  "case:write": ["admin", "investigator", "analyst"],
  "case:close": ["admin", "investigator"],
  "case:assign": ["admin", "investigator"],
  "trace:run": ["admin", "investigator", "analyst"],
  "evidence:read": ["admin", "investigator", "analyst", "viewer"],
  "evidence:write": ["admin", "investigator", "analyst"],
  "evidence:export": ["admin", "investigator", "analyst"],
  "alert:read": ["admin", "investigator", "analyst", "viewer"],
  "alert:triage": ["admin", "investigator", "analyst"],
  "label:challenge": ["admin", "investigator", "analyst"],
  // Reading AI output is as sensitive as reading the case, so it is gated at
  // case:read. Uploading is a write, and applying a proposal mutates entities,
  // traces and evidence — restricted to the same roles as other case writes.
  "ai:read": ["admin", "investigator", "analyst", "viewer"],
  "ai:upload": ["admin", "investigator", "analyst"],
  "ai:apply": ["admin", "investigator", "analyst"],
  "audit:read": ["admin", "investigator"],
  "user:manage": ["admin"],
  "integration:manage": ["admin"],
  "case:delete": ["admin"]
} as const satisfies Record<string, readonly UserRole[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(role: UserRole, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly UserRole[]).includes(role);
}

export function permissionsFor(role: UserRole): Permission[] {
  return (Object.keys(PERMISSIONS) as Permission[]).filter((p) => can(role, p));
}
