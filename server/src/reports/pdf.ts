import type { Db } from "../db/index.js";
import { findCaseByIdOrRef, many, one } from "../db/index.js";
import { logger } from "../logger.js";
import type { AuthUser } from "../middleware/auth.js";
import { DEFAULT_THRESHOLDS } from "../risk/engine.js";
import type { RiskFactor, TraceGraph } from "../types.js";

/**
 * PDF report generation.
 *
 * Deliberately dependency-free: a minimal PDF 1.4 writer emitting a multi-page
 * Helvetica text document. Adding a PDF library for a handful of pages of
 * text is not worth the supply-chain surface.
 *
 * The document separates chain facts, third-party attribution and analyst
 * hypotheses into labelled sections. Conflating them is the main way a report
 * of this kind misleads a reader.
 */

interface Line {
  text: string;
  size: number;
  bold: boolean;
  gapBefore: number;
  indent: number;
  color: [number, number, number];
}

const PAGE_W = 595.28; // A4 portrait, points
const PAGE_H = 841.89;
const MARGIN_X = 56;
const MARGIN_TOP = 64;
const MARGIN_BOTTOM = 56;

const COLORS = {
  text: [0.1, 0.11, 0.14] as [number, number, number],
  muted: [0.42, 0.45, 0.5] as [number, number, number],
  heading: [0.43, 0.39, 0.91] as [number, number, number],
  rule: [0.85, 0.86, 0.9] as [number, number, number],
  warn: [0.72, 0.3, 0.2] as [number, number, number]
};

/** Shared by the case and portfolio documents so the caveats cannot drift apart. */
const METHODOLOGY = [
  "Data sources: public chain endpoints (mempool.space, Cloudflare Ethereum JSON-RPC, TronGrid). Their availability, rate limits and consistency are outside this system's control and they can serve stale data.",
  "Risk scoring: rule matches are weighted and discounted by confidence, then passed through a saturating curve to a 0-100 scale. Weights are configurable. A score prioritises analyst review and is not a determination of wrongdoing.",
  "EVM coverage: public nodes generally cannot enumerate history by address, so Ethereum and Polygon coverage is partial. Absence of a transaction here is not evidence that it never occurred.",
  "Identity: a wallet address is pseudonymous. Nothing in this report attributes an address to a named person.",
  "Attribution: third-party labels are claims from the cited sources and remain subject to analyst challenge.",
  "Model output: text extracted from attached documents is sent to a configured third-party language model for summarisation. Proposals are never applied automatically, are recorded against the model and prompt version that produced them, and every identifier is re-validated against this platform's own chain detection before storage. Model output can be wrong and is not evidence.",
  "Completeness: tracing is bounded. Absence of a path in these results does not establish that no such path exists."
];

/** Helvetica AFM widths (per 1000 units) for the printable ASCII range we use. */
const HELV_WIDTHS: Record<string, number> = {
  " ": 278, "!": 278, '"': 355, "#": 556, $: 556, "%": 889, "&": 667, "'": 191,
  "(": 333, ")": 333, "*": 389, "+": 584, ",": 278, "-": 333, ".": 278, "/": 278,
  "0": 556, "1": 556, "2": 556, "3": 556, "4": 556, "5": 556, "6": 556, "7": 556,
  "8": 556, "9": 556, ":": 278, ";": 278, "<": 584, "=": 584, ">": 584, "?": 556,
  "@": 1015, A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278,
  J: 500, K: 667, L: 556, M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667,
  T: 611, U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611, "[": 278, "\\": 278,
  "]": 278, "^": 469, _: 556, "`": 333, a: 556, b: 556, c: 500, d: 556, e: 556,
  f: 278, g: 556, h: 556, i: 222, j: 222, k: 500, l: 222, m: 833, n: 556, o: 556,
  p: 556, q: 556, r: 333, s: 500, t: 278, u: 556, v: 500, w: 722, x: 500, y: 500,
  z: 500, "{": 334, "|": 260, "}": 334, "~": 584
};

function textWidth(text: string, size: number, bold: boolean): number {
  const scale = bold ? 1.055 : 1;
  let total = 0;
  for (const ch of text) total += (HELV_WIDTHS[ch] ?? 556) * scale;
  return (total * size) / 1000;
}

function escapePdfText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/** Replace characters outside the WinAnsi range the base font can encode. */
function toWinAnsi(value: string): string {
  return value
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u2013/g, "-")
    .replace(/\u2014/g, "--")
    .replace(/\u2022/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/\u20B9/g, "Rs")
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, "?");
}

class PdfBuilder {
  private pages: string[] = [];
  private ops: string[] = [];
  private y = PAGE_H - MARGIN_TOP;

  get pageCount(): number {
    return this.pages.length;
  }

  private ensureRoom(): void {
    if (this.y > MARGIN_BOTTOM) return;
    this.flushPage();
  }

  private flushPage(): void {
    this.pages.push(this.ops.join("\n"));
    this.ops = [];
    this.y = PAGE_H - MARGIN_TOP;
  }

  text(raw: string, opts: Partial<Omit<Line, "text">> = {}): void {
    const line: Line = {
      text: raw,
      size: opts.size ?? 10,
      bold: opts.bold ?? false,
      gapBefore: opts.gapBefore ?? 0,
      indent: opts.indent ?? 0,
      color: opts.color ?? COLORS.text
    };
    this.ensureRoom();
    // Applied after the room check so the gap opens space on the page the line
    // actually lands on, rather than being swallowed by a page break.
    this.y -= line.gapBefore;

    const maxWidth = PAGE_W - MARGIN_X * 2 - line.indent;
    const wrapped = wrap(toWinAnsi(line.text), line.size, line.bold, maxWidth);
    const leading = line.size * 1.35;

    for (const segment of wrapped) {
      this.ensureRoom();
      this.y -= leading;
      const font = line.bold ? "/F2" : "/F1";
      const [r, g, b] = line.color;
      this.ops.push(
        `BT ${font} ${line.size} Tf ${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} rg 1 0 0 1 ${(MARGIN_X + line.indent).toFixed(2)} ${this.y.toFixed(2)} Tm (${escapePdfText(segment)}) Tj ET`
      );
    }
  }

  rule(gapBefore = 6): void {
    this.ensureRoom();
    this.y -= gapBefore;
    this.ensureRoom();
    const [r, g, b] = COLORS.rule;
    this.ops.push(
      `${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} RG 0.7 w ${MARGIN_X.toFixed(2)} ${this.y.toFixed(2)} m ${(PAGE_W - MARGIN_X).toFixed(2)} ${this.y.toFixed(2)} l S`
    );
    this.y -= 6;
  }

