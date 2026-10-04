import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "http";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { env } from "../config.js";
import { getDb } from "../db/index.js";
import { logger } from "../logger.js";
import { can } from "../security.js";
import type { UserRole } from "../types.js";
import { verifyToken } from "./auth.js";

// Extend WebSocket with isAlive property for heartbeat
interface ExtendedWebSocket extends WebSocket {
  isAlive: boolean;
}

interface WSClient {
  ws: ExtendedWebSocket;
  userId: string;
  role: string;
  caseIds: Set<string>;
  subscriptions: Set<string>;
  lastPing: number;
}

const clients = new Map<string, WSClient>();
const wss = new WebSocketServer({ noServer: true });

function generateClientId(): string {
  return `ws_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Whether this connection's user may subscribe to `caseId`'s event stream.
 *
 * Mirrors what the REST routes do — `requirePermission("case:read")` plus a
 * case-existence check — so the socket cannot become a way around the HTTP
 * permission model. Note the app's model is role-based, not per-case
 * assignment: an analyst reviewing a case they are not assigned to is
 * legitimate, so restricting this to `case_assignees` would be stricter than
 * `GET /api/cases/:id` and would break the analyst-approval workflow.
 */
async function canReadCase(role: string, caseId: string): Promise<boolean> {
  if (!can(role as UserRole, "case:read")) return false;
  try {
    const db = await getDb();
    const { rows } = await db.query(`SELECT 1 AS ok FROM cases WHERE id = $1 LIMIT 1`, [caseId]);
    return rows.length > 0;
  } catch (err) {
    // Fail closed: a database problem must not silently allow the subscription.
    logger.error("WS subscribe auth check failed", {
      caseId,
      error: err instanceof Error ? err.message : String(err)
    });
    return false;
  }
}

/** Current status of a case, or null when it cannot be read. */
async function currentCaseStatus(caseId: string): Promise<string | null> {
  try {
    const db = await getDb();
    const { rows } = await db.query<{ status: string }>(
      `SELECT status FROM cases WHERE id = $1`,
      [caseId]
    );
    return rows[0]?.status ?? null;
  } catch (err) {
    logger.error("WS initial status lookup failed", {
      caseId,
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
}

wss.on("connection", async (ws: ExtendedWebSocket, _req) => {
  const clientId = generateClientId();
  let authenticated = false;
  let userId = "";
  let role = "";

  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  const send = (type: string, payload: unknown) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type, payload, timestamp: new Date().toISOString() }));
    }
  };

  const close = (code: number, reason: string) => {
    ws.close(code, reason);
    clients.delete(clientId);
  };

  ws.on("message", async (data) => {
    try {
      const msg = JSON.parse(data.toString());

      switch (msg.type) {
        case "auth": {
          const token = msg.payload?.token;
          if (!token) return send("error", { code: "missing_token", message: "Token required" });

          try {
            const payload = verifyToken(token);
            userId = payload.sub;
            role = payload.role;
            authenticated = true;

            clients.set(clientId, {
              ws,
              userId,
              role,
              caseIds: new Set(),
              subscriptions: new Set(["global", `user:${userId}`]),
              lastPing: Date.now()
            });

            send("auth_ok", { userId, role, clientId });
            logger.debug("WS auth ok", { clientId, userId, role });
          } catch (err) {
            send("error", { code: "invalid_token", message: "Invalid or expired token" });
            close(4001, "Invalid token");
          }
          break;
        }

        case "subscribe": {
          if (!authenticated) return send("error", { code: "unauthorized", message: "Auth required" });
          const client = clients.get(clientId);
          if (!client) return;

          const { caseId, event } = msg.payload ?? {};
          if (caseId) {
            // The upgrade is authenticated but the subscribe is a second,
            // attacker-chosen key. Without this check any logged-in user could
            // name an arbitrary caseId and receive its event stream, which the
            // SSE route prevented via requirePermission("case:read").
            const allowed = await canReadCase(role, caseId);
            if (!allowed) {
              send("error", { code: "forbidden", message: "Not authorized for this case" });
              break;
            }
            client.caseIds.add(caseId);
            client.subscriptions.add(`case:${caseId}`);
            send("subscribed", { caseId });

            // Send current status so a client connecting mid-investigation
            // renders the right state before the next transition happens.
            const current = await currentCaseStatus(caseId);
            send("case_event", { caseId, type: "status", status: current });
          }
          if (event) {
            client.subscriptions.add(event);
            send("subscribed", { event });
          }
          break;
        }

        case "unsubscribe": {
          if (!authenticated) return;
          const client = clients.get(clientId);
          if (!client) return;

          const { caseId, event } = msg.payload ?? {};
          if (caseId) {
            client.caseIds.delete(caseId);
            client.subscriptions.delete(`case:${caseId}`);
            send("unsubscribed", { caseId });
          }
          if (event) {
            client.subscriptions.delete(event);
            send("unsubscribed", { event });
          }
          break;
        }

        case "ping": {
          ws.isAlive = true;
          const client = clients.get(clientId);
          if (client) client.lastPing = Date.now();
          send("pong", { ts: Date.now() });
          break;
        }

        case "trace_progress": {
          logger.debug("trace progress received", { msg: msg.payload });
          send("ack", { type: "trace_progress", hop: msg.payload?.hop });
          break;
        }

        case "trace_complete": {
          logger.debug("trace complete received", { msg: msg.payload });
          send("ack", { type: "trace_complete" });
          break;
        }

        default:
          send("error", { code: "unknown_type", message: `Unknown message type: ${msg.type}` });
      }
    } catch (err) {
      logger.warn("WS message parse error", { clientId, error: err instanceof Error ? err.message : String(err) });
      send("error", { code: "parse_error", message: "Invalid JSON" });
    }
  });

  ws.on("close", () => {
    clients.delete(clientId);
    logger.debug("WS client disconnected", { clientId, userId });
  });

  ws.on("error", (err) => {
    logger.warn("WS error", { clientId, error: err.message });
  });
});

// Heartbeat
setInterval(() => {
  for (const [id, client] of clients) {
    if (!client.ws.isAlive) {
      client.ws.terminate();
      clients.delete(id);
      continue;
    }
    client.ws.isAlive = false;
    client.ws.ping();
  }
}, 30000);

// Broadcast helpers
export function broadcastCaseEvent(caseId: string, event: string, payload: unknown) {
  const payloadObj = payload as Record<string, unknown>;
  const message = JSON.stringify({ type: "case_event", payload: { caseId, event, ...payloadObj }, timestamp: new Date().toISOString() });
  for (const client of clients.values()) {
    if (client.subscriptions.has(`case:${caseId}`) || client.subscriptions.has("global")) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(message);
      }
    }
  }
}

export function broadcastGlobal(event: string, payload: unknown) {
  const message = JSON.stringify({ type: event, payload, timestamp: new Date().toISOString() });
  for (const client of clients.values()) {
    if (client.subscriptions.has("global") && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(message);
    }
  }
}

export function broadcastToUser(userId: string, event: string, payload: unknown) {
  const message = JSON.stringify({ type: event, payload, timestamp: new Date().toISOString() });
  for (const client of clients.values()) {
    if (client.userId === userId && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(message);
    }
  }
}

export function getConnectedClients(): number {
  return clients.size;
}

export function getClientInfo(): Array<{ userId: string; role: string; caseCount: number }> {
  return Array.from(clients.values()).map(c => ({
    userId: c.userId,
    role: c.role,
    caseCount: c.caseIds.size
  }));
}

// HTTP upgrade handler
export function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
}

// Start WebSocket server
export function startWSServer(port: number = env.wsPort): Promise<void> {
  const server = createServer();
  server.on("upgrade", handleUpgrade);
  return new Promise((resolve) => {
    server.listen(port, () => {
      logger.info(`WebSocket server listening on port ${port}`);
      resolve();
    });
  });
}