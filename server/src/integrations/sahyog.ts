import { env } from "../config.js";
import { logger } from "../logger.js";
import { getDb } from "../db/index.js";

interface SahyogApiResponse {
  complaints?: SahyogComplaint[];
}

interface NcrpApiResponse {
  complaints?: NcrpComplaint[];
}

interface CaseRow {
  id: string;
  case_ref: string;
}

export interface SahyogComplaint {
  complaintId: string;
  victimName?: string;
  victimContact?: string;
  incidentDate: string;
  walletAddresses: string[];
  transactionHashes?: string[];
  fraudType: "investment_scam" | "task_fraud" | "sextortion" | "ransomware" | "phishing" | "darknet" | "other";
  description: string;
  reportedBy: string;
  jurisdiction?: string;
  attachments?: Array<{ filename: string; url: string; mime: string }>;
}

export interface NcrpComplaint {
  ncrpId: string;
  firNumber?: string;
  complainantDetails: {
    name: string;
    contact: string;
    email?: string;
  };
  incidentDetails: {
    dateTime: string;
    location: string;
    modusOperandi: string;
  };
  cryptoDetails: {
    walletAddresses: string[];
    transactionIds: string[];
    exchangeNames?: string[];
  };
  investigatingOfficer: {
    name: string;
    badgeNumber: string;
    unit: string;
  };
  priority: "low" | "medium" | "high" | "critical";
}

export class SahyogAdapter {
  private baseUrl: string;
  private apiKey: string;

  constructor() {
    this.baseUrl = env.SAHYOG_API_URL ?? "https://api.sahyog.gov.in/v1";
    this.apiKey = env.SAHYOG_API_KEY ?? "";
  }

  async fetchComplaints(since?: Date): Promise<SahyogComplaint[]> {
    if (!this.apiKey) {
      logger.warn("SAHYOG_API_KEY not configured, skipping fetch");
      return [];
    }

    try {
      const params = new URLSearchParams();
      if (since) params.set("since", since.toISOString());

      const res = await fetch(`${this.baseUrl}/complaints/crypto?${params}`, {
        headers: {
          "Authorization": `Bearer ${this.apiKey}`,
          "Accept": "application/json",
          "User-Agent": "CryptoTrace/1.0"
        }
      });

      if (!res.ok) {
        throw new Error(`SAHYOG API error: ${res.status} ${res.statusText}`);
      }

      const data = await res.json() as SahyogApiResponse;
      return data.complaints ?? [];
    } catch (err) {
      logger.error("SAHYOG fetch failed", { error: err instanceof Error ? err.message : String(err) });
      return [];
    }
  }

  async ingestComplaint(complaint: SahyogComplaint): Promise<string> {
    const db = await getDb();
    const caseRef = `SAHYOG-${complaint.complaintId}`;

    // Check if already exists
    const existing = await db.query<CaseRow>(
      `SELECT id FROM cases WHERE case_ref = $1`,
      [caseRef]
    );
    const existingRow = existing.rows[0];
    if (existingRow) {
      logger.info("SAHYOG complaint already ingested", { caseRef });
      return existingRow.id;
    }

    // Create case with all wallet addresses
    const chain = this.detectChain(complaint.walletAddresses[0] ?? "") ?? "ethereum";

    const { rows } = await db.query<CaseRow>(
      `INSERT INTO cases (case_ref, title, description, chain, status, priority, referral_source, seed_kind, seed_value, created_at)
       VALUES ($1,$2,$3,$4,'Open','High','SAHYOG','addresses', $5, now())
       RETURNING id`,
      [
        caseRef,
        `SAHYOG: ${complaint.fraudType.replace("_", " ")} - ${complaint.complaintId}`,
        `${complaint.description}\n\nReported by: ${complaint.reportedBy}\nVictim: ${complaint.victimName ?? "N/A"}\nDate: ${complaint.incidentDate}`,
        chain,
        JSON.stringify(complaint.walletAddresses)
      ]
    );

    const insertedRow = rows[0];
    if (!insertedRow) throw new Error("Failed to create case");
    const caseId = insertedRow.id;

    // Queue trace jobs for each wallet
    for (const addr of complaint.walletAddresses) {
      await db.query(
        `INSERT INTO trace_jobs (case_id, chain, root_address, max_hops, direction, status, created_by)
         VALUES ($1,$2,$3,3,'forward','queued',(SELECT id FROM users WHERE email = 'system@cryptotrace.local'))`,
        [caseId, this.detectChain(addr) ?? "ethereum", addr]
      );
    }

    // Log audit
    await db.query(
      `INSERT INTO audit_log (actor_id, actor_email, action, entity_type, entity_id, case_ref, after, ip, user_agent, outcome)
       VALUES ($1,$2,'ingest','case',$3,(SELECT case_ref FROM cases WHERE id=$3),'{}','sahyog','CryptoTrace','success')`,
      [null, "sahyog@cryptotrace.local", caseId]
    );

    logger.info("SAHYOG complaint ingested", { caseRef, caseId, walletCount: complaint.walletAddresses.length });
    return caseId;
  }

  private detectChain(address: string): string | null {
    if (/^bc1|[13][a-km-zA-HJ-NP-Z1-9]{25,39}$/.test(address)) return "bitcoin";
    if (/^0x[a-fA-F0-9]{40}$/.test(address)) return "ethereum";
    if (/^T[a-zA-Z0-9]{33}$/.test(address)) return "tron";
    return null;
  }