  /**
   * Object layout is fixed and every reference below is derived from it:
   *
   *   1 Catalog   2 Pages   3 F1   4 F2   5 F3
   *   then, per page i (0-based):  page = 6 + 2i,  content = 7 + 2i
   *   last object: /Info
   *
   * Getting these off by one produces a file that looks like it downloaded
   * fine but will not open, because /Kids resolves to a font dictionary and
   * each page's /Contents points back at itself.
   */
  finish(title: string, subject: string): Buffer {
    if (this.ops.length) this.flushPage();
    if (!this.pages.length) this.flushPage();
    const count = this.pages.length;

    const pageObjNo = (i: number): number => 6 + i * 2;
    const contentObjNo = (i: number): number => 7 + i * 2;
    const kids = Array.from({ length: count }, (_, i) => `${pageObjNo(i)} 0 R`).join(" ");

    const objects: string[] = [];
    objects.push(`<< /Type /Catalog /Pages 2 0 R >>`);
    objects.push(`<< /Type /Pages /Count ${count} /Kids [${kids}] >>`);
    objects.push(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`);
    objects.push(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>`);
    objects.push(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>`);

    this.pages.forEach((content, i) => {
      objects.push(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W.toFixed(2)} ${PAGE_H.toFixed(2)}] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> /Contents ${contentObjNo(i)} 0 R >>`
      );
      const bytes = Buffer.from(content, "latin1");
      objects.push(`<< /Length ${bytes.length} >>\nstream\n${content}\nendstream`);
    });

    const infoNo = objects.length + 1;
    objects.push(
      `<< /Title (${escapePdfText(toWinAnsi(title))}) /Subject (${escapePdfText(toWinAnsi(subject))}) /Producer (CryptoTrace AI) /Creator (CryptoTrace AI) /CreationDate (${pdfDate(new Date())}) >>`
    );

    let pdf = "%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n";
    const offsets: number[] = [];
    objects.forEach((body, idx) => {
      offsets.push(Buffer.byteLength(pdf, "latin1"));
      pdf += `${idx + 1} 0 obj\n${body}\nendobj\n`;
    });

    const xrefPos = Buffer.byteLength(pdf, "latin1");
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${infoNo} 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;

    return Buffer.from(pdf, "latin1");
  }
}

