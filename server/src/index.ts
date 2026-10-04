import express from "express";
import cors from "cors";
import helmet from "helmet";
import { z } from "zod";
import { env } from "./config.js";
import { logger } from "./logger.js";
import { getDb } from "./db/index.js";
import { migrate } from "./db/migrate.js";
import { requestId } from "./middleware/audit.js";
import { errorHandler, notFoundHandler, asyncRoute } from "./middleware/error.js";
import { requireAuth, requirePermission } from "./middleware/auth.js";
import { authRouter } from "./routes/auth.js";
import { casesRouter } from "./routes/cases.js";
import { chainRouter } from "./routes/chain.js";
import { evidenceRouter } from "./routes/evidence.js";
import { alertsRouter } from "./routes/alerts.js";
import { vaspRouter } from "./routes/vasp.js";
import { auditRouter } from "./routes/audit.js";
import { adminRouter } from "./routes/admin.js";
import { reportsRouter } from "./routes/reports.js";
import { teamRouter } from "./routes/team.js";
import { aiRouter } from "./routes/ai.js";
import { autoJobsRouter } from "./routes/autoJobs.js";
import { statusRouter } from "./status/routes.js";
import { caseEventBus } from "./status/events.js";
import { startWorker, stopWorker } from "./worker/index.js";
import { handleUpgrade, startWSServer, broadcastCaseEvent, broadcastGlobal } from "./ws/index.js";
import { buildDashboardPdf, buildReportPdf } from "./reports/pdf.js";
import { audit } from "./middleware/audit.js";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const webDist = resolve(__dirname, "..", "..", "web", "dist");

