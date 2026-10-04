// Minimal startup that creates the Express app and serves the built SPA,
// without database initialization (PGlite fails in this environment).
import express from "express";
import cors from "cors";
import helmet from "helmet";
import { z } from "zod";
import { env } from "./dist/config.js";
import { logger } from "./dist/logger.js";
import { createApp } from "./dist/index.js";

// Override env to not use PGlite and avoid WASM abort
env.DATABASE_URL = "postgresql://localhost:5432/cryptotrace";
env.usingPglite = false;

const app = createApp();
const PORT = env.PORT || 8080;
const HOST = env.HOST || "127.0.0.1";

app.listen({ port: PORT, host: HOST }, () => {
  logger.info(`CryptoTrace API listening on http://${HOST}:${PORT}`, { scope: "127.0.0.1" });
});

app.on("error", (err) => {
  logger.error("HTTP server error", { error: err.message, code: err.code });
});