/** PDF date string: D:YYYYMMDDHHmmSSZ. */
function pdfDate(d: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  return (
    `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  );
}

function wrap(text: string, size: number, bold: boolean, maxWidth: number): string[] {
  if (!text) return [""];
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (textWidth(candidate, size, bold) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    if (textWidth(word, size, bold) <= maxWidth) {
      current = word;
    } else {
      // A single token longer than the line: hard-split it.
      let chunk = "";
      for (const ch of word) {
        if (textWidth(chunk + ch, size, bold) > maxWidth) {
          lines.push(chunk);
          chunk = ch;
        } else {
          chunk += ch;
        }
      }
      current = chunk;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

export interface PdfReport {
  buffer: Buffer;
  meta: { caseRef: string; title: string };
}

export async function buildReportPdf(db: Db, caseIdOrRef: string, user: AuthUser): Promise<PdfReport | null> {
  const found = await findCaseByIdOrRef<{
    id: string;
    case_ref: string;
    title: string;
    description: string | null;
    chain: string;
    status: string;
    priority: string;
    opened_at: string;
    closed_at: string | null;
    lead_name: string | null;
  }>(db, caseIdOrRef);
  if (!found) return null;
  const c = found;

  const [entities, notes, evidence, traces, alerts, documents, proposals] = await Promise.all([
    many<{ chain: string; address: string; kind: string; label: string | null; risk_score: number; risk_level: string; hop_count: number; amount_usd: string | null; risk_factors: RiskFactor[] | null; last_seen: string | null; status: string | null; statusReason: string | null }>(
      db,
      `SELECT e.chain, e.address, e.kind, e.label, e.risk_score, e.risk_level, ce.hop_count, ce.amount_usd, e.risk_factors, e.last_seen, e.status, e.status_reason
       FROM case_entities ce JOIN entities e ON e.id = ce.entity_id
       WHERE ce.case_id = (SELECT id FROM cases WHERE case_ref = $1) ORDER BY ce.hop_count, e.risk_score DESC`,
      [c.case_ref]
    ),
    many<{ body: string; kind: string; created_at: string; author: string | null }>(
      db,
      `SELECT n.body, n.kind, n.created_at, u.display_name AS author
       FROM case_notes n LEFT JOIN users u ON u.id = n.author_id
       WHERE n.case_id = (SELECT id FROM cases WHERE case_ref = $1) ORDER BY n.created_at`,
      [c.case_ref]
    ),
    many<{ kind: string; title: string; content_sha256: string; collected_at: string }>(
      db,
      `SELECT kind, title, content_sha256, collected_at FROM evidence
       WHERE case_id = (SELECT id FROM cases WHERE case_ref = $1) ORDER BY collected_at`,
      [c.case_ref]
    ),
    many<{ root_address: string; max_hops: number; direction: string; node_count: number; edge_count: number; risk_score: number; risk_level: string; created_at: string; chain: string; truncated_reasons: string[] | null }>(
      db,
      `SELECT root_address, max_hops, direction, node_count, edge_count, risk_score, risk_level, created_at, chain, truncated_reasons
       FROM traces WHERE case_id = (SELECT id FROM cases WHERE case_ref = $1) ORDER BY created_at DESC LIMIT 25`,
      [c.case_ref]
    ),
    many<{ severity: string; category: string; title: string; detail: string | null; created_at: string; entity_address: string | null; entity_chain: string | null }>(
      db,
      `SELECT a.severity, a.category, a.title, a.detail, a.created_at, e.address AS entity_address, e.chain AS entity_chain
       FROM alerts a LEFT JOIN entities e ON e.id = a.entity_id
       WHERE a.case_id = (SELECT id FROM cases WHERE case_ref = $1) ORDER BY a.created_at DESC`,
      [c.case_ref]
    ),
    many<{ filename: string; mime: string; byte_size: number; sha256: string; char_count: number | null; status: string; created_at: string; uploader: string | null; page_count: number | null; ocr_used: boolean; ocr_language: string | null; ocr_average_confidence: number | null; ocr_pages_processed: number | null }>(
      db,
      `SELECT d.filename, d.mime, d.byte_size, d.sha256, d.char_count, d.status, d.created_at,
              u.display_name AS uploader, d.page_count, d.ocr_used, d.ocr_language, d.ocr_average_confidence, d.ocr_pages_processed
       FROM documents d LEFT JOIN users u ON u.id = d.uploaded_by
       WHERE d.case_id = (SELECT id FROM cases WHERE case_ref = $1) ORDER BY d.created_at`,
      [c.case_ref]
    ),
    many<{
      id: string;
      status: string;
      model: string;
      prompt_version: string;
      proposal: { summary?: string; indicators?: { value: string; role: string }[]; hypotheses?: { text: string }[] } | null;
      applied_summary: { entitiesCreated?: number; transactionsCreated?: number; tracesFailed?: { reason: string }[] } | null;
      filename: string | null;
      creator: string | null;
      decider: string | null;
      decided_at: string | null;
      created_at: string;
    }>(
      db,
      `SELECT p.id, p.status, p.model, p.prompt_version, p.proposal, p.applied_summary, d.filename,
              u.display_name AS creator, d2.display_name AS decider, p.decided_at, p.created_at
       FROM ai_proposals p
       LEFT JOIN documents d ON d.id = p.document_id
       LEFT JOIN users u ON u.id = p.created_by
       LEFT JOIN users d2 ON d2.id = p.decided_by
       WHERE p.case_id = (SELECT id FROM cases WHERE case_ref = $1) ORDER BY p.created_at`,
      [c.case_ref]
    )
  ]);

  const pdf = new PdfBuilder();
  const now = new Date();

  pdf.text("CryptoTrace AI", { size: 20, bold: true, color: COLORS.heading });
  pdf.text("Investigation Report", { size: 13, color: COLORS.muted, gapBefore: 2 });
  pdf.rule(10);

  pdf.text(`${c.case_ref}  -  ${c.title}`, { size: 15, bold: true });
  pdf.text(
    `Chain: ${c.chain}   Status: ${c.status}   Priority: ${c.priority}   Opened: ${fmt(c.opened_at)}${c.closed_at ? `   Closed: ${fmt(c.closed_at)}` : ""}`,
    { size: 9.5, color: COLORS.muted, gapBefore: 6 }
  );
  pdf.text(`Lead investigator: ${c.lead_name ?? "unassigned"}`, { size: 9.5, color: COLORS.muted, gapBefore: 2 });
  pdf.text(`Generated: ${fmt(now.toISOString())} by ${user.email} (${user.role})`, { size: 9.5, color: COLORS.muted, gapBefore: 2 });

  pdf.rule(8);
  pdf.text("Reading this report", { size: 11, bold: true, gapBefore: 4 });
  pdf.text(
    "Sections are separated by evidentiary weight. On-chain observations are reproducible by anyone with the same data sources. Third-party attributions are claims made by an external source. Analyst hypotheses are unverified reasoning. None of them, alone or together, establish the identity of a person or that any law was broken.",
    { size: 9, color: COLORS.muted, gapBefore: 4 }
  );

  if (c.description) {
    section(pdf, "1. Case Summary");
    pdf.text(c.description, { size: 10, gapBefore: 2 });
    pdf.text(
      `Case Reference: ${c.case_ref} | Title: ${c.title} | Status: ${c.status} | Priority: ${c.priority} | Chain: ${c.chain} | Opened: ${fmt(c.opened_at)}${c.closed_at ? ` | Closed: ${fmt(c.closed_at)}` : ""} | Lead: ${c.lead_name ?? "unassigned"}`,
      { size: 9, color: COLORS.muted, gapBefore: 4 }
    );
  }

  section(pdf, "2. Source Document Analysis");
  pdf.text(
    "The following documents were processed through the AI document analysis pipeline. Each document was uploaded by an investigator, text was extracted (with OCR for scanned PDFs), and the content was sent to a configured language model for structured extraction.",
    { size: 9, color: COLORS.muted, gapBefore: 2 }
  );
  if (documents.length) {
    for (const d of documents) {
      pdf.text(`Source document: ${d.filename}`, { size: 9.5, bold: true, gapBefore: 6 });
      pdf.text(
        `${d.mime} | ${d.byte_size} bytes | SHA-256 ${d.sha256}${d.char_count ? ` | ${d.char_count} characters extracted` : ""} | status ${d.status}`,
        { size: 8.5, color: COLORS.muted, gapBefore: 1 }
      );
      pdf.text(
        `Attached by ${d.uploader ?? "unknown"} on ${fmt(d.created_at)}. The document text was sent to the configured model provider for analysis; treat the provider as a recipient of case material.`,
        { size: 8.5, color: COLORS.muted, gapBefore: 1 }
      );
      if (d.ocr_used) {
        pdf.text(
          `OCR was used: language ${d.ocr_language ?? "eng"}, avg confidence ${(d.ocr_average_confidence ?? 0).toFixed(1)}%, ${d.ocr_pages_processed ?? 0}/${d.page_count ?? 0} pages processed.`,
          { size: 8.5, color: COLORS.warn, gapBefore: 1 }
        );
      }
    }
  } else {
    empty(pdf, "No documents have been attached to this case.");
  }

  section(pdf, "3. Extracted Addresses");
  const extractedAddresses = entities.filter((e) => e.kind !== "tx");
  if (extractedAddresses.length) {
    pdf.text(
      "The following blockchain addresses were extracted from attached documents and validated against the platform's chain detection. Each address was reviewed by an investigator before being attached to the case.",
      { size: 9, color: COLORS.muted, gapBefore: 2 }
    );
    for (const e of extractedAddresses) {
      pdf.text(`${shortAddr(e.address)}  (${e.chain})`, { size: 10, bold: true, gapBefore: 6 });
      pdf.text(
        `Kind: ${e.kind}${e.label ? ` | Label: ${e.label}` : ""} | Hop ${e.hop_count} | Risk ${e.risk_score}/100 (${e.risk_level})${e.amount_usd ? ` | Amount ${e.amount_usd}` : ""}`,
        { size: 9, color: COLORS.muted, gapBefore: 1 }
      );
    }
  } else {
    empty(pdf, "No addresses extracted from documents.");
  }

  section(pdf, "4. Extracted Transaction Hashes");
  const extractedTxs = entities.filter((e) => e.kind === "tx");
  if (extractedTxs.length) {
    pdf.text(
      "The following transaction hashes were extracted from attached documents. Transaction hashes are stored separately from addresses and linked to the case through the transaction register.",
      { size: 9, color: COLORS.muted, gapBefore: 2 }
    );
    for (const e of extractedTxs) {
      pdf.text(`${shortAddr(e.address)}  (${e.chain})`, { size: 10, bold: true, gapBefore: 6 });
      pdf.text(
        `Type: transaction hash | Hop ${e.hop_count} | Risk ${e.risk_score}/100 (${e.risk_level})${e.amount_usd ? ` | Amount ${e.amount_usd}` : ""}`,
        { size: 9, color: COLORS.muted, gapBefore: 1 }
      );
    }
  } else {
    empty(pdf, "No transaction hashes extracted from documents.");
  }

  section(pdf, "5. Blockchain Networks Identified");
  const chainsInvolved = [...new Set(entities.map((e) => e.chain))];
  if (chainsInvolved.length) {
    pdf.text(
      `The following blockchain networks were identified in this case: ${chainsInvolved.join(", ")}.`,
      { size: 9, gapBefore: 2 }
    );
    for (const chain of chainsInvolved) {
      const chainEntities = entities.filter((e) => e.chain === chain);
      pdf.text(`${chain}: ${chainEntities.length} entities`, { size: 9, gapBefore: 1, indent: 10 });
    }
  } else {
    empty(pdf, "No blockchain networks identified.");
  }

  section(pdf, "6. Investigation Objective");
  if (c.description) {
    pdf.text(c.description, { size: 10, gapBefore: 2 });
  } else {
    empty(pdf, "No investigation objective recorded.");
  }

  section(pdf, "7. AI Trace Plan");
  if (proposals.length) {
    const appliedProposals = proposals.filter((p) => p.status === "applied");
    if (appliedProposals.length) {
      for (const p of appliedProposals) {
        const summary = p.applied_summary;
        pdf.text(`Proposal on ${p.filename ?? "unattached document"}`, { size: 9.5, bold: true, gapBefore: 6 });
        pdf.text(
          `Model ${p.model} | prompt ${p.prompt_version} | proposed ${fmt(p.created_at)} | applied by ${p.decider ?? "unknown"} on ${p.decided_at ? fmt(p.decided_at) : "unknown"}`,
          { size: 8.5, color: COLORS.muted, gapBefore: 1 }
        );
        if (summary) {
          pdf.text(
            `Result: ${summary.entitiesCreated ?? 0} entities, ${summary.transactionsCreated ?? 0} transactions, ${(summary.tracesFailed ?? []).length} trace(s) failed`,
            { size: 8.5, gapBefore: 1 }
          );
        }
      }
    }
    if (proposals.some((p) => p.status === "pending")) {
      pdf.text("Pending trace plans awaiting review.", { size: 8.5, color: COLORS.warn, gapBefore: 2 });
    }
  } else {
    empty(pdf, "No trace plans generated yet.");
  }

  section(pdf, "8. Fund-Flow Summary");
  if (entities.length) {
    const totalValue = entities.reduce((sum, e) => sum + Number(e.amount_usd ?? 0), 0);
    pdf.text(`Total traced value attributed to entities: USD ${totalValue.toLocaleString(undefined, { maximumFractionDigits: 2 })}`, { size: 9.5, bold: true, gapBefore: 2 });
    pdf.text(
      "The following table summarizes the fund flow by hop distance from the seed entity:",
      { size: 9, color: COLORS.muted, gapBefore: 2 }
    );
    const hopGroups = new Map<number, typeof entities>();
    for (const e of entities) {
      const h = e.hop_count;
      if (!hopGroups.has(h)) hopGroups.set(h, []);
      hopGroups.get(h)!.push(e);
    }
    for (const [hop, ents] of [...hopGroups.entries()].sort((a, b) => a[0] - b[0])) {
      const hopValue = ents.reduce((s, e) => s + Number(e.amount_usd ?? 0), 0);
      pdf.text(`Hop ${hop}: ${ents.length} entities, USD ${hopValue.toLocaleString(undefined, { maximumFractionDigits: 2 })}`, { size: 9, gapBefore: 2 });
    }
  } else {
    empty(pdf, "No entities to summarize fund flow.");
  }

  section(pdf, "9. Investigation Graph");
  if (traces.length) {
    // Fetch full graph data for the most recent trace
    const traceGraphs = await many<{ graph: TraceGraph; root_address: string; max_hops: number; direction: string; node_count: number; edge_count: number; risk_score: number; risk_level: string; created_at: string }>(
      db,
      `SELECT graph, root_address, max_hops, direction, node_count, edge_count, risk_score, risk_level, created_at
       FROM traces WHERE case_id = (SELECT id FROM cases WHERE case_ref = $1) ORDER BY created_at DESC LIMIT 5`,
      [c.case_ref]
    );

    for (const t of traceGraphs) {
      pdf.text(
        `${fmt(t.created_at)}  root ${shortAddr(t.root_address)}  hops ${t.max_hops}  direction ${t.direction}  nodes ${t.node_count}  edges ${t.edge_count}  risk ${t.risk_score}/100 (${t.risk_level})`,
        { size: 9, gapBefore: 3 }
      );
      
      // Render graph as text diagram
      if (t.graph && t.graph.nodes && t.graph.edges) {
        const graphText = renderGraphAsText(t.graph);
        for (const line of graphText) {
          pdf.text(line, { size: 7.5, gapBefore: 1, indent: 10 });
        }
      }
    }
    pdf.text(
      "Each run was bounded by hop, node, edge and time limits. A bounded trace shows paths explored within those limits; it is not a complete account of where the funds went.",
      { size: 9, color: COLORS.warn, gapBefore: 4 }
    );
  } else {
    empty(pdf, "No trace runs recorded for this case.");
  }

  section(pdf, "10. Transaction Timeline");
  const allTxs = [
    ...entities.flatMap((e) => e.amount_usd && e.last_seen ? [{ time: e.last_seen, address: e.address, value: e.amount_usd, type: "entity" }] : [])
  ].sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
  if (allTxs.length) {
    for (const tx of allTxs.slice(0, 50)) {
      pdf.text(`${fmt(tx.time)}  ${shortAddr(tx.address)}  USD ${Number(tx.value).toLocaleString()}  (${tx.type})`, { size: 8.5, gapBefore: 1 });
    }
    if (allTxs.length > 50) pdf.text(`... and ${allTxs.length - 50} more entries`, { size: 8.5, color: COLORS.muted, gapBefore: 2 });
  } else {
    empty(pdf, "No transaction timeline available.");
  }

  section(pdf, "11. Risk Signals");
  const riskSignals = entities.filter((e) => e.risk_score >= DEFAULT_THRESHOLDS.high);
  if (riskSignals.length) {
    pdf.text(
      `High-risk entities (score >= ${DEFAULT_THRESHOLDS.high}): ${riskSignals.length}`,
      { size: 9.5, bold: true, gapBefore: 2 }
    );
    for (const e of riskSignals.slice(0, 20)) {
      pdf.text(`${shortAddr(e.address)} (${e.chain}) - Risk ${e.risk_score}/100 (${e.risk_level})`, { size: 9, gapBefore: 2 });
      if (e.risk_factors?.length) {
        for (const f of e.risk_factors.slice(0, 3)) {
          pdf.text(`  - ${f.label}: ${f.detail}`, { size: 8.5, color: COLORS.muted, indent: 10, gapBefore: 1 });
        }
      }
    }
  } else {
    empty(pdf, "No high-risk signals detected.");
  }

  section(pdf, "12. Alerts");
  if (alerts.length) {
    for (const a of alerts) {
      pdf.text(`${fmt(a.created_at)}  [${a.severity.toUpperCase()}] ${a.title}`, { size: 9, gapBefore: 3 });
      pdf.text(`${a.category}${a.entity_address ? ` | ${shortAddr(a.entity_address)} (${a.entity_chain})` : ""}`, {
        size: 8.5,
        color: COLORS.muted,
        indent: 10,
        gapBefore: 1
      });
    }
  } else {
    empty(pdf, "No alerts raised for this case.");
  }

  section(pdf, "13. Unresolved/Missing Nodes");
  const unresolvedNodes = entities.filter((e) => e.status === "unresolved" || e.status === "unknown" || e.status === "partial");
  if (unresolvedNodes.length) {
    pdf.text(
      "The following nodes could not be fully resolved during tracing. Reasons include provider unavailability, chain coverage gaps, or data truncation.",
      { size: 9, color: COLORS.warn, gapBefore: 2 }
    );
    for (const e of unresolvedNodes) {
      pdf.text(`${shortAddr(e.address)} (${e.chain}) - Status: ${e.status} | Reason: ${e.statusReason ?? "unknown"}`, { size: 8.5, gapBefore: 2 });
    }
  } else {
    empty(pdf, "All traced nodes were resolved.");
  }

  section(pdf, "14. Cross-Chain Movement");
  const bridgeEntities = entities.filter((e) => (e.risk_factors ?? []).some((f) => f.code === "bridge_exposure"));
  if (bridgeEntities.length) {
    pdf.text(`Cross-chain bridge interactions detected: ${bridgeEntities.length}`, { size: 9.5, bold: true, gapBefore: 2 });
    for (const e of bridgeEntities) {
      pdf.text(`${shortAddr(e.address)} (${e.chain}) - Bridge exposure`, { size: 9, gapBefore: 2 });
    }
  } else {
    empty(pdf, "No cross-chain bridge movements detected.");
  }

  section(pdf, "15. Exchange/VASP Interactions");
  const exchangeEntities = entities.filter((e) => (e.risk_factors ?? []).some((f) => f.code === "exchange_deposit"));
  if (exchangeEntities.length) {
    pdf.text(`Exchange interactions detected: ${exchangeEntities.length}`, { size: 9.5, bold: true, gapBefore: 2 });
    for (const e of exchangeEntities) {
      pdf.text(`${shortAddr(e.address)} (${e.chain}) - VASP deposit`, { size: 9, gapBefore: 2 });
    }
  } else {
    empty(pdf, "No exchange/VASP interactions detected.");
  }

  section(pdf, "16. Major Fund-Flow Paths");
  if (traces.length) {
    for (const t of traces) {
      pdf.text(`Trace from ${shortAddr(t.root_address)} (${t.chain}): ${t.node_count} nodes, ${t.edge_count} edges`, { size: 9.5, bold: true, gapBefore: 4 });
      pdf.text(`Risk: ${t.risk_score}/100 (${t.risk_level}) | Direction: ${t.direction} | Max hops: ${t.max_hops}`, { size: 8.5, color: COLORS.muted, gapBefore: 1 });
    }
  } else {
    empty(pdf, "No trace runs to reconstruct fund-flow paths.");
  }

  section(pdf, "17. Evidence");
  if (evidence.length) {
    for (const e of evidence) {
      pdf.text(`${e.kind}: ${e.title}`, { size: 9.5, bold: true, gapBefore: 4 });
      pdf.text(`Collected ${fmt(e.collected_at)} | SHA-256 ${e.content_sha256}`, { size: 8.5, color: COLORS.muted, gapBefore: 1 });
    }
    pdf.text(
      "Hashes are computed over canonical JSON at collection time. Recompute them before relying on an artifact; a mismatch means the stored copy differs from what was collected.",
      { size: 9, color: COLORS.muted, gapBefore: 5 }
    );
  } else {
    empty(pdf, "No evidence items recorded.");
  }

  section(pdf, "18. Risk Analysis");
  if (entities.length) {
    const criticalCount = entities.filter((e) => e.risk_score >= DEFAULT_THRESHOLDS.critical).length;
    const highCount = entities.filter((e) => e.risk_score >= DEFAULT_THRESHOLDS.high && e.risk_score < DEFAULT_THRESHOLDS.critical).length;
    const mediumCount = entities.filter((e) => e.risk_score >= DEFAULT_THRESHOLDS.medium && e.risk_score < DEFAULT_THRESHOLDS.high).length;
    const lowCount = entities.filter((e) => e.risk_score >= DEFAULT_THRESHOLDS.low && e.risk_score < DEFAULT_THRESHOLDS.medium).length;
    pdf.text(`Risk distribution: Critical ${criticalCount}, High ${highCount}, Medium ${mediumCount}, Low ${lowCount}, Unrated ${entities.length - criticalCount - highCount - mediumCount - lowCount}`, { size: 9.5, bold: true, gapBefore: 2 });
    pdf.text(
      `Thresholds in effect: Critical ${DEFAULT_THRESHOLDS.critical}, High ${DEFAULT_THRESHOLDS.high}, Medium ${DEFAULT_THRESHOLDS.medium}, Low ${DEFAULT_THRESHOLDS.low}. A score ranks review priority; it is not a determination of wrongdoing.`,
      { size: 9, color: COLORS.muted, gapBefore: 2 }
    );
    for (const f of entities.flatMap((e) => e.risk_factors ?? []).slice(0, 10)) {
      pdf.text(`- ${f.label}: ${f.detail}`, { size: 9, gapBefore: 2 });
    }
  } else {
    empty(pdf, "No entities to analyze for risk.");
  }

  section(pdf, "19. Trace Limitations");
  const allTruncatedReasons = new Set<string>();
  for (const t of traces) {
    for (const r of t.truncated_reasons ?? []) allTruncatedReasons.add(r);
  }
  if (allTruncatedReasons.size > 0) {
    pdf.text("The following limits were reached during tracing:", { size: 9.5, bold: true, gapBefore: 2 });
    for (const r of allTruncatedReasons) {
      pdf.text(`- ${r}`, { size: 9, gapBefore: 1, indent: 10 });
    }
  } else {
    empty(pdf, "No trace limits were reached in recorded runs.");
  }

  section(pdf, "20. AI Analysis");
  if (proposals.length) {
    for (const p of proposals) {
      const summary = p.applied_summary;
      pdf.text(`Proposal on ${p.filename ?? "an unattached document"}`, { size: 9.5, bold: true, gapBefore: 6 });
      pdf.text(
        `Model ${p.model} | prompt ${p.prompt_version} | proposed ${fmt(p.created_at)} | status ${p.status}`,
        { size: 8.5, color: COLORS.muted, gapBefore: 1 }
      );
      if (p.status === "applied") {
        pdf.text(
          `Reviewed and applied by ${p.decider ?? "unknown"} on ${p.decided_at ? fmt(p.decided_at) : "an unrecorded date"}. ` +
            `Result: ${summary?.entitiesCreated ?? 0} entities and ${summary?.transactionsCreated ?? 0} transactions added.`,
          { size: 8.5, color: COLORS.muted, gapBefore: 1 }
        );
        if (summary?.tracesFailed?.length) {
          pdf.text(
            `Traces attempted but not completed: ${summary.tracesFailed.map((t) => t.reason).join("; ")}`,
            { size: 8.5, color: COLORS.warn, gapBefore: 1 }
          );
        }
      } else if (p.status === "rejected") {
        pdf.text(
          `Reviewed and discarded by ${p.decider ?? "unknown"}${p.decided_at ? ` on ${fmt(p.decided_at)}` : ""}. Nothing from this proposal was stored.`,
          { size: 8.5, color: COLORS.muted, gapBefore: 1 }
        );
      } else {
        pdf.text("Awaiting review. Nothing from this proposal has been applied.", {
          size: 8.5,
          color: COLORS.warn,
          gapBefore: 1
        });
      }
      if (p.proposal?.summary) {
        pdf.text(`Model summary: ${p.proposal.summary}`, { size: 8.5, gapBefore: 2 });
      }
    }
  } else {
    empty(pdf, "No document analysis has been proposed for this case.");
  }

  section(pdf, "21. Investigator Notes");
  const investigatorNotes = notes.filter((n) => n.kind !== "hypothesis");
  if (investigatorNotes.length) {
    for (const n of investigatorNotes) {
      pdf.text(`[${n.kind}] ${n.body}`, { size: 9.5, gapBefore: 3 });
      pdf.text(`  ${n.author ?? "unknown"} on ${fmt(n.created_at)}`, { size: 8.5, color: COLORS.muted, indent: 10 });
    }
  } else {
    empty(pdf, "No investigator notes recorded.");
  }

  section(pdf, "22. Audit Log");
  // Would require audit log query; placeholder for now
  empty(pdf, "Audit log not included in this report version. Use the audit API for full history.");

  section(pdf, "23. Methodology and Limitations");
  for (const m of METHODOLOGY) {
    pdf.text(`- ${m}`, { size: 9, gapBefore: 3 });
  }

  section(pdf, "24. Data Sources");
  pdf.text(
    "Data in this report was sourced from: public blockchain endpoints (mempool.space for Bitcoin, Cloudflare Ethereum JSON-RPC for Ethereum/Polygon, TronGrid for Tron), third-party attribution databases (labels), analyst-entered data, and AI-extracted document content. Provider availability, rate limits, and consistency are outside this system's control.",
    { size: 9, gapBefore: 2 }
  );

  section(pdf, "25. Report Generation Timestamp");
  pdf.text(`Report generated at ${fmt(now.toISOString())} by ${user.email} (${user.role})`, { size: 9, gapBefore: 2 });

  section(pdf, "26. Case ID");
  pdf.text(`Case Reference: ${c.case_ref} | Internal ID: ${c.id}`, { size: 9, gapBefore: 2 });
  pdf.rule(10);
  pdf.text(
    `Generated by CryptoTrace AI at ${fmt(now.toISOString())} for ${user.email} (${user.role}). ` +
      "This report records what the platform observed and what analysts recorded, along with the provenance of each. " +
      "It supports authorised investigation and does not by itself establish the identity of any person or that any " +
      "law was broken. Corroborate independently before relying on it in any legal, regulatory or disciplinary process.",
    { size: 8, color: COLORS.muted }
  );

  const buffer = pdf.finish(`${c.case_ref} investigation report`, `${c.title}`);
  logger.info("Report generated", { caseRef: c.case_ref, pages: pdf.pageCount, bytes: buffer.length });
  return { buffer, meta: { caseRef: c.case_ref, title: c.title } };
}

/**
 * Portfolio summary across every case on file — the dashboard rendered as a
 * document, for handing to someone who will not open the application.
 *
 * The aggregates below deliberately mirror the SQL behind
 * `GET /api/reports/dashboard`. The two must be kept in step: a figure that
 * differs between the screen and the exported PDF is worse than either being
 * absent, because it looks like two independent confirmations of one number.
 */
export interface DashboardPdfReport {
  buffer: Buffer;
  meta: { windowDays: number; openCases: number };
}

export async function buildDashboardPdf(db: Db, days: number, user: AuthUser): Promise<DashboardPdfReport> {
  const [kpis, statusMix, riskMix, activity, topRisk, recentAlerts, openCases] = await Promise.all([
    one<{ open_cases: number; critical_cases: number; entities: number; high_risk: number; evidence: number; open_alerts: number; critical_alerts: number; traced_usd: string | null }>(
      db,
      `SELECT
         count(*) FILTER (WHERE status <> 'Closed')::int AS open_cases,
         count(*) FILTER (WHERE status <> 'Closed' AND priority = 'Critical')::int AS critical_cases,
         (SELECT count(*)::int FROM entities) AS entities,
         (SELECT count(*)::int FROM entities WHERE risk_score >= 55) AS high_risk,
         (SELECT count(*)::int FROM evidence) AS evidence,
         (SELECT count(*)::int FROM alerts WHERE state = 'open') AS open_alerts,
         (SELECT count(*)::int FROM alerts WHERE state = 'open' AND severity = 'critical') AS critical_alerts,
         (SELECT COALESCE(SUM(amount_usd),0) FROM case_entities WHERE amount_usd IS NOT NULL) AS traced_usd
       FROM cases`
    ),
    many<{ status: string; n: number }>(db, `SELECT status, count(*)::int AS n FROM cases GROUP BY status ORDER BY status`),
    many<{ priority: string; n: number }>(db, `SELECT priority, count(*)::int AS n FROM cases GROUP BY priority ORDER BY priority`),
    many<{ day: string; opened: number; closed: number }>(
      db,
      `WITH days AS (
         SELECT generate_series(date_trunc('day', now()) - ($1::int || ' days')::interval, date_trunc('day', now()), '1 day')::date AS day
       )
       SELECT d.day::text AS day,
              count(c.id) FILTER (WHERE c.opened_at::date = d.day)::int AS opened,
              count(c.id) FILTER (WHERE c.closed_at::date = d.day)::int AS closed
       FROM days d LEFT JOIN cases c ON c.opened_at::date = d.day OR c.closed_at::date = d.day
       GROUP BY d.day ORDER BY d.day`,
      [days]
    ),
    many<{ chain: string; address: string; label: string | null; kind: string; risk_score: number; risk_level: string; linked_cases: number }>(
      db,
      `SELECT e.chain, e.address, e.label, e.kind, e.risk_score, e.risk_level,
              (SELECT count(*) FROM case_entities ce WHERE ce.entity_id = e.id)::int AS linked_cases
       FROM entities e WHERE e.risk_score > 0
       ORDER BY e.risk_score DESC LIMIT 15`
    ),
    many<{ severity: string; category: string; title: string; created_at: string; case_ref: string | null }>(
      db,
      `SELECT a.severity, a.category, a.title, a.created_at, c.case_ref
       FROM alerts a LEFT JOIN cases c ON c.id = a.case_id
       WHERE a.state IN ('open','acknowledged') ORDER BY a.created_at DESC LIMIT 25`
    ),
    many<{ case_ref: string; title: string; chain: string; status: string; priority: string; opened_at: string }>(
      db,
      `SELECT case_ref, title, chain, status, priority, opened_at FROM cases
       WHERE status <> 'Closed'
       ORDER BY CASE priority WHEN 'Critical' THEN 0 WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 WHEN 'Low' THEN 3 ELSE 4 END,
                opened_at
       LIMIT 40`
    )
  ]);

  const pdf = new PdfBuilder();
  const now = new Date();
  const opened = activity.reduce((sum, d) => sum + d.opened, 0);
  const closed = activity.reduce((sum, d) => sum + d.closed, 0);

  pdf.text("CryptoTrace AI", { size: 20, bold: true, color: COLORS.heading });
  pdf.text("Portfolio Summary", { size: 13, color: COLORS.muted, gapBefore: 2 });
  pdf.rule(10);

  pdf.text(`Reporting window: ${days} days`, { size: 15, bold: true });
  pdf.text(`Generated: ${fmt(now.toISOString())} by ${user.email} (${user.role})`, {
    size: 9.5,
    color: COLORS.muted,
    gapBefore: 6
  });

  pdf.rule(8);
  pdf.text("Reading this summary", { size: 11, bold: true, gapBefore: 4 });
  pdf.text(
    "This is a portfolio view, not a finding about any case or party. Counts describe what is recorded in this system at the moment of generation; scores are triage signals from configurable rules. No figure here identifies a person or establishes that any law was broken.",
    { size: 9, color: COLORS.muted, gapBefore: 4 }
  );

  section(pdf, "1. Portfolio position");
  // Mirrors the UI's `usd()`: a null *and* a zero are both "we do not know the
  // amount", and printing USD 0.00 would read as a measurement.
  const tracedUsd = Number(kpis?.traced_usd ?? 0);
  const priced = Number.isFinite(tracedUsd) && tracedUsd > 0;
  const lines: [string, string][] = [
    ["Open investigations", `${kpis?.open_cases ?? 0} (${kpis?.critical_cases ?? 0} at Critical priority)`],
    ["Monitored entities", `${kpis?.entities ?? 0} (${kpis?.high_risk ?? 0} scoring 55 or above)`],
    ["Open alerts", `${kpis?.open_alerts ?? 0} (${kpis?.critical_alerts ?? 0} at critical severity)`],
    ["Evidence items on file", `${kpis?.evidence ?? 0}, each sealed with a SHA-256 digest`],
    ["Cases opened in window", `${opened}`],
    ["Cases closed in window", `${closed}`],
    [
      "Traced value attributed to entities",
      priced ? `USD ${tracedUsd.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : "not priced (no price feed configured)"
    ]
  ];
  for (const [label, value] of lines) {
    pdf.text(`${label}: ${value}`, { size: 9.5, gapBefore: 3 });
  }
  if (!priced) {
    pdf.text(
      "Value totals are withheld rather than estimated. A partial figure carried into a summary reads as a complete one.",
      { size: 9, color: COLORS.warn, gapBefore: 4 }
    );
  }

  section(pdf, "2. Case register (open)");
  if (openCases.length) {
    for (const c of openCases) {
      pdf.text(`${c.case_ref} - ${c.title}`, { size: 9.5, bold: true, gapBefore: 5 });
      pdf.text(`${c.chain} | Status ${c.status} | Priority ${c.priority} | Opened ${fmt(c.opened_at)}`, {
        size: 8.5,
        color: COLORS.muted,
        gapBefore: 1
      });
    }
    if ((kpis?.open_cases ?? 0) > openCases.length) {
      pdf.text(`List truncated at ${openCases.length} of ${kpis?.open_cases} open cases.`, {
        size: 9,
        color: COLORS.warn,
        gapBefore: 4
      });
    }
  } else {
    empty(pdf, "No open investigations.");
  }

  section(pdf, "3. Cases by status and priority");
  if (statusMix.length || riskMix.length) {
    pdf.text(`Status: ${statusMix.map((s) => `${s.status} ${s.n}`).join(", ") || "none"}`, { size: 9.5, gapBefore: 3 });
    pdf.text(`Priority: ${riskMix.map((r) => `${r.priority} ${r.n}`).join(", ") || "none"}`, { size: 9.5, gapBefore: 2 });
  } else {
    empty(pdf, "No cases recorded.");
  }

  section(pdf, "4. Highest-scoring entities");
  if (topRisk.length) {
    for (const e of topRisk) {
      pdf.text(`${shortAddr(e.address)} (${e.chain})`, { size: 9.5, bold: true, gapBefore: 5 });
      pdf.text(
        `${e.label ?? e.kind} | Risk ${e.risk_score}/100 (${e.risk_level}) | Linked to ${e.linked_cases} case${e.linked_cases === 1 ? "" : "s"}`,
        { size: 8.5, color: COLORS.muted, gapBefore: 1 }
      );
    }
    pdf.text(
      `Thresholds in effect: Critical ${DEFAULT_THRESHOLDS.critical}, High ${DEFAULT_THRESHOLDS.high}, Medium ${DEFAULT_THRESHOLDS.medium}, Low ${DEFAULT_THRESHOLDS.low}. A score ranks review priority; it is not a determination of wrongdoing.`,
      { size: 9, color: COLORS.muted, gapBefore: 5 }
    );
  } else {
    empty(pdf, "No entities have been scored yet.");
  }

  section(pdf, "5. Alerts awaiting triage");
  if (recentAlerts.length) {
    for (const a of recentAlerts) {
      pdf.text(`${fmt(a.created_at)}  [${a.severity}] ${a.title}`, { size: 9, gapBefore: 3 });
      pdf.text(`${a.category}${a.case_ref ? ` | ${a.case_ref}` : ""}`, {
        size: 8.5,
        color: COLORS.muted,
        indent: 10,
        gapBefore: 1
      });
    }
  } else {
    empty(pdf, "No open or acknowledged alerts.");
  }

  section(pdf, "6. Methodology and limitations");
  for (const m of METHODOLOGY) {
    pdf.text(`- ${m}`, { size: 9, gapBefore: 3 });
  }

  pdf.rule(10);
  pdf.text(
    `Generated by CryptoTrace AI at ${fmt(now.toISOString())} for ${user.email} (${user.role}). ` +
      "This is a portfolio-level summary of case and alert counts and risk scores in effect during the window. " +
      "A score ranks review priority; it is not a determination of wrongdoing. Corroborate independently before " +
      "relying on it in any legal, regulatory or disciplinary process.",
    { size: 8, color: COLORS.muted }
  );

  const buffer = pdf.finish(`Portfolio summary (${days}d)`, `CryptoTrace AI portfolio summary, ${days} day window`);
  logger.info("Portfolio summary generated", { windowDays: days, pages: pdf.pageCount, bytes: buffer.length });
  return { buffer, meta: { windowDays: days, openCases: kpis?.open_cases ?? 0 } };
}

