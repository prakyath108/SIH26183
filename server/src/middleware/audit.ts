import type { Request, Response, NextFunction } from "express";
import crypto from "node:crypto";
import type { Db } from "../db/index.js";
import { logger } from "../logger.js";

export interface AuditEntry {
  actorId?: string | null;
  actorEmail?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  caseRef?: string | null;
  before?: unknown;
  after?: unknown;
  outcome?: "success" | "failure";
  req?: Request;
}

/**
 * Append-only audit writer. Never throws into the request path: a failed audit
 * write is a serious defect, so it is logged loudly and surfaced via the
 * `auditWriteFailed` flag on the request for the error handler to report.
 */
export async function audit(db: Db, entry: AuditEntry): Promise<void> {
  try {
    const ip = entry.req ? clientIp(entry.req) : null;
    const ua = entry.req?.headers["user-agent"] ?? null;
    await db.query(
      `INSERT INTO audit_log (actor_id, actor_email, action, entity_type, entity_id, case_ref, before, after, ip, user_agent, outcome)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        entry.actorId ?? null,
        entry.actorEmail ?? null,
        entry.action,
        entry.entityType,
        entry.entityId ?? null,
        entry.caseRef ?? null,
        entry.before === undefined ? null : JSON.stringify(entry.before),
        entry.after === undefined ? null : JSON.stringify(entry.after),
        ip,
        ua,
        entry.outcome ?? "success"
      ]
    );
  } catch (err) {
    if (entry.req) entry.req.auditWriteFailed = true;
    logger.error("AUDIT WRITE FAILED", err);
  }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auditWriteFailed?: boolean;
    }
  }
}

export function clientIp(req: Request): string | null {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length) return fwd.split(",")[0]?.trim() ?? null;
  return req.ip ?? req.socket.remoteAddress ?? null;
}

export function requestId(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.headers["x-request-id"];
  const id = typeof incoming === "string" && incoming.length <= 64 ? incoming : crypto.randomUUID();
  req.requestId = id;
  res.setHeader("X-Request-Id", id);
  next();
}