export function createApp() {
  const app = express();

  app.set("trust proxy", true);
  app.use(
    helmet({
      // The API serves JSON only; CSP is enforced by the frontend host.
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: "same-site" }
    })
  );
  app.use(
    cors({
      origin: env.corsOrigins,
      credentials: true,
      methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization", "X-Request-Id"],
      exposedHeaders: ["X-Request-Id", "Content-Disposition"]
    })
  );
  app.use(express.json({ limit: "4mb" }));
  app.use(requestId);

  app.get(
    "/api/health",
    asyncRoute(async (_req, res) => {
      const db = await getDb();
      let dbOk = true;
      try {
        await db.query("SELECT 1");
      } catch (err) {
        dbOk = false;
        logger.error("Health check database probe failed", err);
      }
      res.status(dbOk ? 200 : 503).json({
        status: dbOk ? "ok" : "degraded",
        driver: db.driver,
        uptimeSeconds: Math.round(process.uptime()),
        environment: env.NODE_ENV,
        version: "0.1.0"
      });
    })
  );

  app.use("/api/auth", authRouter);
  app.use("/api/cases", casesRouter);
  // Case events now arrive over the WebSocket in /ws (see ws/index.ts), so no
  // SSE route is mounted here.
  app.use("/api/chain", chainRouter);
  app.use("/api/evidence", evidenceRouter);
  app.use("/api/alerts", alertsRouter);
  app.use("/api/vasp", vaspRouter);
  app.use("/api/audit", auditRouter);
  app.use("/api/admin", adminRouter);
  app.use("/api/reports", reportsRouter);
  app.use("/api/team", teamRouter);
  app.use("/api/status", statusRouter);
  app.use("/api/ai", aiRouter);
  app.use("/api/ai", autoJobsRouter);

  // Report export (PDF) and the JSON report it renders from.
  app.get(
    "/api/reports/cases/:id/export.pdf",
    requireAuth,
    asyncRoute(async (req, res) => {
      const id = z.string().min(1).max(80).parse(req.params.id);
      const db = await getDb();
      const pdf = await buildReportPdf(db, id, req.user!);
      if (!pdf) {
        res.status(404).json({ error: "not_found", message: "Case not found" });
        return;
      }
      // An export moves case material outside the system, so it is recorded as a
      // disclosure event in its own right rather than treated as a plain read.
      await audit(db, {
        actorId: req.user!.id,
        actorEmail: req.user!.email,
        action: "report.export",
        entityType: "case",
        entityId: id,
        caseRef: pdf.meta.caseRef,
        after: { format: "pdf", bytes: pdf.buffer.length },
        req
      });
      const caseRef = pdf.meta.caseRef;
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${caseRef}-report.pdf"`);
      res.send(pdf.buffer);
    })
  );

  /** Portfolio summary — the dashboard rendered as a document. */
  app.get(
    "/api/reports/dashboard/export.pdf",
    requireAuth,
    requirePermission("evidence:export"),
    asyncRoute(async (req, res) => {
      const days = z.coerce.number().int().min(7).max(180).default(30).parse(req.query.days ?? 30);
      const db = await getDb();
      const pdf = await buildDashboardPdf(db, days, req.user!);
      await audit(db, {
        actorId: req.user!.id,
        actorEmail: req.user!.email,
        action: "report.export",
        entityType: "portfolio",
        after: { format: "pdf", windowDays: days, bytes: pdf.buffer.length },
        req
      });
      const stamp = new Date().toISOString().slice(0, 10);
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="cryptotrace-portfolio-${days}d-${stamp}.pdf"`);
      res.send(pdf.buffer);
    })
  );

  // Serve built frontend in production
  if (env.isProd) {
    app.use(express.static(webDist, { index: false }));
    app.get("*", (req, res, next) => {
      if (req.path.startsWith("/api/")) return next();
      res.sendFile(join(webDist, "index.html"), (err) => {
        if (err) next(err);
      });
    });
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

async function main(): Promise<void> {
  const db = await getDb();
  await migrate();
  logger.info("Database ready", { driver: db.driver });

  // Before the worker: a trace job can complete immediately on startup, and its
  // status event has to have somewhere to land.
  await caseEventBus.initialize();

  // Wire case events to WebSocket broadcasts
  caseEventBus.on("event", (outcome) => {
    if (outcome.caseId) {
      broadcastCaseEvent(outcome.caseId, "event", outcome);
    }
    broadcastGlobal("case_event", outcome);
  });
  caseEventBus.on("status-changed", (outcome) => {
    if (outcome.caseId) {
      broadcastCaseEvent(outcome.caseId, "status-changed", outcome);
    }
    broadcastGlobal("case_status_changed", outcome);
  });

  await startWorker();

  const app = createApp();
  const server = app.listen({ port: env.PORT, host: env.HOST }, () => {
    const scope = env.HOST === "0.0.0.0" || env.HOST === "::" ? "all interfaces" : env.HOST;
    logger.info(`CryptoTrace API listening on http://${env.HOST}:${env.PORT}`, { scope });
    logger.info(`CORS origin: ${env.corsOrigins.join(", ")}`);
  });

  server.on("error", (err: Error & { code?: string }) => {
    logger.error("HTTP server error", { error: err.message, code: err.code });
  });

  // Attach WebSocket upgrade handler
  server.on("upgrade", handleUpgrade);

  // Start WebSocket server on separate port
  await startWSServer(env.wsPort);

  const shutdown = (signal: string) => {
    logger.info(`${signal} received, shutting down`);
    server.close(async () => {
      await stopWorker();
      await db.close();
      logger.info("Shutdown complete");
      process.exit(0);
    });
    setTimeout(() => {
      logger.error("Forced shutdown after 10s timeout");
      process.exit(1);
    }, 10_000).unref();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("unhandledRejection", (reason) => logger.error("Unhandled promise rejection", reason));
  process.on("uncaughtException", (err) => {
    logger.error("Uncaught exception", err);
    process.exit(1);
  });
}

const invokedDirectly = process.argv[1]?.includes("index") || process.argv[1]?.includes("tsx");
if (invokedDirectly) {
  void main();
}