function section(pdf: PdfBuilder, title: string): void {
  pdf.text(title, { size: 12, bold: true, color: COLORS.heading, gapBefore: 14 });
}

function empty(pdf: PdfBuilder, message: string): void {
  pdf.text(message, { size: 9, color: COLORS.muted, gapBefore: 3 });
}

function shortAddr(address: string): string {
  return address.length <= 20 ? address : `${address.slice(0, 12)}...${address.slice(-8)}`;
}

function fmt(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().replace("T", " ").slice(0, 19) + "Z";
}

/**
 * Evidence suffix for one edge line. A report is evidence: rendering a derived
 * edge in the same shape as a confirmed one would let an exported document
 * assert more than the screen does.
 */
function edgeEvidenceSuffix(edge: TraceGraph["edges"][0]): string {
  const parts: string[] = [`evidence:${edge.evidenceStatus}`];
  if (edge.tracedAmount !== null && edge.tracedAmount !== undefined && edge.tracedAmount !== "0") {
    parts.push(`traced:${edge.tracedAmount} ${edge.asset}`);
  }
  if (edge.relationship !== "direct_transfer") parts.push(edge.relationship);
  if (edge.traceMethod) parts.push(`method:${edge.traceMethod}`);
  if (edge.evidenceSource === "demo") parts.push("SIMULATED");
  if (edge.evidenceSource === "stored") parts.push("from-stored-records");
  return ` {${parts.join(" ")}}`;
}