  async startPolling(intervalMs: number = 300000): Promise<() => void> {
    const poll = async () => {
      try {
        const complaints = await this.fetchComplaints();
        for (const c of complaints) {
          await this.ingestComplaint(c);
        }
      } catch (err) {
        logger.error("SAHYOG polling error", { error: err instanceof Error ? err.message : String(err) });
      }
    };

    await poll(); // Initial run
    const timer = setInterval(poll, intervalMs);

    return () => clearInterval(timer);
  }
}

export class NcrpAdapter {
  private baseUrl: string;
  private apiKey: string;

  constructor() {
    this.baseUrl = env.NCRP_API_URL ?? "https://api.ncrp.gov.in/v1";
    this.apiKey = env.NCRP_API_KEY ?? "";
  }

  async fetchComplaints(since?: Date): Promise<NcrpComplaint[]> {
    if (!this.apiKey) {
      logger.warn("NCRP_API_KEY not configured, skipping fetch");
      return [];
    }

    try {
      const params = new URLSearchParams();
      if (since) params.set("since", since.toISOString());

      const res = await fetch(`${this.baseUrl}/complaints?${params}`, {
        headers: {
          "Authorization": `Bearer ${this.apiKey}`,
          "Accept": "application/json",
          "User-Agent": "CryptoTrace/1.0"
        }
      });

      if (!res.ok) throw new Error(`NCRP API error: ${res.status} ${res.statusText}`);

      const data = await res.json() as NcrpApiResponse;
      return data.complaints ?? [];
    } catch (err) {
      logger.error("NCRP fetch failed", { error: err instanceof Error ? err.message : String(err) });
      return [];
    }
  }

  async ingestComplaint(complaint: NcrpComplaint): Promise<string> {
    const db = await getDb();
    const caseRef = `NCRP-${complaint.ncrpId}`;

    const existing = await db.query<CaseRow>(
      `SELECT id FROM cases WHERE case_ref = $1`,
      [caseRef]
    );
    const existingRow = existing.rows[0];
    if (existingRow) return existingRow.id;

    const wallets = complaint.cryptoDetails.walletAddresses;
    const chain = this.detectChain(wallets[0] ?? "") ?? "ethereum";

    const { rows } = await db.query<CaseRow>(
      `INSERT INTO cases (case_ref, title, description, chain, status, priority, referral_source, seed_kind, seed_value, created_at)
       VALUES ($1,$2,$3,$4,'Open',$5,'NCRP','addresses',$6,now())
       RETURNING id`,
      [
        caseRef,
        `NCRP: ${complaint.incidentDetails.modusOperandi} - ${complaint.ncrpId}`,
        `FIR: ${complaint.firNumber ?? "N/A"}\nOfficer: ${complaint.investigatingOfficer.name} (${complaint.investigatingOfficer.badgeNumber})\nUnit: ${complaint.investigatingOfficer.unit}\nDate: ${complaint.incidentDetails.dateTime}\nLocation: ${complaint.incidentDetails.location}\nModus: ${complaint.incidentDetails.modusOperandi}\nExchanges: ${complaint.cryptoDetails.exchangeNames?.join(", ") ?? "N/A"}`,
        chain,
        complaint.priority,
        JSON.stringify(wallets)
      ]
    );

    const insertedRow = rows[0];
    if (!insertedRow) throw new Error("Failed to create case");
    const caseId = insertedRow.id;

    for (const addr of wallets) {
      await db.query(
        `INSERT INTO trace_jobs (case_id, chain, root_address, max_hops, direction, status, created_by)
         VALUES ($1,$2,$3,3,'forward','queued',(SELECT id FROM users WHERE email = 'system@cryptotrace.local'))`,
        [caseId, this.detectChain(addr) ?? "ethereum", addr]
      );
    }

    for (const txid of complaint.cryptoDetails.transactionIds) {
      await db.query(
        `INSERT INTO trace_jobs (case_id, chain, root_address, max_hops, direction, status, created_by)
         VALUES ($1,$2,$3,1,'both','queued',(SELECT id FROM users WHERE email = 'system@cryptotrace.local'))`,
        [caseId, chain, txid]
      );
    }

    await db.query(
      `INSERT INTO audit_log (actor_id, actor_email, action, entity_type, entity_id, case_ref, after, ip, user_agent, outcome)
       VALUES ($1,$2,'ingest','case',$3,(SELECT case_ref FROM cases WHERE id=$3),'{}','ncrp','CryptoTrace','success')`,
      [null, "ncrp@cryptotrace.local", caseId]
    );

    logger.info("NCRP complaint ingested", { caseRef, caseId, walletCount: wallets.length });
    return caseId;
  }

  private detectChain(address: string): string | null {
    if (/^bc1|[13][a-km-zA-HJ-NP-Z1-9]{25,39}$/.test(address)) return "bitcoin";
    if (/^0x[a-fA-F0-9]{40}$/.test(address)) return "ethereum";
    if (/^T[a-zA-Z0-9]{33}$/.test(address)) return "tron";
    return null;
  }

  async startPolling(intervalMs: number = 300000): Promise<() => void> {
    const poll = async () => {
      try {
        const complaints = await this.fetchComplaints();
        for (const c of complaints) await this.ingestComplaint(c);
      } catch (err) {
        logger.error("NCRP polling error", { error: err instanceof Error ? err.message : String(err) });
      }
    };

    await poll();
    const timer = setInterval(poll, intervalMs);
    return () => clearInterval(timer);
  }
}

export const sahyogAdapter = new SahyogAdapter();
export const ncrpAdapter = new NcrpAdapter();