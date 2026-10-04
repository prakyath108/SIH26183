import { BitcoinAdapter } from "./bitcoin.js";
import { EthereumAdapter } from "./ethereum.js";
import { TronAdapter } from "./tron.js";
import { createSahyogAdapter, createNcrpAdapter } from "./sahyog.js";
import { detect, isValidAddress, isValidTxHash, CHAIN_META } from "./detect.js";
import { ChainUnavailableError, type ChainAdapter } from "./base.js";
import { logger } from "../logger.js";
import { CHAINS, type Chain } from "../types.js";
import { env } from "../config.js";

/**
 * Provider configuration for a chain adapter.
 */
export interface ProviderConfig {
  name: string;
  priority: number; // Lower = higher priority
  adapter: ChainAdapter;
  weight: number; // For weighted selection
  enabled: boolean;
}

/**
 * Chain provider registry with fallback support.
 */
class ChainProviderRegistry {
  private providers: Map<Chain, ProviderConfig[]> = new Map();
  private conflictCache: Map<string, { data: unknown; provider: string; timestamp: number }> = new Map();
  private readonly CONFLICT_TTL_MS = 5 * 60 * 1000; // 5 minutes
  
  constructor() {
    this.initializeDefaultProviders();
  }
  
  private initializeDefaultProviders(): void {
    // Bitcoin providers
    this.registerProvider("bitcoin", {
      name: "mempool.space",
      priority: 1,
      adapter: new BitcoinAdapter(),
      weight: 100,
      enabled: true
    });
    
    // Ethereum providers
    this.registerProvider("ethereum", {
      name: "cloudflare-rpc",
      priority: 1,
      adapter: new EthereumAdapter("ethereum"),
      weight: 70,
      enabled: true
    });
    this.registerProvider("ethereum", {
      name: "alchemy",
      priority: 2,
      adapter: new EthereumAdapter("ethereum"),
      weight: 30,
      enabled: env.hasEtherscanKey
    });
    
    // Polygon providers
    this.registerProvider("polygon", {
      name: "cloudflare-rpc",
      priority: 1,
      adapter: new EthereumAdapter("polygon"),
      weight: 70,
      enabled: true
    });
    this.registerProvider("polygon", {
      name: "alchemy",
      priority: 2,
      adapter: new EthereumAdapter("polygon"),
      weight: 30,
      enabled: env.hasEtherscanKey
    });
    
    // Tron providers
    this.registerProvider("tron", {
      name: "trongrid",
      priority: 1,
      adapter: new TronAdapter(),
      weight: 100,
      enabled: env.hasTrongridKey
    });

    // Intelligence providers (Sahyog/NCRP) - registered as cross-chain "intelligence" kind
    if (env.hasSahyogKey) {
      this.registerProvider("bitcoin", {
        name: "sahyog",
        priority: 10,
        adapter: createSahyogAdapter(),
        weight: 50,
        enabled: true
      });
      this.registerProvider("ethereum", {
        name: "sahyog",
        priority: 10,
        adapter: createSahyogAdapter(),
        weight: 50,
        enabled: true
      });
      this.registerProvider("polygon", {
        name: "sahyog",
        priority: 10,
        adapter: createSahyogAdapter(),
        weight: 50,
        enabled: true
      });
      this.registerProvider("tron", {
        name: "sahyog",
        priority: 10,
        adapter: createSahyogAdapter(),
        weight: 50,
        enabled: true
      });
    }

    if (env.hasNcrpKey) {
      this.registerProvider("bitcoin", {
        name: "ncrp",
        priority: 10,
        adapter: createNcrpAdapter(),
        weight: 50,
        enabled: true
      });
      this.registerProvider("ethereum", {
        name: "ncrp",
        priority: 10,
        adapter: createNcrpAdapter(),
        weight: 50,
        enabled: true
      });
      this.registerProvider("polygon", {
        name: "ncrp",
        priority: 10,
        adapter: createNcrpAdapter(),
        weight: 50,
        enabled: true
      });
      this.registerProvider("tron", {
        name: "ncrp",
        priority: 10,
        adapter: createNcrpAdapter(),
        weight: 50,
        enabled: true
      });
    }
  }
  
  registerProvider(chain: Chain, config: ProviderConfig): void {
    const existing = this.providers.get(chain) ?? [];
    existing.push(config);
    // Sort by priority (lower = higher priority)
    existing.sort((a, b) => a.priority - b.priority);
    this.providers.set(chain, existing);
    logger.info("Registered provider", { chain, provider: config.name, priority: config.priority });
  }
  
  getProviders(chain: Chain): ProviderConfig[] {
    return this.providers.get(chain) ?? [];
  }
  
  getEnabledProviders(chain: Chain): ProviderConfig[] {
    return this.getProviders(chain).filter(p => p.enabled);
  }
  
  getPrimaryProvider(chain: Chain): ProviderConfig | null {
    const enabled = this.getEnabledProviders(chain);
    return enabled[0] ?? null;
  }
  
