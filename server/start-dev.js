import express from "express";
import cors from "cors";
import helmet from "helmet";
import { z } from "zod";
import { env } from "./config.js";
import { logger } from "./logger.js";
import { createApp } from "./index.js";

const app = createApp();
const PORT = env.PORT || 8080;
const HOST = env.HOST || "127.0.0.1";

app.listen({ port: PORT, host: HOST }, () => {
  logger.info(`CryptoTrace API listening on http://${HOST}:${PORT}`, { scope: "127.0.0.1" });
});

app.on("error", (err) => {
  logger.error("HTTP server error", { error: err.message, code: err.code });
});