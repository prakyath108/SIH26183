import jwt from "jsonwebtoken";
import type { Request, Response, NextFunction } from "express";
import { env } from "../config.js";
import { logger } from "../logger.js";
import { can, type Permission } from "../security.js";
import type { UserRole } from "../types.js";

export interface AuthUser {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  agency: string | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      requestId?: string;
    }
  }
}

export function signAccessToken(user: AuthUser): string {
  return jwt.sign(
    { sub: user.id, email: user.email, name: user.displayName, role: user.role },
    env.JWT_SECRET,
    { expiresIn: env.JWT_EXPIRES_IN, issuer: "cryptotrace", audience: "cryptotrace-web" } as jwt.SignOptions
  );
}

export function verifyAccessToken(token: string): AuthUser {
  const payload = jwt.verify(token, env.JWT_SECRET, {
    issuer: "cryptotrace",
    audience: "cryptotrace-web"
  }) as jwt.JwtPayload;

  if (typeof payload.sub !== "string" || typeof payload.role !== "string") {
    throw new Error("Malformed access token");
  }
  return {
    id: payload.sub,
    email: String(payload.email ?? ""),
    displayName: String(payload.name ?? ""),
    role: payload.role as UserRole,
    agency: null
  };
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ error: "unauthorized", message: "Missing bearer token" });
    return;
  }
  try {
    req.user = verifyAccessToken(header.slice(7));
    next();
  } catch (err) {
    const expired = err instanceof jwt.TokenExpiredError;
    res.status(401).json({
      error: expired ? "token_expired" : "unauthorized",
      message: expired ? "Access token expired" : "Invalid access token"
    });
  }
}

export function requirePermission(permission: Permission) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: "unauthorized", message: "Authentication required" });
      return;
    }
    if (!can(user.role, permission)) {
      logger.warn("Permission denied", { user: user.email, permission, path: req.path });
      res.status(403).json({ error: "forbidden", message: `Role '${user.role}' cannot ${permission}` });
      return;
    }
    next();
  };
}

export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: "unauthorized", message: "Authentication required" });
      return;
    }
    if (!roles.includes(req.user.role)) {
      res.status(403).json({ error: "forbidden", message: `Requires one of: ${roles.join(", ")}` });
      return;
    }
    next();
  };
}