  /**
   * Execute a function with fallback across providers.
   * Tries providers in priority order until one succeeds.
   */
  async executeWithFallback<T>(
    chain: Chain,
    fn: (adapter: ChainAdapter, provider: ProviderConfig) => Promise<T>,
    context: { operation: string; identifier?: string } = { operation: "unknown" }
  ): Promise<{ result: T; provider: string; attempts: number }> {
    const providers = this.getEnabledProviders(chain);
    
    if (providers.length === 0) {
      throw new ChainUnavailableError(chain, `No enabled providers for chain ${chain}`);
    }
    
    let lastError: Error | null = null;
    let attempts = 0;
    
    for (const provider of providers) {
      attempts++;
      try {
        logger.debug("Trying provider", { chain, provider: provider.name, operation: context.operation, attempt: attempts });
        const result = await fn(provider.adapter, provider);
        logger.debug("Provider succeeded", { chain, provider: provider.name, operation: context.operation });
        return { result, provider: provider.name, attempts };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        logger.warn("Provider failed, trying next", { 
          chain, 
          provider: provider.name, 
          operation: context.operation, 
          error: lastError.message,
          attempt: attempts
        });
        
        // Cache the failure to avoid retrying immediately
        this.cacheFailure(chain, context.operation, provider.name, lastError);
      }
    }
    
    throw new ChainUnavailableError(
      chain,
      `All providers failed for ${context.operation}${context.identifier ? ` (${context.identifier})` : ""}: ${lastError?.message ?? "unknown error"}`,
      lastError ?? undefined
    );
  }
  
  /**
   * Execute with all providers and compare results for conflict detection.
   */
  async executeWithConsensus<T>(
    chain: Chain,
    fn: (adapter: ChainAdapter, provider: ProviderConfig) => Promise<T>,
    context: { operation: string; identifier?: string } = { operation: "unknown" },
    consensusThreshold: number = 0.66 // 66% agreement required
  ): Promise<{ result: T; provider: string; consensus: boolean; responses: Array<{ provider: string; result: T | Error }> }> {
    const providers = this.getEnabledProviders(chain);
    
    if (providers.length === 0) {
      throw new ChainUnavailableError(chain, `No enabled providers for chain ${chain}`);
    }
    
    const responses: Array<{ provider: string; result: T | Error }> = [];
    const successful: Array<{ provider: string; result: T }> = [];
    
    // Execute in parallel for speed
    const promises = providers.map(async (provider) => {
      try {
        const result = await fn(provider.adapter, provider);
        responses.push({ provider: provider.name, result });
        successful.push({ provider: provider.name, result });
      } catch (err) {
        responses.push({ provider: provider.name, result: err instanceof Error ? err : new Error(String(err)) });
      }
    });
    
    await Promise.all(promises);
    
    if (successful.length === 0) {
      throw new ChainUnavailableError(
        chain,
        `All providers failed for ${context.operation}: ${responses.map(r => `${r.provider}: ${r.result instanceof Error ? r.result.message : "unknown"}`).join("; ")}`
      );
    }
    
    // Check for consensus by comparing results
    const consensusResult = this.checkConsensus(successful.map(s => s.result), consensusThreshold);
    
    if (consensusResult.consensus) {
      return {
        result: consensusResult.result,
        provider: "consensus",
        consensus: true,
        responses
      };
    }
    
    // No consensus - return primary provider result but flag conflict
    const primary = successful.find(s => s.provider === providers[0]?.name) ?? successful[0]!;
    
    // Cache conflict for audit
    this.cacheConflict(chain, context, responses);
    
    logger.warn("Provider consensus not reached", { 
      chain, 
      operation: context.operation, 
      identifier: context.identifier,
      providers: successful.map(s => s.provider),
      responseCount: successful.length
    });
    
    return {
      result: primary.result,
      provider: primary.provider,
      consensus: false,
      responses
    };
  }
  
