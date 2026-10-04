import { env } from "../config.js";
import {
  ChainUnavailableError,
  HttpClient,
  NonRetryableError,
  toNumber,
  type ChainAdapter,
  type NormalizedAddress,
  type NormalizedTransaction
} from "./base.js";
import type { Chain } from "../types.js";

const http = new HttpClient({ minIntervalMs: 200, timeoutMs: 20000, retries: 2 });

/**
 * One transaction as these intelligence feeds report it.
 *
 * `counterparty` is the only address besides the subject, so when the feed omits
 * `direction` there is no way to tell an inbound transfer from an outbound one.
 */
interface IntelligenceTx {
  tx_hash: string;
  timestamp: string;
  value: string;
  counterparty: string;
  /** Present on Sahyog; absent on NCRP, which lists no transactions at all. */
  direction?: "in" | "out";
}

interface SahyogEntity {
  address: string;
  chain: string;
  entity_type: string;
  name: string;
  risk_score: number;
  risk_level: string;
  labels: string[];
  source: string;
  source_url?: string;
  confidence: number;
  last_updated: string;
  metadata?: Record<string, unknown>;
  transactions?: IntelligenceTx[];
}

interface SahyogAddressResponse {
  entity: SahyogEntity | null;
  related_addresses: Array<{ address: string; relationship: string; risk_score: number }>;
  transactions: IntelligenceTx[];
}

interface NcrpEntity {
  address: string;
  blockchain: string;
  category: string;
  entity_name: string;
  risk_rating: number;
  risk_category: string;
  tags: string[];
  reporting_agency: string;
  case_reference?: string;
  reported_at: string;
  details?: Record<string, unknown>;
}

interface NcrpResponse {
  entities: NcrpEntity[];
  total_count: number;
}

type IntelligenceEntity = SahyogEntity | NcrpEntity;

function isSahyogEntity(entity: IntelligenceEntity): entity is SahyogEntity {
  return "labels" in entity && "chain" in entity;
}

function isNcrpEntity(entity: IntelligenceEntity): entity is NcrpEntity {
  return "tags" in entity && "blockchain" in entity;
}

export class IntelligenceAdapter implements ChainAdapter {
  readonly chain: Chain = "unknown";
  private baseUrl: string;
  private apiKey: string;
  private sourceName: string;

  constructor(baseUrl: string, apiKey: string, sourceName: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
    this.sourceName = sourceName;
  }

  async getTransaction(_txHash: string): Promise<NormalizedTransaction> {
    throw new ChainUnavailableError(this.chain, `${this.sourceName} does not support transaction lookup`);
  }

  async getAddress(address: string): Promise<NormalizedAddress> {
    const entity = await this.fetchEntity(address);
    if (!entity) {
      throw new ChainUnavailableError(this.chain, `No intelligence data for ${address} from ${this.sourceName}`);
    }

    // Declared without initialisers: every branch below either assigns these or
    // throws, so a default here would be unreachable and would read as a real
    // zero-valued rating.
    let labels: string[];
    let riskScore: number;
    let chainStr: string;
    let entityType: string;
    let name: string;
    let lastSeen: string | null;
    let sourceUrl: string | undefined;
    let confidence: number | undefined;
    let metadata: Record<string, unknown> | undefined;
    // Kept at 0 rather than left unassigned: only the Sahyog shape carries an
    // embedded transaction list. NCRP listings genuinely have none, so 0 is the
    // accurate count there. The risk is a reader taking it as "verified to have
    // no transactions", which is why `raw.source` stays on the record.
    let txCount = 0;
    let reportingAgency: string | undefined;
    let caseReference: string | undefined;

    if (isSahyogEntity(entity)) {
      labels = entity.labels;
      riskScore = toNumber(entity.risk_score);
      chainStr = entity.chain;
      entityType = entity.entity_type;
      name = entity.name;
      lastSeen = entity.last_updated;
      sourceUrl = entity.source_url;
      confidence = entity.confidence;
      metadata = entity.metadata;
      // The embedded list is the only transaction count this source offers; a
      // hard-coded 0 rendered a known-busy address as "0 transactions".
      txCount = entity.transactions?.length ?? 0;
    } else if (isNcrpEntity(entity)) {
      labels = entity.tags;
      riskScore = toNumber(entity.risk_rating);
      chainStr = entity.blockchain;
      entityType = entity.category;
      name = entity.entity_name;
      lastSeen = entity.reported_at;
      metadata = entity.details;
      // Without these the NCRP source was indistinguishable from Sahyog in the
      // UI: a regulator listing lost its agency and case reference.
      reportingAgency = entity.reporting_agency;
      caseReference = entity.case_reference;
    } else {
      // Neither shape matched. Returning the zero-filled default here would
      // present an unparseable response as a real address rated "Unrated",
      // which reads as a finding rather than a defect.
      throw new ChainUnavailableError(
        this.chain,
        `${this.sourceName} returned an unrecognized entity shape for ${address}`
      );
    }

    const riskLevel = this.scoreToLevel(riskScore);

    return {
      chain: this.mapChain(chainStr),
      address: entity.address,
      firstSeen: lastSeen,
      lastSeen,
      txCount,
      receivedTotal: 0,
      sentTotal: 0,
      balance: null,
      raw: {
        source: this.sourceName,
        entityType,
        name,
        riskScore,
        riskLevel,
        labels,
        sourceUrl,
        confidence,
        reportingAgency,
        caseReference,
        metadata
      }
    };
  }

