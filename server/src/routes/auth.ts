import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { asyncRoute, HttpError } from "../middleware/error.js";
import { requireAuth } from "../middleware/auth.js";
import { audit } from "../middleware/audit.js";
import { one, getDb, type Db } from "../db/index.js";
import { hashPassword, randomToken, sha256 } from "../security.js";
import { env } from "../config.js";
import { logger } from "../logger.js";
import { permissionsFor } from "../security.js";
import { signAccessToken } from "../middleware/auth.js";


export const authRouter = Router();

/**
 * Login throttling, backed by the `login_attempts` table.
 *
 * The first implementation kept counters in a per-process Map. That reset on
 * every restart and, behind more than one instance, each process enforced its
 * own budget — so an attacker got `MAX_ATTEMPTS × instances` guesses per window
 * and a redeploy handed them a clean slate. Rows in the shared database survive
 * both.
 *
 * The second implementation used a single `(email, ip)` bucket, which has two
 * flaws that pull in opposite directions. An attacker rotating source addresses
 * gets a fresh budget per address and can guess an account indefinitely; a
 * legitimate user on a rotating address (mobile, VPN flapping) gets a fresh
 * budget too, so the limit barely applies. There are now two independent
 * budgets and a login is refused if either is exhausted:
 *
 *   - **per account**, `ACCOUNT_LIMIT`: the real defence against credential
 *     stuffing. It follows the account, not the caller, so rotating IPs buys an
 *     attacker nothing. Set generously enough to absorb ordinary typos, because
 *     exceeding it locks out the legitimate owner and not the attacker.
 *   - **per source address**, `ADDRESS_LIMIT`: the defence against one host
 *     spraying many accounts. It is shared, so it is only tightened to the
 *     point where a single office or NAT egress cannot exhaust it by accident.
 *
 * A successful login clears the account bucket only. Clearing the address
 * bucket on success would let an attacker reset it by occasionally guessing a
 * password correctly, and it is harmless to let it decay on its own.
 */
const ACCOUNT_LIMIT = 20;
const ADDRESS_LIMIT = 60;
const WINDOW_MS = 10 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
let lastCleanupAt = 0;

/** Bounded by the number of distinct emails and addresses an attacker can name. */
async function sweepExpiredAttempts(db: Db) {
  const now = Date.now();
  if (now - lastCleanupAt < CLEANUP_INTERVAL_MS) return;
  lastCleanupAt = now;
  try {
    await db.query(`DELETE FROM login_attempts WHERE reset_at <= now()`);
  } catch (err) {
    // Housekeeping only: a failure here must not fail a login. Rows are
    // reclaimed on read regardless, because the counter resets itself once
    // reset_at has passed.
    logger.warn("Login attempt sweep failed", err);
  }
}

/**
 * Count this attempt and report the running total for the key. The upsert is
 * atomic, so concurrent attempts on the same key cannot both read the
 * pre-increment value and slip past the limit.
 */
async function recordAttempt(db: Db, key: string): Promise<number> {
  const resetAt = new Date(Date.now() + WINDOW_MS);
  const row = await one<{ count: number }>(
    db,
    `INSERT INTO login_attempts (key, count, reset_at, updated_at)
     VALUES ($1, 1, $2, now())
     ON CONFLICT (key) DO UPDATE SET
       count    = CASE WHEN login_attempts.reset_at <= now() THEN 1 ELSE login_attempts.count + 1 END,
       reset_at = CASE WHEN login_attempts.reset_at <= now() THEN $2 ELSE login_attempts.reset_at END,
       updated_at = now()
     RETURNING count`,
    [key, resetAt.toISOString()]
  );
  return row?.count ?? 1;
}

async function clearAttempts(db: Db, ...keys: string[]): Promise<void> {
  await db.query(`DELETE FROM login_attempts WHERE key = ANY($1)`, [keys]);
}

const loginSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(200)
});