  /**
   * Check if results from multiple providers agree.
   */
  private checkConsensus<T>(results: T[], threshold: number): { consensus: boolean; result: T } {
    if (results.length === 0) throw new Error("No results to check consensus");
    if (results.length === 1) return { consensus: true, result: results[0]! };
    
    // Simple JSON comparison for consensus
    const serialized = results.map(r => JSON.stringify(r));
    const counts = new Map<string, number>();
    
    for (const s of serialized) {
      counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    
    const maxCount = Math.max(...counts.values());
    const agreementRatio = maxCount / results.length;
    
    if (agreementRatio >= threshold) {
      const winning = serialized.find(s => counts.get(s) === maxCount)!;
      return { consensus: true, result: JSON.parse(winning) };
    }
    
    return { consensus: false, result: results[0]! };
  }
  
  private cacheFailure(chain: Chain, operation: string, provider: string, error: Error): void {
    const key = `${chain}:${operation}:${provider}`;
    this.conflictCache.set(key, { data: error.message, provider, timestamp: Date.now() });
  }
  
  private cacheConflict(chain: Chain, context: { operation: string; identifier?: string }, responses: Array<{ provider: string; result: unknown }>): void {
    const key = `conflict:${chain}:${context.operation}:${context.identifier ?? "unknown"}`;
    this.conflictCache.set(key, { 
      data: responses.map(r => ({ provider: r.provider, result: r.result })), 
      provider: "multiple", 
      timestamp: Date.now() 
    });
  }
  
  getCachedConflict(chain: Chain, operation: string, identifier?: string): unknown | null {
    const key = `conflict:${chain}:${operation}:${identifier ?? "unknown"}`;
    const cached = this.conflictCache.get(key);
    if (!cached) return null;
    
    if (Date.now() - cached.timestamp > this.CONFLICT_TTL_MS) {
      this.conflictCache.delete(key);
      return null;
    }
    
    return cached.data;
  }
  
  clearConflictCache(): void {
    this.conflictCache.clear();
  }
}

// Singleton instance
const providerRegistry = new ChainProviderRegistry();

export function getProviderRegistry(): ChainProviderRegistry {
  return providerRegistry;
}

export async function chainHealth(): Promise<{ chain: Chain; name: string; symbol: string; ok: boolean; latencyMs: number; detail: string }[]> {
  const results = await Promise.all(
    CHAINS.map(async (chain) => {
      const meta = CHAIN_META[chain];
      try {
        const primary = providerRegistry.getPrimaryProvider(chain);
        if (!primary) {
          return { chain, name: meta.name, symbol: meta.symbol, ok: false, latencyMs: 0, detail: "No provider configured" };
        }
        const h = await primary.adapter.health();
        return { chain, name: meta.name, symbol: meta.symbol, ...h };
      } catch (err) {
        return {
          chain,
          name: meta.name,
          symbol: meta.symbol,
          ok: false,
          latencyMs: 0,
          detail: err instanceof Error ? err.message : "unreachable"
        };
      }
    })
  );
  return results;
}

export function adapterFor(chain: Chain): ChainAdapter {
  const primary = providerRegistry.getPrimaryProvider(chain);
  if (!primary) {
    throw new ChainUnavailableError(chain, `No adapter registered for chain '${chain}'`);
  }
  return primary.adapter;
}

export function supportedChains(): Chain[] {
  return CHAINS;
}

export { CHAINS, CHAIN_META };
export { detect, isValidAddress, isValidTxHash, chainName } from "./detect.js";
export { createSahyogAdapter, createNcrpAdapter, IntelligenceAdapter } from "./sahyog.js";

/** Route a raw user-supplied identifier to the right adapter call with fallback. */
export async function lookup(raw: string, chainHint?: Chain) {
  const detection = detect(raw);
  if (!detection) {
    throw new ChainUnavailableError(
      "unknown",
      "Input does not look like a supported address or transaction hash. Accepted shapes: BTC (base58/bech32), EVM (0x + 40/64 hex), TRON (T + 33)."
    );
  }

  const chain = chainHint && chainHint !== "unknown" ? chainHint : detection.chain;
  if (chainHint && detection.ambiguousChains.includes(chainHint) === false && detection.chain !== chainHint) {
    logger.debug("Identifier did not match the chain hint", { input: raw, detected: detection.chain, hint: chainHint });
  }
  if (!isValidAddress(chain, detection.normalized) && detection.type === "address") {
    throw new ChainUnavailableError(chain, `Address is not valid for ${chain}`);
  }
  if (!isValidTxHash(chain, detection.normalized) && detection.type === "tx") {
    throw new ChainUnavailableError(chain, `Transaction hash is not valid for ${chain}`);
  }

  const primary = providerRegistry.getPrimaryProvider(chain);
  if (!primary) {
    throw new ChainUnavailableError(chain, `No provider available for ${chain}`);
  }
  
  return detection.type === "tx"
    ? { detection, kind: "tx" as const, result: await primary.adapter.getTransaction(detection.normalized) }
    : { detection, kind: "address" as const, result: await primary.adapter.getAddress(detection.normalized) };
}

/** Exported for testing. */
export interface ConsensusResult<T = unknown> {
  reached: boolean;
  value: T | null;
  agreeingProviders: string[];
}

export function checkConsensus<T>(results: Array<{ provider: string; success: boolean; data?: T; error?: string; latencyMs: number }>, threshold: number): ConsensusResult<T> {
  const successful = results.filter(r => r.success);
  if (successful.length === 0) return { reached: false, value: null, agreeingProviders: [] };
  const first = successful[0]!;
  if (successful.length === 1) return { reached: true, value: first.data ?? null, agreeingProviders: [first.provider] };

  const serialized = successful.map(r => JSON.stringify(r.data));
  const counts = new Map<string, number>();
  for (const s of serialized) counts.set(s, (counts.get(s) ?? 0) + 1);

  const maxCount = Math.max(...counts.values());
  // Use total results (including failures) as denominator, matching the
  // original executeWithConsensus semantics where failures dilute consensus.
  const agreementRatio = maxCount / results.length;

  if (agreementRatio >= threshold) {
    const winning = serialized.find(s => counts.get(s) === maxCount)!;
    const agreeing = successful.filter(r => JSON.stringify(r.data) === winning).map(r => r.provider);
    return { reached: true, value: JSON.parse(winning), agreeingProviders: agreeing };
  }
  return { reached: false, value: null, agreeingProviders: [] };
}