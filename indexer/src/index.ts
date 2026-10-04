import { indexBitcoin } from "./chains/bitcoin.js";
import { indexEthereum, indexPolygon } from "./chains/ethereum.js";
import { indexTron } from "./chains/tron.js";
import { closeDb, getDb } from "./db.js";
import { logger } from "./logger.js";
import { env } from "./config.js";
import type { Chain } from "./types.js";

/**
 * One indexing pass for `chain`, dispatching to that chain's driver.
 *
 * @param chain - Chain to advance by up to `INDEX_BATCH_SIZE` blocks.
 */
async function indexOnce(chain: Chain): Promise<void> {
  switch (chain) {
    case "bitcoin":
      await indexBitcoin();
      return;
    case "ethereum":
      await indexEthereum();
      return;
    case "polygon":
      await indexPolygon();
      return;
    case "tron":
      await indexTron();
      return;
  }
}

/** Chains this process is responsible for, from a comma-separated `INDEX_CHAINS`. */
function targetChains(): Chain[] {
  const requested = (process.env.INDEX_CHAINS ?? process.env.INDEX_CHAIN ?? "bitcoin")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry): entry is Chain =>
      entry === "bitcoin" || entry === "ethereum" || entry === "polygon" || entry === "tron"
    );

  if (requested.length === 0) {
    logger.warn("No supported chain in INDEX_CHAINS, defaulting to bitcoin");
    return ["bitcoin"];
  }
  return requested;
}

async function main(): Promise<void> {
  const chains = targetChains();

  logger.info("Starting CryptoTrace Indexer", {
    chains,
    env: env.NODE_ENV,
    intervalMs: env.INDEX_POLL_INTERVAL_MS
  });

  const db = await getDb();
  logger.info("Database ready", { driver: db.driver });

  // Runs until signalled. A one-shot pass would leave the index permanently one
  // batch behind, which is why `INDEX_POLL_INTERVAL_MS` exists at all.
  let stopping = false;
  const stop = (signal: string) => {
    logger.info(`${signal} received, finishing current batch`);
    stopping = true;
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  while (!stopping) {
    for (const chain of chains) {
      // A driver failure is already logged and recorded as caught-up-lag; it must
      // not stop the other chains or the loop itself.
      await indexOnce(chain).catch((err: unknown) => {
        logger.error(`${chain} indexing pass failed`, {
          error: err instanceof Error ? err.message : String(err)
        });
      });
    }

    if (stopping) break;
    await new Promise((resolve) => setTimeout(resolve, env.INDEX_POLL_INTERVAL_MS));
  }

  closeDb();
  logger.info("Indexer stopped");
}

main().catch((err) => {
  logger.error("Indexer failed", { error: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});