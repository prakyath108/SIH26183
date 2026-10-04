import { jobQueue } from "./jobQueue.js";
import { autoProcessHandler } from "./autoProcessHandler.js";
import { traceJobHandler } from "./traceJobHandler.js";
import { logger } from "../logger.js";
import { env } from "../config.js";

let workerStarted = false;

export async function startWorker(): Promise<void> {
  if (workerStarted) {
    logger.warn("Worker already started");
    return;
  }

  jobQueue.register(autoProcessHandler);
  jobQueue.register(traceJobHandler);

  await jobQueue.start();
  workerStarted = true;
  logger.info("Background worker started", { handlers: ["auto_process", "trace_job"] });
}

export async function stopWorker(): Promise<void> {
  if (!workerStarted) return;
  await jobQueue.stop();
  workerStarted = false;
  logger.info("Background worker stopped");
}

export function isWorkerRunning(): boolean {
  return workerStarted;
}

if (env.NODE_ENV !== "test" && process.argv[1]?.includes("worker")) {
  startWorker().catch((err) => {
    logger.error("Failed to start worker", err);
    process.exit(1);
  });

  process.on("SIGINT", async () => {
    await stopWorker();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    await stopWorker();
    process.exit(0);
  });
}