authRouter.post(
  "/login",
  asyncRoute(async (req: Request, res: Response) => {
    const body = loginSchema.parse(req.body);
    const accountKey = `account:${body.email.toLowerCase()}`;
    const addressKey = `address:${req.ip ?? "unknown"}`;
    const db = await getDb();

    await sweepExpiredAttempts(db);
    const [accountCount, addressCount] = await Promise.all([
      recordAttempt(db, accountKey),
      recordAttempt(db, addressKey)
    ]);
    if (accountCount > ACCOUNT_LIMIT || addressCount > ADDRESS_LIMIT) {
      await audit(db, {
        actorEmail: body.email,
        action: "auth.login",
        entityType: "session",
        outcome: "failure",
        before: { accountAttempts: accountCount, addressAttempts: addressCount },
        req
      });
      throw new HttpError(429, "too_many_attempts", "Too many login attempts. Try again in a few minutes.");
    }

    console.log('DEBUG LOGIN BODY:', JSON.stringify({ email: body.email, password: '***' }));

    const user = await one<{
      id: string;
      email: string;
      display_name: string;
      password_hash: string;
      role: "admin" | "investigator" | "analyst" | "viewer";
      agency: string | null;
      is_active: boolean;
    }>(db, `SELECT * FROM users WHERE email = $1`, [body.email.toLowerCase()]);

    const { verifyPassword } = await import("../security.js");
    const ok = user ? await verifyPassword(user.password_hash, body.password) : false;

    if (!user || !ok) {
      await audit(db, {
        actorEmail: body.email,
        action: "auth.login",
        entityType: "session",
        outcome: "failure",
        req
      });
      throw new HttpError(401, "invalid_credentials", "Email or password is incorrect");
    }
    if (!user.is_active) {
      throw new HttpError(403, "account_disabled", "This account has been deactivated");
    }

    // A real sign-in clears the account budget so a user who fumbled their
    // password is not left throttled. The address budget is deliberately left
    // to expire: clearing it on success would let an attacker reset it by
    // occasionally guessing correctly.
    await clearAttempts(db, accountKey);

    const authUser = {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      role: user.role,
      agency: user.agency
    };
    const accessToken = signAccessToken(authUser);
    const refresh = randomToken(48);
    const expiresAt = new Date(Date.now() + env.JWT_REFRESH_TTL_DAYS * 86_400_000);

    await db.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, user_agent) VALUES ($1,$2,$3,$4)`,
      [user.id, sha256(refresh), expiresAt.toISOString(), req.headers["user-agent"] ?? null]
    );
    await db.query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [user.id]);

    await audit(db, { actorId: user.id, actorEmail: user.email, action: "auth.login", entityType: "session", req });

    res.json({
      accessToken,
      refreshToken: refresh,
      expiresIn: env.JWT_EXPIRES_IN,
      user: { ...authUser, permissions: permissionsFor(user.role) }
    });
  })
);

const refreshSchema = z.object({ refreshToken: z.string().min(20).max(200) });

/**
 * Reuse of a rotated token is treated as theft, unconditionally: all of the
 * user's sessions are revoked and an `auth.refresh_reuse` entry is written.
 *
 * There is deliberately no grace window here. An earlier revision allowed a
 * short window in which a rotated token could be replayed without penalty, to
 * absorb the two-tab race. That is unsound: an attacker holding a stolen token
 * does not have to win a race, they only have to replay it inside the window
 * that follows the victim's own next rotation, and they get a durable session.
 * The cross-tab race is a client concern and is handled in
 * `web/src/lib/api.ts`, which re-reads storage before refreshing. Refresh
 * tokens stay strictly single-use, so the guarantee holds without exception.
 */
authRouter.post(
  "/refresh",
  asyncRoute(async (req: Request, res: Response) => {
    const { refreshToken } = refreshSchema.parse(req.body);
    const db = await getDb();
    const row = await one<{
      id: string;
      user_id: string;
      expires_at: string;
      revoked_at: string | null;
      revoked_reason: string | null;
      email: string;
      display_name: string;
      role: "admin" | "investigator" | "analyst" | "viewer";
      agency: string | null;
      is_active: boolean;
    }>(
      db,
      `SELECT rt.id, rt.user_id, rt.expires_at, rt.revoked_at, rt.revoked_reason,
              u.email, u.display_name, u.role, u.agency, u.is_active
       FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id
       WHERE rt.token_hash = $1`,
      [sha256(refreshToken)]
    );

    if (!row) {
      throw new HttpError(401, "invalid_refresh", "Refresh token is invalid or expired");
    }
    if (!row.is_active) {
      throw new HttpError(401, "invalid_refresh", "Refresh token is invalid or expired");
    }
    if (new Date(row.expires_at) < new Date()) {
      throw new HttpError(401, "invalid_refresh", "Refresh token is invalid or expired");
    }

    if (row.revoked_at) {
      if (row.revoked_reason === "rotated") {
        // A rotated token must never be presented twice. Assume it was
        // captured: burn every session this user has, including the attacker's
        // live one, and force a fresh login.
        await db.query(
          `UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = 'reuse_response'
           WHERE user_id = $1 AND revoked_at IS NULL`,
          [row.user_id]
        );
        await audit(db, {
          actorId: row.user_id,
          actorEmail: row.email,
          action: "auth.refresh_reuse",
          entityType: "session",
          outcome: "failure",
          before: { revokedReason: row.revoked_reason, revokedAt: row.revoked_at },
          req
        });
        logger.warn("Refresh token reuse detected; all sessions revoked", { user: row.email });
        throw new HttpError(
          401,
          "refresh_token_reuse",
          "This session was invalidated for security reasons. Sign in again."
        );
      }

      // Revoked by logout, password change or deactivation. A tab still holding
      // this token is stale, not evidence of anything — just reject.
      throw new HttpError(401, "invalid_refresh", "Refresh token is invalid or expired");
    }

    // Rotate: the presented token is revoked as the new one is issued.
    const next = randomToken(48);
    const expiresAt = new Date(Date.now() + env.JWT_REFRESH_TTL_DAYS * 86_400_000);
    await db.query(`UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = 'rotated' WHERE id = $1`, [row.id]);
    await db.query(`INSERT INTO refresh_tokens (user_id, token_hash, expires_at, user_agent) VALUES ($1,$2,$3,$4)`, [
      row.user_id,
      sha256(next),
      expiresAt.toISOString(),
      req.headers["user-agent"] ?? null
    ]);

    const authUser = {
      id: row.user_id,
      email: row.email,
      displayName: row.display_name,
      role: row.role,
      agency: row.agency
    };
    await audit(db, { actorId: row.user_id, actorEmail: row.email, action: "auth.refresh", entityType: "session", req });

    res.json({
      accessToken: signAccessToken(authUser),
      refreshToken: next,
      expiresIn: env.JWT_EXPIRES_IN,
      user: { ...authUser, permissions: permissionsFor(row.role) }
    });
  })
);

authRouter.post(
  "/logout",
  requireAuth,
  asyncRoute(async (req: Request, res: Response) => {
    const { refreshToken } = z.object({ refreshToken: z.string().optional() }).parse(req.body ?? {});
    const db = await getDb();
    if (refreshToken) {
      await db.query(`UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = 'logout' WHERE token_hash = $1`, [
        sha256(refreshToken)
      ]);
    }
    await db.query(
      `UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = 'logout' WHERE user_id = $1 AND revoked_at IS NULL`,
      [req.user!.id]
    );
    await audit(db, {
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      action: "auth.logout",
      entityType: "session",
      req
    });
    res.status(204).end();
  })
);

authRouter.get(
  "/me",
  requireAuth,
  asyncRoute(async (req: Request, res: Response) => {
    const db = await getDb();
    const user = await one<{
      id: string;
      email: string;
      display_name: string;
      role: "admin" | "investigator" | "analyst" | "viewer";
      agency: string | null;
      last_login_at: string | null;
      created_at: string;
    }>(db, `SELECT id, email, display_name, role, agency, last_login_at, created_at FROM users WHERE id = $1`, [req.user!.id]);

    if (!user) throw new HttpError(401, "unauthorized", "User no longer exists");

    res.json({
      user: {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        role: user.role,
        agency: user.agency,
        lastLoginAt: user.last_login_at,
        createdAt: user.created_at,
        permissions: permissionsFor(user.role)
      }
    });
  })
);

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z
    .string()
    .min(12, "Password must be at least 12 characters")
    .max(200)
    .refine((v) => /[a-z]/.test(v) && /[A-Z]/.test(v) && /[0-9]/.test(v), "Include upper, lower and numeric characters"),
  revokeOtherSessions: z.boolean().default(true)
});

authRouter.post(
  "/change-password",
  requireAuth,
  asyncRoute(async (req: Request, res: Response) => {
    const body = changePasswordSchema.parse(req.body);
    const db = await getDb();
    const row = await one<{ password_hash: string }>(db, `SELECT password_hash FROM users WHERE id = $1`, [req.user!.id]);
    if (!row) throw new HttpError(404, "not_found", "User not found");

    const { verifyPassword } = await import("../security.js");
    if (!(await verifyPassword(row.password_hash, body.currentPassword))) {
      await audit(db, {
        actorId: req.user!.id,
        actorEmail: req.user!.email,
        action: "auth.change_password",
        entityType: "user",
        entityId: req.user!.id,
        outcome: "failure",
        req
      });
      throw new HttpError(401, "invalid_credentials", "Current password is incorrect");
    }

    const hash = await hashPassword(body.newPassword);
    await db.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [req.user!.id, hash]);

    if (body.revokeOtherSessions) {
      await db.query(
        `UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = 'password_change'
         WHERE user_id = $1 AND revoked_at IS NULL`,
        [req.user!.id]
      );
    }

    await audit(db, {
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      action: "auth.change_password",
      entityType: "user",
      entityId: req.user!.id,
      req
    });
    logger.info("Password changed", { user: req.user!.email });
    res.json({ ok: true });
  })
);