/**
 * Render a trace graph as a text-based diagram for PDF embedding.
 * Uses a simple left-to-right layout by hop distance.
 */
function renderGraphAsText(graph: TraceGraph): string[] {
  const lines: string[] = [];
  const nodesByHop = new Map<number, TraceGraph["nodes"][0][]>();
  
  // Group nodes by hop distance
  for (const node of graph.nodes) {
    const hop = node.hopDistance;
    if (!nodesByHop.has(hop)) nodesByHop.set(hop, []);
    nodesByHop.get(hop)!.push(node);
  }
  
  const sortedHops = [...nodesByHop.keys()].sort((a, b) => a - b);
  
  lines.push("Graph structure (left-to-right = hop distance):");
  lines.push("");
  
  // For each hop, show nodes and edges
  for (const hop of sortedHops) {
    const nodes = nodesByHop.get(hop) ?? [];
    
    lines.push(`Hop ${hop}${hop === 0 ? " (root)" : ""}:`);
    
    for (const node of nodes.slice(0, 10)) { // Limit to 10 nodes per hop
      const riskIndicator = node.riskLevel === "Critical" ? "[CRITICAL]" : 
                           node.riskLevel === "High" ? "[HIGH]" : 
                           node.riskLevel === "Medium" ? "[MED]" : 
                           node.riskLevel === "Low" ? "[LOW]" : "";
      const label = node.label ? ` (${node.label})` : "";
      const status = node.status && node.status !== "known" ? ` [${node.status.toUpperCase()}]` : "";
      const riskScore = node.riskScore ? ` risk=${node.riskScore}/100` : "";
      
      lines.push(`  ${shortAddr(node.address)}${label}${status}${riskIndicator}${riskScore}`);
      
      // Show outgoing edges from this node
      const outgoingEdges = graph.edges.filter(e => e.source.toLowerCase() === node.address.toLowerCase());
      for (const edge of outgoingEdges.slice(0, 5)) {
        const targetNode = graph.nodes.find(n => n.address.toLowerCase() === edge.target.toLowerCase());
        const targetHop = targetNode?.hopDistance ?? "?";
        const value = edge.valueUsd ? ` USD ${edge.valueUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : 
                      edge.valueNative ? ` ${edge.valueNative} native` : "";
        const txShort = edge.txHash.length > 16 ? `${edge.txHash.slice(0, 8)}...${edge.txHash.slice(-8)}` : edge.txHash;
        lines.push(`    └─>${shortAddr(edge.target)} (hop ${targetHop})${value} [tx:${txShort}]${edgeEvidenceSuffix(edge)}`);
      }
      
      // Show incoming edges to root node (hop 0)
      if (hop === 0) {
        const incomingEdges = graph.edges.filter(e => e.target.toLowerCase() === node.address.toLowerCase());
        for (const edge of incomingEdges.slice(0, 5)) {
          const sourceNode = graph.nodes.find(n => n.address.toLowerCase() === edge.source.toLowerCase());
          const sourceHop = sourceNode?.hopDistance ?? "?";
          const value = edge.valueUsd ? ` USD ${edge.valueUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : 
                        edge.valueNative ? ` ${edge.valueNative} native` : "";
          const txShort = edge.txHash.length > 16 ? `${edge.txHash.slice(0, 8)}...${edge.txHash.slice(-8)}` : edge.txHash;
          lines.push(`    <─${shortAddr(edge.source)} (hop ${sourceHop})${value} [tx:${txShort}]${edgeEvidenceSuffix(edge)}`);
        }
      }
    }
    
    if (nodes.length > 10) {
      lines.push(`  ... and ${nodes.length - 10} more nodes at this hop`);
    }
    lines.push("");
  }
  
  // Summary stats
  lines.push(`Total: ${graph.totals.nodeCount} nodes, ${graph.totals.edgeCount} edges`);
  lines.push(`Value traced: In ${graph.totals.valueInUsd ? `USD ${graph.totals.valueInUsd.toLocaleString()}` : "N/A"}, Out ${graph.totals.valueOutUsd ? `USD ${graph.totals.valueOutUsd.toLocaleString()}` : "N/A"}`);
  
  if (graph.totals.truncated && graph.totals.truncatedReasons.length > 0) {
    lines.push("Truncated: " + graph.totals.truncatedReasons.join("; "));
  }

  if (graph.demo) {
    lines.push("");
    lines.push("SIMULATED DATA - this graph is synthetic and does not describe real funds.");
  }

  if (graph.reconciliation) {
    const r = graph.reconciliation;
    lines.push("");
    lines.push("Amount reconciliation:");
    lines.push(
      `  Quantity investigated: ${r.initialAmount ?? "all observed movement"} ${r.asset} (method: ${graph.method})`
    );
    lines.push(`  Directly observed:    ${r.directlyObserved} ${r.asset}`);
    lines.push(`  Attributed:           ${r.attributed} ${r.asset}`);
    lines.push(`  Unresolved:           ${r.unresolved} ${r.asset}`);
    lines.push(
      `  Coverage:             ${r.coverage === null ? "not applicable" : `${Math.round(r.coverage * 100)}%`} (${r.status})`
    );
    if (r.caveats.length) {
      for (const caveat of r.caveats) lines.push(`  Caveat: ${caveat}`);
    }
  }

  return lines;
}