  async getTransactionsForAddress(
    address: string,
    opts: { limit?: number; cursor?: string } = {}
  ): Promise<{ transactions: NormalizedTransaction[]; cursor: string | null }> {
    const entityResult = await this.fetchEntity(address);
    if (!entityResult) return { transactions: [], cursor: null };
    const entity = entityResult;

    let txs: IntelligenceTx[] = [];
    let chainStr = "unknown";

    if (isSahyogEntity(entity)) {
      const sahyogEntity: SahyogEntity = entity;
      txs = sahyogEntity.transactions ?? [];
      chainStr = sahyogEntity.chain;
    } else if (isNcrpEntity(entity)) {
      const ncrpEntity: NcrpEntity = entity;
      chainStr = ncrpEntity.blockchain;
    }

    const limit = Math.min(opts.limit ?? 25, 50);
    // Resume *after* the cursor. Previously the cursor was returned but never
    // read, so every page request returned page one and any caller paginating
    // to the end looped forever on the same 25 rows.
    // Resume *at* the cursor, not after it: the cursor is the hash of the first
    // transaction of the next page, so skipping past it drops one row per page.
    const cursorAt = opts.cursor ? txs.findIndex((t) => t.tx_hash === opts.cursor) : -1;
    const start = cursorAt >= 0 ? cursorAt : 0;
    const page = txs.slice(start, start + limit);
    const nextIndex = start + page.length;

    const transactions: NormalizedTransaction[] = page.map((tx) => {
      // Prefer the feed's own direction. Falling back to "always inbound" is
      // what the previous version did unconditionally, which reversed every
      // outbound transfer and pointed tracer edges the wrong way.
      const outbound = tx.direction === "out";
      const from = outbound ? address : tx.counterparty;
      const to = outbound ? tx.counterparty : address;

      return {
      chain: this.mapChain(chainStr),
      txHash: tx.tx_hash,
      blockHeight: null,
      timestamp: tx.timestamp,
      from,
      to,
      valueNative: tx.value,
      valueUsd: null,
      status: "confirmed",
      feeNative: null,
      transfers: [
        {
          kind: "native",
          asset: this.getNativeAsset(chainStr),
          from,
          to,
          amount: tx.value,
          decimals: this.getDecimals(chainStr),
          contract: null,
          logIndex: null
        }
      ],
      raw: {
        source: this.sourceName,
        directionAssumed: tx.direction === undefined,
        ...tx
      }
    };
    });

    return { transactions, cursor: nextIndex < txs.length ? txs[nextIndex]?.tx_hash ?? null : null };
  }

  async health(): Promise<{ ok: boolean; latencyMs: number; detail: string }> {
    const started = Date.now();
    try {
      await http.getJson<{ status: string }>(`${this.baseUrl}/health`, {
        authorization: `Bearer ${this.apiKey}`
      });
      return { ok: true, latencyMs: Date.now() - started, detail: `${this.sourceName} reachable` };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - started, detail: err instanceof Error ? err.message : "unreachable" };
    }
  }

  private async fetchEntity(address: string): Promise<IntelligenceEntity | null> {
    try {
      // `address` reaches here from tracing inputs, so it is untrusted. Without
      // encoding a crafted value could add path segments or a query string and
      // redirect the request to a different endpoint on the same host.
      const key = encodeURIComponent(address);
      if (this.sourceName === "Sahyog") {
        const res = await http.getJson<SahyogAddressResponse>(`${this.baseUrl}/v1/entities/${key}`, {
          authorization: `Bearer ${this.apiKey}`
        });
        return res.entity ?? null;
      } else {
        const res = await http.getJson<NcrpResponse>(`${this.baseUrl}/v1/addresses/${key}`, {
          authorization: `Bearer ${this.apiKey}`
        });
        return res.entities[0] ?? null;
      }
    } catch (err) {
      if (err instanceof ChainUnavailableError) throw err;
      // A 404 means this source simply holds nothing for that address, which is
      // a normal answer. Reporting it as ChainUnavailableError would make the
      // Integrations panel show the feed as down and push callers into retrying
      // a lookup that can never succeed.
      if (err instanceof NonRetryableError && err.status === 404) return null;
      throw new ChainUnavailableError(this.chain, `${this.sourceName} request failed for ${address}`, err);
    }
  }

  private mapChain(chain: string): Chain {
    const normalized = chain.toLowerCase();
    if (["bitcoin", "btc"].includes(normalized)) return "bitcoin";
    if (["ethereum", "eth", "evm"].includes(normalized)) return "ethereum";
    if (["polygon", "matic"].includes(normalized)) return "polygon";
    if (["tron", "trx"].includes(normalized)) return "tron";
    return "unknown";
  }

  private getNativeAsset(chain: string): string {
    const normalized = chain.toLowerCase();
    if (["bitcoin", "btc"].includes(normalized)) return "BTC";
    if (["ethereum", "eth"].includes(normalized)) return "ETH";
    if (["polygon", "matic"].includes(normalized)) return "MATIC";
    if (["tron", "trx"].includes(normalized)) return "TRX";
    return "UNKNOWN";
  }

  private getDecimals(chain: string): number {
    const normalized = chain.toLowerCase();
    if (["bitcoin", "btc"].includes(normalized)) return 8;
    if (["ethereum", "eth", "polygon", "matic"].includes(normalized)) return 18;
    if (["tron", "trx"].includes(normalized)) return 6;
    return 18;
  }

  private scoreToLevel(score: number): string {
    if (score >= 80) return "Critical";
    if (score >= 60) return "High";
    if (score >= 40) return "Medium";
    if (score >= 20) return "Low";
    return "Unrated";
  }
}

export function createSahyogAdapter(): IntelligenceAdapter {
  return new IntelligenceAdapter(env.SAHYOG_API_URL, env.SAHYOG_API_KEY, "Sahyog");
}

export function createNcrpAdapter(): IntelligenceAdapter {
  return new IntelligenceAdapter(env.NCRP_API_URL, env.NCRP_API_KEY, "NCRP");
}