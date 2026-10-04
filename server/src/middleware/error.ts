import type { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { ChainUnavailableError } from "../chains/base.js";
import { logger } from "../logger.js";

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const notFound = (message = "Resource not found") => new HttpError(404, "not_found", message);
export const badRequest = (message: string, details?: unknown) => new HttpError(400, "bad_request", message, details);
export const conflict = (message: string) => new HttpError(409, "conflict", message);
/**
 * A capability the deployment did not configure, as opposed to a request the
 * caller got wrong. 503 because retrying with the same credentials will not
 * help until an operator supplies them, and the UI hides the feature rather
 * than showing an error the user can act on.
 */
export const unavailable = (message: string, code = "unavailable") => new HttpError(503, code, message);
/** Server-side capacity, not a malformed request — retrying later is the fix. */
export const tooManyRequests = (message: string, code = "at_capacity") => new HttpError(429, code, message);

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({ error: "not_found", message: `No route for ${req.method} ${req.path}` });
}

/**
 * body-parser signals a malformed request body with a SyntaxError whose
 * `type` is "entity.parse.failed". That is the caller's fault, so it must not be
 * logged or reported as a 500 — a 400 with a clear message is both accurate and
 * avoids leaking parser internals. A payload over `limit` is likewise a 413.
 */
function classifyBodyParserError(err: unknown): HttpError | null {
  if (!(err instanceof Error) || !("type" in err)) return null;
  const type = (err as { type?: unknown }).type;
  if (typeof type !== "string") return null;

  if (type === "entity.parse.failed") {
    return badRequest("Request body is not valid JSON");
  }
  if (type === "entity.too.large") {
    return new HttpError(413, "payload_too_large", "Request body is too large");
  }
  return null;
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (res.headersSent) return;

  if (err instanceof ZodError) {
    res.status(400).json({
      error: "validation_failed",
      message: "Request failed validation",
      details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message }))
    });
    return;
  }

  const bodyError = classifyBodyParserError(err);
  if (bodyError) {
    res.status(bodyError.status).json({ error: bodyError.code, message: bodyError.message });
    return;
  }

  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.code, message: err.message, details: err.details });
    return;
  }

  // An explorer or indexer that could not be reached is a bad gateway, not an
  // internal fault, and the web client already renders this code as "Chain data
  // unavailable" rather than a generic failure.
  if (err instanceof ChainUnavailableError) {
    res.status(502).json({ error: "chain_unavailable", message: err.message, details: { chain: err.chain } });
    return;
  }

  const requestId = req.requestId;
  logger.error(`Unhandled error on ${req.method} ${req.path} (request ${requestId})`, err);

  res.status(500).json({
    error: "internal_error",
    message: "An unexpected error occurred",
    requestId,
    ...(req.auditWriteFailed ? { note: "An audit record failed to persist; contact an administrator." } : {})
  });
}

export function asyncRoute<T extends Request = Request>(
  handler: (req: T, res: Response, next: NextFunction) => Promise<unknown>
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    void Promise.resolve(handler(req as T, res, next)).catch(next);
  };
}
