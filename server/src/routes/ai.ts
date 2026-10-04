import { Router, type Request, type Response } from "express";
import multer from "multer";
import { z } from "zod";
import { mkdir, unlink, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { asyncRoute, badRequest, conflict, notFound } from "../middleware/error.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { audit } from "../middleware/audit.js";
import { getDb, many, one } from "../db/index.js";
import { env } from "../config.js";
import { logger } from "../logger.js";
import { dataDir, uploadsDir } from "../paths.js";
import { sha256Json } from "../security.js";
import { detect, adapterFor } from "../chains/index.js";
import { trace } from "../trace/tracer.js";
import { isAiAvailable, callStructured } from "../ai/client.js";
import { extractText, isSupported, mimeForExtension, sha256File, SUPPORTED_EXTENSIONS } from "../ai/extract.js";
import { executeTool } from "../ai/toolExecutor.js";
import { isWorkerRunning } from "../worker/index.js";
import { caseEventBus } from "../status/events.js";
import {
  PROMPT_VERSION,
  SYSTEM_PROMPT,
  buildExtractionPrompt,
  proposalSchema,
  type CaseProposal,
  TRACE_PLAN_SYSTEM_PROMPT,
  buildTracePlanPrompt,
  tracePlanSchema,
  type TracePlan
} from "../ai/prompts.js";
import { answerSchema, buildChatPrompt, CHAT_SYSTEM_PROMPT, chatMessageSchema } from "../ai/chat.js";
import { toolSchemas, type ToolName, getToolDefinitions } from "../ai/tools.js";
import type { Chain } from "../types.js";

/**
 * AI-assisted case intake.
 *
 * The contract this module enforces, and the reason it is shaped the way it is:
 *
 *   A model reads a document. A model proposes. A human decides. The system writes.
 *
 * Nothing here calls the model and writes to `cases`, `entities` or `traces` in
 * the same request. `analyze` persists a proposal and stops. `apply` performs
 * every write, in one audited step, from the subset of indicators a human
 * ticked. If that separation is ever collapsed, an unreviewed number or
 * identifier reaches a case file under an audit trail that implies a human
 * accepted it.
 *
 * Risk scoring is untouched. `scoreRisk()` remains the only thing that computes
 * a score, and it runs on labels and on-chain structure after a trace — never on
 * anything the model produced.
 */

export const aiRouter = Router();
aiRouter.use(requireAuth);

/* ------------------------------------------------------------------ uploads */

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    // Created lazily on first upload so a fresh checkout does not need a
    // bootstrap step, and created per-write so a deleted directory self-heals.
    mkdir(uploadsDir, { recursive: true })
      .then(() => cb(null, uploadsDir))
      .catch((err) => cb(err as Error, uploadsDir));
  },
  filename: (_req, file, cb) => {
    // The stored name is a fresh UUID. The operator's filename is kept in the
    // database but never used as a path: it is attacker-controlled and can
    // contain separators, traversal, or collide with another upload.
    const ext = file.originalname.slice(file.originalname.lastIndexOf(".")).toLowerCase().replace(/[^a-z0-9.]/g, "");
    cb(null, `${randomUUID()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: env.AI_MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!isSupported(file.originalname)) {
      cb(
        badRequest(
          `Unsupported file type. Accepted: ${SUPPORTED_EXTENSIONS.join(", ")}.`
        )
      );
      return;
    }
    cb(null, true);
  }
});

/** True once storage is configured; surfaced so the panel can explain itself. */
aiRouter.get(
  "/status",
  asyncRoute(async (_req: Request, res: Response) => {
    res.json({
      available: isAiAvailable(),
      enabled: env.AI_ENABLED,
      hasKey: env.hasOpenAiKey,
      model: env.OPENAI_MODEL,
      // The background worker drains the auto-process and trace job queues.
      // Reported from the real lifecycle flag, not hard-coded, so a stopped
      // worker cannot make queued jobs look like they are progressing.
      workerRunning: isWorkerRunning(),
      maxUploadMb: env.AI_MAX_UPLOAD_MB,
      maxInputChars: env.AI_MAX_INPUT_CHARS,
      promptVersion: PROMPT_VERSION,
      supportedExtensions: SUPPORTED_EXTENSIONS,
      // Stated plainly so an operator is never surprised about where case
      // material goes.
      disclosure:
        "Uploaded documents are sent to the configured OpenAI model for extraction. Risk scoring is never performed by the model; scores come from the deterministic rule engine."
    });
  })
);

/** Upload a case document and extract its text. Does not call the model. */
aiRouter.post(
  "/cases/:id/documents",
  requirePermission("ai:upload"),
  (req: Request, res: Response, next: (err?: unknown) => void) => {
    upload.single("file")(req, res, (err: unknown) => {
      if (err) {
        if (err instanceof multer.MulterError) {
          if (err.code === "LIMIT_FILE_SIZE") {
            next(
              badRequest(
                `File exceeds the ${env.AI_MAX_UPLOAD_MB} MB limit. Split the document or raise AI_MAX_UPLOAD_MB.`
              )
            );
            return;
          }
          next(badRequest(`Upload failed: ${err.message}`));
          return;
        }
        next(err);
        return;
      }
      next();
    });
  },
  asyncRoute(async (req: Request, res: Response) => {
    const db = await getDb();
    const caseId = z.string().uuid().parse(req.params.id);
    const file = req.file as Express.Multer.File | undefined;
    if (!file) throw badRequest("No file was uploaded. Send one file in the 'file' field.");

    // Extraction failing must not leave an orphan row or a file on disk with
    // no record of it, so the row is only written once the text exists.
    let extracted;
    try {
      extracted = await extractText(file.path, file.originalname, env.AI_MAX_INPUT_CHARS);
    } catch (err) {
      await unlink(file.path).catch(() => undefined);
      throw err;
    }

    const caseRow = await one<{ case_ref: string }>(db, `SELECT case_ref FROM cases WHERE id = $1`, [caseId]);
    if (!caseRow) {
      await unlink(file.path).catch(() => undefined);
      throw notFound("Case not found");
    }

    const digest = await sha256File(file.path);
    const size = (await stat(file.path)).size;
    const mime = mimeForExtension(file.originalname) ?? file.mimetype;

    // The same bytes uploaded twice to one case is a no-op. Re-uploading
    // evidence should not be able to quietly multiply it in the register.
    const existing = await one<{ id: string; status: string; extracted_text: string | null }>(
      db,
      `SELECT id, status, extracted_text FROM documents WHERE case_id = $1 AND sha256 = $2`,
      [caseId, digest]
    );
    if (existing) {
      await unlink(file.path).catch(() => undefined);
      res.status(200).json({
        document: {
          id: existing.id,
          filename: file.originalname,
          sha256: digest,
          byteSize: size,
          status: existing.status,
          charCount: existing.extracted_text?.length ?? null
        },
        duplicate: true,
        message: "This exact file is already attached to the case."
      });
      return;
    }

    const row = await one<{ id: string; created_at: string }>(
      db,
      `INSERT INTO documents (case_id, filename, mime, byte_size, sha256, storage_path,
        page_count, char_count, status, extracted_text, uploaded_by,
        ocr_used, ocr_language, ocr_average_confidence, ocr_pages_processed)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'extracted',$9,$10,$11,$12,$13,$14) RETURNING id, created_at`,
      [
        caseId,
        file.originalname,
        mime,
        size,
        digest,
        // Store the path relative to the data directory, never an absolute one:
        // an absolute path makes the row meaningless in a container and breaks
        // if the volume is mounted elsewhere.
        join("uploads", file.filename),
        extracted.pageCount,
        extracted.charCount,
        extracted.text,
        req.user!.id,
        extracted.ocr?.used ?? false,
        extracted.ocr?.language ?? null,
        extracted.ocr?.averageConfidence ?? null,
        extracted.ocr?.pagesProcessed ?? null
      ]
    );

    if (!row) {
      await unlink(file.path).catch(() => undefined);
      throw new Error("Document record failed to persist after the file was written");
    }

    await audit(db, {
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      action: "document.upload",
      entityType: "document",
      entityId: row.id,
      caseRef: caseRow.case_ref,
      after: {
        filename: file.originalname,
        mime,
        byteSize: size,
        sha256: digest,
        pageCount: extracted.pageCount,
        charCount: extracted.charCount,
        truncated: extracted.truncated,
        kind: extracted.kind,
        ocr: extracted.ocr
      },
      req
    });

    logger.info("Document uploaded", {
      caseRef: caseRow.case_ref,
      chars: extracted.charCount,
      truncated: extracted.truncated,
      ocrUsed: extracted.ocr?.used ?? false
    });

    // Records the document against the case and extracts its text. Does not move
    // the status: a case stays Open until something actually processes it.
    await caseEventBus.documentUploaded(caseId, req.user!.id, { documentId: String(row.id), filename: file.originalname });
    await caseEventBus.textExtracted(caseId, req.user!.id, {
      documentId: String(row.id),
      charCount: extracted.charCount
    });

    res.status(201).json({
      document: {
        id: row.id,
        filename: file.originalname,
        mime,
        byteSize: size,
        sha256: digest,
        pageCount: extracted.pageCount,
        charCount: extracted.charCount,
        truncated: extracted.truncated,
        kind: extracted.kind,
        ocr: extracted.ocr,
        status: "extracted",
        createdAt: row.created_at
      },
      duplicate: false
    });
  })
);

aiRouter.get(
  "/cases/:id/documents",
  requirePermission("ai:read"),
  asyncRoute(async (req: Request, res: Response) => {
    const db = await getDb();
    const caseId = z.string().uuid().parse(req.params.id);
    const rows = await many<{
      id: string;
      filename: string;
      mime: string;
      byte_size: number;
      sha256: string;
      page_count: number | null;
      char_count: number | null;
      status: string;
      error: string | null;
      created_at: string;
      analyzed_at: string | null;
      uploaded_by_name: string | null;
    }>(
      db,
      `SELECT d.id, d.filename, d.mime, d.byte_size, d.sha256, d.page_count, d.char_count, d.status,
              d.error, d.created_at, d.analyzed_at, u.display_name AS uploaded_by_name
       FROM documents d LEFT JOIN users u ON u.id = d.uploaded_by
       WHERE d.case_id = $1 ORDER BY d.created_at DESC`,
      [caseId]
    );
    const documents = rows.map(r => ({
      id: r.id,
      filename: r.filename,
      mime: r.mime,
      byteSize: r.byte_size,
      sha256: r.sha256,
      pageCount: r.page_count,
      charCount: r.char_count,
      status: r.status,
      error: r.error,
      createdAt: r.created_at,
      analyzedAt: r.analyzed_at,
      uploadedByName: r.uploaded_by_name
    }));
    res.json({ documents });
  })
);

/**
 * The extracted text, or a slice of it. Separate from the list so the list stays
 * small: a 60k-character body per row would make this endpoint useless.
 */
aiRouter.get(
  "/documents/:id",
  requirePermission("ai:read"),
  asyncRoute(async (req: Request, res: Response) => {
    const db = await getDb();
    const id = z.string().uuid().parse(req.params.id);
    const q = z
      .object({ maxChars: z.coerce.number().int().min(200).max(200_000).default(20_000), offset: z.coerce.number().int().min(0).default(0) })
      .parse(req.query);

    const doc = await one<{ extracted_text: string | null; char_count: number | null }>(
      db,
      `SELECT extracted_text, char_count FROM documents WHERE id = $1`,
      [id]
    );
    if (!doc) throw notFound("Document not found");
    const full = doc.extracted_text ?? "";
    const slice = full.slice(q.offset, q.offset + q.maxChars);
    res.json({
      text: slice,
      charCount: full.length,
      offset: q.offset,
      hasMore: q.offset + slice.length < full.length
    });
  })
);

/** Download the original bytes, so a reviewer can see what was actually read. */
aiRouter.get(
  "/documents/:id/original",
  requirePermission("ai:read"),
  asyncRoute(async (req: Request, res: Response) => {
    const db = await getDb();
    const id = z.string().uuid().parse(req.params.id);
    const doc = await one<{ storage_path: string; filename: string; mime: string; case_id: string }>(
      db,
      `SELECT storage_path, filename, mime, case_id FROM documents WHERE id = $1`,
      [id]
    );
    if (!doc) throw notFound("Document not found");

    // Re-resolve against the data dir and confirm containment. storage_path is
    // written by the server today, but a stored path is still a path and this
    // is the difference between serving a file and serving the whole disk.
    const resolved = join(dataDir, doc.storage_path);
    if (!resolved.startsWith(uploadsDir)) {
      throw badRequest("Stored document path is outside the upload directory.");
    }

    const caseRow = await one<{ case_ref: string }>(db, `SELECT case_ref FROM cases WHERE id = $1`, [doc.case_id]);
    await audit(db, {
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      action: "document.download",
      entityType: "document",
      entityId: id,
      caseRef: caseRow?.case_ref ?? null,
      req
    });

    const { createReadStream } = await import("node:fs");
    res.setHeader("Content-Type", doc.mime);
    // Quoted, and stripped of anything that could break out of the header.
    const safe = doc.filename.replace(/["\\\r\n]/g, "_");
    res.setHeader("Content-Disposition", `attachment; filename="${safe}"`);
    createReadStream(resolved).pipe(res);
  })
);

/* ---------------------------------------------------------------- analysis */

aiRouter.post(
  "/documents/:id/analyze",
  requirePermission("ai:upload"),
  asyncRoute(async (req: Request, res: Response) => {
    const db = await getDb();
    const id = z.string().uuid().parse(req.params.id);

    const doc = await one<{
      id: string;
      case_id: string;
      filename: string;
      status: string;
      extracted_text: string | null;
      char_count: number | null;
      page_count: number | null;
    }>(db, `SELECT id, case_id, filename, status, extracted_text, char_count, page_count FROM documents WHERE id = $1`, [id]);
    if (!doc) throw notFound("Document not found");
    if (!doc.extracted_text?.trim()) {
      throw badRequest("This document has no extracted text to analyse. Re-upload it or attach a text-bearing PDF, CSV or JSON export.");
    }

    const caseRow = await one<{ case_ref: string; title: string; description: string | null; chain: string | null }>(
      db,
      `SELECT case_ref, title, description, chain FROM cases WHERE id = $1`,
      [doc.case_id]
    );
    if (!caseRow) throw notFound("Case not found");

    // A second analysis of the same bytes under the same prompt would produce
    // the same proposal; blocking it keeps the review queue honest.
    const open = await one<{ id: string }>(
      db,
      `SELECT id FROM ai_proposals WHERE document_id = $1 AND status = 'pending'`,
      [id]
    );
    if (open) {
      throw conflict("This document already has a proposal awaiting review.");
    }

    const truncated = (doc.char_count ?? 0) >= env.AI_MAX_INPUT_CHARS;
    const prompt = buildExtractionPrompt({
      filename: doc.filename,
      kind: doc.filename.split(".").pop()?.toLowerCase() ?? "text",
      pageCount: doc.page_count,
      charCount: doc.char_count ?? doc.extracted_text.length,
      truncated,
      caseRef: caseRow.case_ref,
      existingCase: { title: caseRow.title, description: caseRow.description, chain: caseRow.chain },
      text: doc.extracted_text
    });

    // Processing has begun, so the case is no longer merely Open.
    await caseEventBus.aiAnalysisStarted(doc.case_id, req.user!.id, id);

    const proposal = await callStructured<CaseProposal>({
      label: "case_document_extraction",
      system: SYSTEM_PROMPT,
      user: prompt,
      schema: proposalSchema,
      maxOutputTokens: 8_000
    });

    const validated = await validateIndicators(proposal);

    const stored = await one<{ id: string; created_at: string }>(
      db,
      `INSERT INTO ai_proposals (case_id, document_id, proposal, model, prompt_version, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, created_at`,
      [doc.case_id, id, JSON.stringify(validated.proposal), env.OPENAI_MODEL, PROMPT_VERSION, req.user!.id]
    );

    await db.query(`UPDATE documents SET status = 'analyzed', analyzed_at = now() WHERE id = $1`, [id]);

    if (!stored) throw new Error("Proposal record failed to persist after analysis completed");

    // Extraction is finished; the case moves to In Progress and waits for a
    // reviewer to decide which of the model's indicators to keep.
    await caseEventBus.aiAnalysisCompleted(doc.case_id, req.user!.id, stored.id, proposal.indicators?.length);

    await audit(db, {
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      action: "ai.analyze",
      entityType: "ai_proposal",
      entityId: stored.id,
      caseRef: caseRow.case_ref,
      after: {
        documentId: id,
        model: env.OPENAI_MODEL,
        promptVersion: PROMPT_VERSION,
        inputChars: doc.char_count,
        truncated,
        indicatorsReturned: proposal.indicators.length,
        indicatorsAcceptedByServer: validated.proposal.indicators.length,
        rejected: validated.rejected
      },
      req
    });

    res.status(201).json({
      proposal: stored,
      // Only the counters and the rejected list — the reviewer is deciding
      // about indicators, not about the model's bookkeeping.
      summary: {
        indicators: validated.proposal.indicators.length,
        rejectedIndicators: validated.rejected,
        namedParties: proposal.entities.length,
        hypotheses: proposal.hypotheses.length
      }
    });
  })
);

/**
 * Server-side validation of what the model returned.
 *
 * Every identifier is re-detected with the platform's own chain detection
 * (`chains/detect.ts`) rather than trusted. A model asked to copy a string will
 * occasionally normalise, truncate or "complete" one, and a fabricated address
 * that looks plausible is worse than a dropped one — it would attach a real,
 * unrelated wallet to a case. Anything that does not detect is removed and
 * reported, so the reviewer sees the shortfall instead of a silent gap.
 */
async function validateIndicators(
  proposal: CaseProposal
): Promise<{ proposal: CaseProposal; rejected: { value: string; reason: string }[] }> {
  const rejected: { value: string; reason: string }[] = [];
  const seen = new Set<string>();
  const kept: CaseProposal["indicators"] = [];

  for (const indicator of proposal.indicators) {
    const det = detect(indicator.value);
    // `detect` is typed as possibly returning the sentinel "unknown" chain;
    // in practice it only ever resolves one of the four real chains, so treat
    // anything else as undetectable rather than persisting it.
    if (!det || !isRealChain(det.chain)) {
      rejected.push({
        value: indicator.value.slice(0, 80),
        reason: "Not a recognised address or transaction hash for any supported chain"
      });
      continue;
    }
    const key = `${det.chain}:${det.normalized.toLowerCase()}`;
    if (seen.has(key)) continue; // the same wallet listed twice in one document
    seen.add(key);

    kept.push({
      ...indicator,
      // The platform's detection wins over the model's guess, always — both for
      // the chain and for the address-versus-transaction-hash distinction.
      value: det.normalized,
      kind: det.type === "tx" ? "tx" : "address",
      chain: det.chain
    });
  }

  return { proposal: { ...proposal, indicators: kept }, rejected };
}

function isRealChain(chain: Chain): chain is Exclude<Chain, "unknown"> {
  return chain !== "unknown";
}

/* ------------------------------------------------------------------- apply */

aiRouter.get(
  "/cases/:id/proposals",
  requirePermission("ai:read"),
  asyncRoute(async (req: Request, res: Response) => {
    const db = await getDb();
    const caseId = z.string().uuid().parse(req.params.id);
    const q = z
      .object({ status: z.enum(["pending", "applied", "rejected"]).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) })
      .parse(req.query);
    const rows = await many(
      db,
      `SELECT p.id, p.document_id, p.status, p.proposal, p.model, p.prompt_version, p.accepted_indexes,
              p.applied_summary, p.trace_id, p.evidence_id, p.created_at, p.decided_at,
              d.filename, u.display_name AS created_by_name, d2.display_name AS decided_by_name
       FROM ai_proposals p
       LEFT JOIN documents d ON d.id = p.document_id
       LEFT JOIN users u ON u.id = p.created_by
       LEFT JOIN users d2 ON d2.id = p.decided_by
       WHERE p.case_id = $1 ${q.status ? "AND p.status = $2" : ""}
       ORDER BY p.created_at DESC LIMIT ${q.status ? "$3" : "$2"}`,
      q.status ? [caseId, q.status, q.limit] : [caseId, q.limit]
    );
    res.json({ proposals: rows });
  })
);

/**
 * Apply an approved proposal.
 *
 * `acceptedIndexes` is the reviewer's decision, sent from the UI. It is the only
 * input that decides what gets written: whatever the model proposed, only the
 * ticked rows are created, and each one is re-validated by `detect()` before it
 * can be persisted.
 *
 * Restricted to `ai:apply` (admin, investigator) rather than `case:write`,
 * because this writes more than a case field — it creates entities, runs a
 * trace against live chain endpoints, and seals evidence.
 */
aiRouter.post(
  "/proposals/:id/apply",
  requirePermission("ai:apply"),
  asyncRoute(async (req: Request, res: Response) => {
    const db = await getDb();
    const id = z.string().uuid().parse(req.params.id);
    const body = z
      .object({
        acceptedIndexes: z.array(z.number().int().min(0)).max(200).default([]),
        applyCaseFields: z.boolean().default(false),
        runTraces: z.boolean().default(true),
        maxHops: z.coerce.number().int().min(1).max(6).default(2),
        traceSubjects: z
          .array(z.number().int().min(0))
          .max(10)
          .default([])
          .describe("Indexes of subject indicators to trace. Empty means trace every accepted subject.")
      })
      .parse(req.body ?? {});

    const row = await one<{
      id: string;
      case_id: string;
      document_id: string | null;
      status: string;
      proposal: unknown;
      prompt_version: string;
    }>(db, `SELECT id, case_id, document_id, status, proposal, prompt_version FROM ai_proposals WHERE id = $1`, [id]);
    if (!row) throw notFound("Proposal not found");
    // Re-applying would re-run live traces and re-seal evidence. Once-only.
    if (row.status !== "pending") {
      throw conflict(`This proposal was already ${row.status}. Apply is single-use so it cannot duplicate evidence.`);
    }

    const caseRow = await one<{ case_ref: string; title: string; chain: string | null }>(
      db,
      `SELECT case_ref, title, chain FROM cases WHERE id = $1`,
      [row.case_id]
    );
    if (!caseRow) throw notFound("Case not found");

    const proposal = row.proposal as CaseProposal;
    const accepted = new Set(body.acceptedIndexes);

    // Re-validate at the moment of writing. The list was validated at analysis
    // time; a proposal row could have been created by an earlier code path.
    const { proposal: clean, rejected } = await validateIndicators(proposal);
    const indicators = clean.indicators.filter((_, i) => accepted.has(i));

    if (body.acceptedIndexes.length > 0 && indicators.length === 0) {
      throw badRequest(
        "None of the selected indicators is a valid address or transaction hash for a supported chain, so nothing was written."
      );
    }

    // Emit event for status engine
    await caseEventBus.aiApplyStarted(row.case_id, req.user!.id, id);

    /* ------------------------------------------------- writes, all audited */
    const created: { address: string; chain: string; entityId: string }[] = [];
    const createdTx: { txHash: string; chain: string; transactionId: string }[] = [];
    const skipped: { value: string; reason: string }[] = [...rejected];

    // The index space the reviewer ticked is the accepted list, not the model's
    // original, so traceSubjects (which the UI sends against that same list)
    // stays aligned. Validation runs before the filter so an undetectable value
    // cannot shift the mapping.
    const subjectIndexes = body.runTraces
      ? body.traceSubjects.length
        ? new Set(body.traceSubjects)
        : new Set(indicators.map((ind, i) => (ind.role === "subject" ? i : -1)).filter((i) => i >= 0))
      : new Set<number>();

    /* --------------------------------------------------------------- traces */
    // Deliberately before the transaction. A trace calls out to live chain
    // endpoints and can take tens of seconds; holding a write transaction open
    // across that would pin locks for the duration of someone else's uptime.
    // trace() persists its own trace row, so this ordering costs at most a
    // standalone trace row if the write transaction below then fails — which
    // is a read-only artefact, not a half-applied approval.
    const traceResults: {
      address: string;
      traceId: string | null;
      nodes: number;
      edges: number;
      riskScore: number;
      riskLevel: string;
      truncated: string[];
    }[] = [];
    const traceFailed: { address: string; reason: string }[] = [];

    for (const localIndex of subjectIndexes) {
      const indicator = indicators[localIndex];
      if (!indicator) continue;
      const det = detect(indicator.value);
      if (!det || !isRealChain(det.chain)) continue;
      if (det.type === "tx") {
        // Recorded here rather than in the trace-failure list, because a hash
        // in the subject slot is a reviewer choice, not a failure.
        traceFailed.push({ address: det.normalized, reason: "This is a transaction hash, not an address, so it cannot be a trace root" });
        continue;
      }
      try {
        const graph = await trace(db, {
          chain: det.chain,
          rootAddress: det.normalized,
          maxHops: body.maxHops,
          persistCaseId: row.case_id,
          userId: req.user!.id
        });
        traceResults.push({
          address: det.normalized,
          traceId: graph.traceId ?? null,
          nodes: graph.totals.nodeCount,
          edges: graph.totals.edgeCount,
          riskScore: graph.riskScore,
          riskLevel: graph.riskLevel,
          truncated: graph.totals.truncatedReasons
        });
      } catch (err) {
        // A chain endpoint being down is not a reason to discard the entities
        // the investigator just approved. Record and continue.
        const reason = err instanceof Error ? err.message : String(err);
        logger.warn("Trace from AI-approved subject failed", { address: det.normalized, reason });
        traceFailed.push({ address: det.normalized, reason });
      }
    }

    /* ---------------------------------------- one transaction for every write
     * Everything the approval persists — entities, transaction links, case
     * fields, the sealed evidence row, the hypothesis note, the audit entry and
     * the proposal's own status flip — lands together or not at all. The
     * single-use guard above is re-asserted inside the transaction via
     * `status = 'pending'`, so two concurrent applies cannot both write.
     */
    const hypotheses = clean.hypotheses.filter((h) => h.text.trim().length > 0);

    await db.transaction(async (tx) => {
      const claimed = await one<{ id: string }>(
        tx,
        `UPDATE ai_proposals SET status = 'applying' WHERE id = $1 AND status = 'pending' RETURNING id`,
        [row.id]
      );
      if (!claimed) {
        throw conflict("This proposal was already claimed by another reviewer and is no longer pending.");
      }

      for (let i = 0; i < indicators.length; i += 1) {
        const indicator = indicators[i];
        if (!indicator) continue;
        const det = detect(indicator.value);
        if (!det || !isRealChain(det.chain)) {
          skipped.push({ value: indicator.value.slice(0, 80), reason: "Rejected by server-side detection" });
          continue;
        }
        const chain = det.chain;
        const value = det.normalized.toLowerCase();
        const note = indicator.excerpt
          ? `${indicator.role}${indicator.label ? ` — ${indicator.label}` : ""}: ${indicator.excerpt}`
          : indicator.role;

        if (det.type === "tx") {
          // A transaction hash is not a wallet. Persisting one in `entities`
          // would show it in the entity register as if it were an address, and
          // `entities` is what tracing and counterparty logic iterate over.
          // Transactions get their own table and the case link through
          // case_transactions, which is also what the transaction view reads.
          const txRow = await one<{ id: string }>(
            tx,
            `INSERT INTO transactions (chain, tx_hash, status)
             VALUES ($1,$2,'unverified')
             ON CONFLICT (chain, tx_hash) DO UPDATE SET chain = EXCLUDED.chain
             RETURNING id`,
            [chain, value]
          );
          if (!txRow) throw new Error("Transaction upsert failed");
          await tx.query(
            `INSERT INTO case_transactions (case_id, transaction_id) VALUES ($1,$2)
             ON CONFLICT (case_id, transaction_id) DO NOTHING`,
            [row.case_id, txRow.id]
          );
          createdTx.push({ txHash: value, chain, transactionId: txRow.id });
          continue;
        }

        // Same upsert the manual "attach entity" path uses (cases.ts), so an
        // AI-attached wallet is indistinguishable in the register from a
        // hand-entered one. Note the ON CONFLICT deliberately leaves `kind`
        // alone: a role guessed from a document must not downgrade a kind the
        // tracer already established from real chain data.
        const ent = await one<{ id: string }>(
          tx,
          `INSERT INTO entities (chain, address, kind) VALUES ($1,$2,$3)
           ON CONFLICT (chain, address) DO UPDATE SET updated_at = now() RETURNING id`,
          [chain, value, entityKindFor(indicator.role)]
        );
        if (!ent) throw new Error("Entity upsert failed");

        await tx.query(
          `INSERT INTO case_entities (case_id, entity_id, hop_count, note) VALUES ($1,$2,0,$3)
           ON CONFLICT (case_id, entity_id) DO UPDATE SET note = EXCLUDED.note`,
          [row.case_id, ent.id, note]
        );
        created.push({ address: value, chain, entityId: ent.id });
      }

      /* -------------------------------------------- optional case field patch */
      if (body.applyCaseFields) {
        const patch: string[] = [];
        const params: (string | null)[] = [];
        const title = clean.caseFields.title?.trim();
        const description = clean.caseFields.description?.trim();
        const priority = clean.caseFields.priority?.trim();
        if (title && title.length >= 3) {
          params.push(title);
          patch.push(`title = $${params.length}`);
        }
        if (description) {
          params.push(description);
          patch.push(`description = $${params.length}`);
        }
        if (priority) {
          // The model is triaging a document, not setting a real-world response
          // level, so only a value the schema itself allows may be written.
          const allowed = ["Low", "Medium", "High", "Critical"];
          if (allowed.includes(priority)) {
            params.push(priority);
            patch.push(`priority = $${params.length}`);
          } else {
            logger.warn("Discarded out-of-range AI case priority", { priority });
          }
        }
        if (patch.length) {
          params.push(row.case_id);
          await tx.query(`UPDATE cases SET ${patch.join(", ")} WHERE id = $${params.length}`, params);
        }
      }

      /* ---------------------------------------------------- seal the document */
      // The file becomes evidence in its own right, hashed over an envelope that
      // records the bytes we read and the model that read them.
      let evidenceId: string | null = null;
      if (row.document_id) {
        const doc = await one<{ filename: string; sha256: string; byte_size: number; mime: string; storage_path: string }>(
          tx,
          `SELECT filename, sha256, byte_size, mime, storage_path FROM documents WHERE id = $1`,
          [row.document_id]
        );
        if (doc) {
          const envelope = {
            data: {
              filename: doc.filename,
              sha256: doc.sha256,
              byteSize: doc.byte_size,
              mime: doc.mime,
              storagePath: doc.storage_path
            },
            provenance: {
              collectedBy: req.user!.email,
              collectedAt: new Date().toISOString(),
              method: "ai-assisted document intake",
              model: env.OPENAI_MODEL,
              promptVersion: row.prompt_version,
              proposalId: row.id,
              note: "The document bytes are held under the path above. This digest is over the stored metadata envelope; the file's own SHA-256 is listed as sha256."
            }
          };
          const digest = sha256Json(envelope);
          const ev = await one<{ id: string }>(
            tx,
            `INSERT INTO evidence (case_id, kind, title, description, content, content_sha256, collected_by)
             VALUES ($1,'attachment',$2,$3,$4,$5,$6) RETURNING id`,
            [
              row.case_id,
              `Source document: ${doc.filename}`,
              clean.summary.slice(0, 4000),
              JSON.stringify(envelope),
              digest,
              req.user!.id
            ]
          );
          if (ev) evidenceId = ev.id;
        }
      }

      /* ------------------------------------------- pinned hypothesis note */
      if (hypotheses.length) {
        const noteBody = [
          `Machine-extracted leads from "${clean.summary.slice(0, 400)}"`,
          "",
          ...hypotheses.map((h, i) => `${i + 1}. ${h.text}\n   Basis: ${h.basis}`)
        ].join("\n");
        await tx.query(
          `INSERT INTO case_notes (case_id, author_id, body, kind, pinned) VALUES ($1,$2,$3,'hypothesis',TRUE)`,
          [row.case_id, req.user!.id, noteBody]
        );
      }

      const summary = {
        entitiesCreated: created.length,
        transactionsCreated: createdTx.length,
        indicatorsSkipped: skipped,
        traces: traceResults,
        tracesFailed: traceFailed,
        caseFieldsApplied: body.applyCaseFields,
        hypothesesAdded: hypotheses.length,
        evidenceId
      };

      await tx.query(
        `UPDATE ai_proposals
            SET status = 'applied', accepted_indexes = $2, applied_summary = $3,
                trace_id = $4, evidence_id = $5, decided_by = $6, decided_at = now()
          WHERE id = $1`,
        [row.id, [...accepted], JSON.stringify(summary), traceResults[0]?.traceId ?? null, evidenceId, req.user!.id]
      );

      await audit(tx, {
        actorId: req.user!.id,
        actorEmail: req.user!.email,
        action: "ai.proposal_apply",
        entityType: "ai_proposal",
        entityId: row.id,
        caseRef: caseRow.case_ref,
        after: {
          model: env.OPENAI_MODEL,
          promptVersion: row.prompt_version,
          acceptedCount: indicators.length,
          entitiesCreated: created.length,
          transactionsCreated: createdTx.length,
          tracesRun: traceResults.length,
          tracesFailed: traceFailed.length,
          evidenceId,
          caseFieldsApplied: body.applyCaseFields
        },
        req
      });
    });

    const applied = {
      entitiesCreated: created.length,
      transactionsCreated: createdTx.length,
      indicatorsSkipped: skipped,
      traces: traceResults,
      tracesFailed: traceFailed,
      caseFieldsApplied: body.applyCaseFields,
      hypothesesAdded: hypotheses.length
    };

    res.json({ applied, created, transactions: createdTx, proposalId: row.id });

    // Emit event for status engine
    await caseEventBus.aiApplyCompleted(row.case_id, req.user!.id, row.id);
  })
);


aiRouter.post(
  "/proposals/:id/reject",
  requirePermission("ai:apply"),
  asyncRoute(async (req: Request, res: Response) => {
    const db = await getDb();
    const id = z.string().uuid().parse(req.params.id);
    const body = z.object({ reason: z.string().max(1000).optional() }).parse(req.body ?? {});
    const row = await one<{ case_id: string; status: string }>(db, `SELECT case_id, status FROM ai_proposals WHERE id = $1`, [id]);
    if (!row) throw notFound("Proposal not found");
    if (row.status !== "pending") throw conflict(`This proposal was already ${row.status}.`);

    await db.query(`UPDATE ai_proposals SET status = 'rejected', decided_by = $2, decided_at = now() WHERE id = $1`, [id, req.user!.id]);
    await audit(db, {
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      action: "ai.proposal_reject",
      entityType: "ai_proposal",
      entityId: id,
      after: { reason: body.reason ?? null },
      req
    });
    res.json({ rejected: true });
  })
);

/** Map a model-supplied role onto the platform's entity vocabulary. */
function entityKindFor(role: string): string {
  switch (role) {
    case "exchange":
      return "exchange";
    case "mixer":
      return "mixer";
    case "bridge":
      return "bridge";
    default:
      return "unknown";
  }
}

/* -------------------------------------------------------------- case chat */

const chatSchema = z.object({
  question: z.string().min(3).max(2000),
  documentIds: z.array(z.string().uuid()).max(5).default([]),
  history: z.array(chatMessageSchema).max(20).default([])
});

/**
 * Answer a question about a case, grounded in the case's own data.
 *
 * The context is assembled server-side from the database rather than sent by
 * the client, so the model can only see rows the requesting user is already
 * entitled to, and cannot be steered into reading arbitrary tables.
 */
aiRouter.post(
  "/cases/:id/ask",
  requirePermission("ai:read"),
  asyncRoute(async (req: Request, res: Response) => {
    const db = await getDb();
    const caseId = z.string().uuid().parse(req.params.id);
    const body = chatSchema.parse(req.body ?? {});

    const context = await buildCaseContext(db, caseId, body.documentIds);
    if (!context) throw notFound("Case not found");

    // Build tool definitions for this case
    const toolDefs = getToolDefinitions();
    
    // Create a system prompt that includes tool usage instructions
    const toolSystemPrompt = CHAT_SYSTEM_PROMPT + `

AVAILABLE TOOLS:
You have access to the following tools to investigate this case. Use them when you need specific data that isn't in the provided context.

${toolDefs.map(t => `- ${t.function.name}: ${t.function.description}`).join('\n')}

When you need to use a tool, call it with the appropriate arguments. The results will be returned to you. You can chain multiple tool calls together to build a complete answer.

IMPORTANT: The caseId for all tools is: ${caseId}. Do not ask the user for it - it's already known.
`;

    // Tool-calling loop
    const messages: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string; tool_call_id?: string; name?: string }> = [
      { role: "system", content: toolSystemPrompt },
      { role: "user", content: buildChatPrompt({ question: body.question, context, history: body.history }) }
    ];

    const maxRounds = 6;
    let finalAnswer: unknown = null;

    for (let round = 0; round < maxRounds; round++) {
      const response = await callStructured({
        label: "case_question_answer",
        system: toolSystemPrompt,
        user: messages.slice(1).map(m => `${m.role}: ${m.content}`).join("\n\n") || "Continue.",
        schema: z.object({
          // First, let the model decide if it needs tools or can answer directly
          needsTools: z.boolean(),
          toolCalls: z.array(z.object({
            name: z.string(),
            arguments: z.record(z.unknown())
          })).optional(),
          answer: answerSchema.optional()
        }).describe("Response indicating whether tools are needed and what to call"),
        maxOutputTokens: 2_000
      });

      if (!response.needsTools && response.answer) {
        finalAnswer = response.answer;
        break;
      }

      if (response.toolCalls && response.toolCalls.length > 0) {
        // Execute each tool call
        for (const toolCall of response.toolCalls) {
          const toolName = toolCall.name as ToolName;
          const args = toolCall.arguments;
          
          try {
            const result = await executeTool(db, caseId, req.user!.id, toolName, args);
            messages.push({
              role: "tool",
              content: JSON.stringify(result),
              tool_call_id: `call_${round}_${toolName}`,
              name: toolName
            });
          } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            messages.push({
              role: "tool",
              content: JSON.stringify({ error }),
              tool_call_id: `call_${round}_${toolName}`,
              name: toolName
            });
          }
        }
      } else {
        // No tools needed but no answer either - continue
        messages.push({
          role: "user",
          content: "Please provide your answer or call the necessary tools."
        });
      }
    }

    if (!finalAnswer) {
      // One final attempt to get answer without tools
      const response = await callStructured({
        label: "case_question_answer",
        system: CHAT_SYSTEM_PROMPT,
        user: buildChatPrompt({ question: body.question, context, history: body.history }),
        schema: answerSchema,
        maxOutputTokens: 2_000
      });
      finalAnswer = response;
    }

    const answer = finalAnswer as z.infer<typeof answerSchema>;

    const caseRow = await one<{ case_ref: string }>(db, `SELECT case_ref FROM cases WHERE id = $1`, [caseId]);
    await audit(db, {
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      action: "ai.ask",
      entityType: "case",
      entityId: caseId,
      caseRef: caseRow?.case_ref ?? null,
      after: { question: body.question.slice(0, 500), model: env.OPENAI_MODEL, documents: body.documentIds.length, historyLength: body.history.length },
      req
    });

    res.json({ answer });
  })
);

/**
 * Assemble the grounding context. Bounded on purpose: a case with 300 entities
 * would blow the context window and cost more than it is worth, so the
 * highest-signal rows are taken and the total is stated so the model can say
 * when it is looking at a subset.
 */
async function buildCaseContext(
  db: Awaited<ReturnType<typeof getDb>>,
  caseId: string,
  documentIds: string[]
): Promise<string | null> {
  const c = await one<Record<string, unknown>>(
    db,
    `SELECT id, case_ref, title, description, status::text AS status, priority::text AS priority,
            chain, opened_at, closed_at, closure_note
     FROM cases WHERE id = $1`,
    [caseId]
  );
  if (!c) return null;

  const [entities, alerts, notes, labels, evidence, traces] = await Promise.all([
    many(
      db,
      `SELECT e.chain, e.address, e.kind, e.label, e.risk_score, e.risk_level, e.tx_count, e.risk_factors, ce.hop_count, ce.note
       FROM case_entities ce JOIN entities e ON e.id = ce.entity_id
       WHERE ce.case_id = $1 ORDER BY e.risk_score DESC LIMIT 60`,
      [caseId]
    ),
    many(
      db,
      `SELECT severity::text, state::text, category, title, detail, created_at FROM alerts
       WHERE case_id = $1 ORDER BY created_at DESC LIMIT 30`,
      [caseId]
    ),
    many(
      db,
      `SELECT n.kind, n.body, n.pinned, n.created_at, u.display_name AS author
       FROM case_notes n LEFT JOIN users u ON u.id = n.author_id
       WHERE n.case_id = $1 ORDER BY n.created_at DESC LIMIT 30`,
      [caseId]
    ),
    many(
      db,
      `SELECT DISTINCT l.chain, l.address, l.kind, l.name, l.source, l.confidence, l.note
       FROM labels l
       JOIN case_entities ce ON ce.entity_id = (SELECT id FROM entities WHERE chain = l.chain AND address = l.address)
       WHERE ce.case_id = $1 AND l.status = 'active' LIMIT 60`,
      [caseId]
    ),
    many(
      db,
      `SELECT kind, title, description, address, tx_hash, content_sha256, collected_at
       FROM evidence WHERE case_id = $1 ORDER BY collected_at DESC LIMIT 30`,
      [caseId]
    ),
    many(
      db,
      `SELECT chain, root_address, max_hops, direction, node_count, edge_count, risk_score, risk_level, created_at
       FROM traces WHERE case_id = $1 ORDER BY created_at DESC LIMIT 10`,
      [caseId]
    )
  ]);

  // Only the text of documents the analyst explicitly attached to the question.
  const docs = documentIds.length
    ? await many<{ filename: string; extracted_text: string | null }>(
        db,
        `SELECT filename, extracted_text FROM documents WHERE id = ANY($1::uuid[]) AND case_id = $2`,
        [documentIds, caseId]
      )
    : [];

  const sections: string[] = [
    "CASE",
    JSON.stringify(c, null, 2),
    `\nENTITIES (up to 60, highest risk first; total linked: see count)`,
    JSON.stringify(entities, null, 2),
    `\nACTIVE LABELS ON THOSE ENTITIES`,
    JSON.stringify(labels, null, 2),
    `\nALERTS (up to 30)`,
    JSON.stringify(alerts, null, 2),
    `\nNOTES (up to 30)`,
    JSON.stringify(notes, null, 2),
    `\nEVIDENCE (up to 30)`,
    JSON.stringify(evidence, null, 2),
    `\nTRACES (up to 10)`,
    JSON.stringify(traces, null, 2)
  ];

  // AI_MAX_INPUT_CHARS is a per-document ceiling, but the provider sees the sum
  // of the case data plus every selected document. Give documents a shared
  // budget and say so in the prompt when it runs out, so a five-document
  // question degrades into a clearly-labelled partial answer instead of a 400
  // from the provider.
  const docBudget = env.AI_MAX_INPUT_CHARS;
  let remaining = docBudget;
  const included: string[] = [];
  const omitted: string[] = [];

  for (const doc of docs) {
    const text = doc.extracted_text ?? "";
    if (!text.trim()) {
      omitted.push(`${doc.filename} (no extracted text)`);
      continue;
    }
    if (remaining <= 0) {
      omitted.push(`${doc.filename} (document budget exhausted)`);
      continue;
    }
    const slice = text.slice(0, remaining);
    const clipped = slice.length < text.length;
    remaining -= slice.length;
    included.push(
      `\nDOCUMENT "${doc.filename}" (${slice.length} characters${clipped ? ", TRUNCATED" : ""})`,
      slice
    );
  }

  sections.push(...included);

  if (omitted.length) {
    sections.push(
      `\nDOCUMENTS REQUESTED BUT NOT INCLUDED: ${omitted.join("; ")}. ` +
        "A question that depends on them cannot be answered — report insufficientData rather than guessing."
    );
  }

  sections.push(
    "\nNOTE: entity, alert, note, evidence and trace lists above are capped. If the question needs something beyond the cap, say so in insufficientData rather than inferring it."
  );

  return sections.join("\n");
}

/* ----------------------------------------------------------------- trace plan */

/**
 * Generate a trace plan from an applied proposal.
 * The plan is returned for investigator review before execution.
 */
aiRouter.post(
  "/proposals/:id/trace-plan",
  requirePermission("ai:apply"),
  asyncRoute(async (req: Request, res: Response) => {
    const db = await getDb();
    const id = z.string().uuid().parse(req.params.id);

    const row = await one<{
      id: string;
      case_id: string;
      proposal: unknown;
      prompt_version: string;
      status: string;
    }>(db, `SELECT id, case_id, proposal, prompt_version, status FROM ai_proposals WHERE id = $1`, [id]);
    if (!row) throw notFound("Proposal not found");
    if (row.status !== "applied") {
      throw conflict("Trace plans can only be generated for applied proposals.");
    }

    const caseRow = await one<{ case_ref: string; title: string; chain: string | null }>(
      db,
      `SELECT case_ref, title, chain FROM cases WHERE id = $1`,
      [row.case_id]
    );
    if (!caseRow) throw notFound("Case not found");

    const proposal = row.proposal as CaseProposal;

    const plan = await callStructured<TracePlan>({
      label: "trace_plan_generation",
      system: TRACE_PLAN_SYSTEM_PROMPT,
      user: buildTracePlanPrompt({
        caseRef: caseRow.case_ref,
        proposal,
        existingCase: { title: caseRow.title, description: null, chain: caseRow.chain }
      }),
      schema: tracePlanSchema,
      maxOutputTokens: 4_096
    });

    // Store the trace plan for review
    const stored = await one<{ id: string }>(
      db,
      `INSERT INTO trace_plans (proposal_id, case_id, plan, created_by)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [row.id, row.case_id, JSON.stringify(plan), req.user!.id]
    );

    await audit(db, {
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      action: "trace_plan.create",
      entityType: "trace_plan",
      entityId: stored?.id ?? null,
      caseRef: caseRow.case_ref,
      after: { proposalId: row.id, primarySubject: plan.primarySubject?.value ?? null },
      req
    });

    res.status(201).json({ tracePlan: plan, tracePlanId: stored?.id });
  })
);

/**
 * Get trace plans for a case.
 */
aiRouter.get(
  "/cases/:id/trace-plans",
  requirePermission("ai:read"),
  asyncRoute(async (req: Request, res: Response) => {
    const db = await getDb();
    const caseId = z.string().uuid().parse(req.params.id);
    const rows = await many(
      db,
      `SELECT tp.id, tp.plan, tp.status, tp.created_at, tp.executed_at,
              u.display_name AS created_by_name, p.filename
       FROM trace_plans tp
       LEFT JOIN ai_proposals p ON p.id = tp.proposal_id
       LEFT JOIN documents d ON d.id = p.document_id
       LEFT JOIN users u ON u.id = tp.created_by
       WHERE tp.case_id = $1 ORDER BY tp.created_at DESC`,
      [caseId]
    );
    res.json({ tracePlans: rows });
  })
);

/**
 * Execute an approved trace plan.
 * Runs the trace and stores the resulting graph.
 */
aiRouter.post(
  "/trace-plans/:id/execute",
  requirePermission("ai:apply"),
  asyncRoute(async (req: Request, res: Response) => {
    const db = await getDb();
    const id = z.string().uuid().parse(req.params.id);

    const row = await one<{
      id: string;
      case_id: string;
      proposal_id: string;
      plan: unknown;
      status: string;
    }>(db, `SELECT id, case_id, proposal_id, plan, status FROM trace_plans WHERE id = $1`, [id]);
    if (!row) throw notFound("Trace plan not found");
    if (row.status !== "pending") {
      throw conflict(`This trace plan was already ${row.status}.`);
    }

    const caseRow = await one<{ case_ref: string }>(db, `SELECT case_ref FROM cases WHERE id = $1`, [row.case_id]);
    if (!caseRow) throw notFound("Case not found");

    const plan = row.plan as TracePlan;

    // Determine subjects to trace
    const subjects: { value: string; chain: Chain; kind: "address" | "tx" }[] = [];
    if (plan.primarySubject) {
      subjects.push({
        value: plan.primarySubject.value,
        chain: plan.primarySubject.chain,
        kind: plan.primarySubject.kind
      });
    }
    for (const sub of plan.additionalSubjects) {
      subjects.push({ value: sub.value, chain: sub.chain, kind: sub.kind });
    }

    if (subjects.length === 0) {
      throw badRequest("This trace plan has no subjects to trace.");
    }

    // One queued job per subject. The worker runs the traces, so a slow trace
    // no longer holds the HTTP request open, and the plan is only marked
    // executed once the last job settles (see traceJobHandler.onSettled).
    const queuedJobIds: string[] = [];
    const rejected: { address: string; reason: string }[] = [];

    for (const subject of subjects) {
      const det = detect(subject.value);
      if (!det || det.type !== "address") {
        rejected.push({ address: subject.value, reason: "Not a valid address for tracing" });
        continue;
      }

      const created = await one<{ id: string }>(
        db,
        `INSERT INTO trace_jobs (case_id, trace_plan_id, chain, root_address, max_hops, direction, max_nodes, max_edges, status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'queued',$9) RETURNING id`,
        [
          row.case_id,
          row.id,
          det.chain,
          det.normalized,
          plan.maxHops,
          plan.direction,
          plan.maxNodes ?? 120,
          plan.maxEdges ?? 150,
          req.user!.id
        ]
      );
      if (created) queuedJobIds.push(created.id);
    }

    if (queuedJobIds.length === 0) {
      throw badRequest("None of the plan's subjects is a valid address to trace.");
    }

    // Mark plan as executing
    await db.query(
      `UPDATE trace_plans SET status = 'executing' WHERE id = $1 AND status = 'pending'`,
      [id]
    );

    await audit(db, {
      actorId: req.user!.id,
      actorEmail: req.user!.email,
      action: "trace_plan.execute",
      entityType: "trace_plan",
      entityId: id,
      caseRef: caseRow.case_ref,
      after: {
        queuedJobs: queuedJobIds.length,
        rejectedSubjects: rejected,
        traceJobIds: queuedJobIds
      },
      req
    });

    res.status(202).json({
      queued: queuedJobIds.length,
      traceJobIds: queuedJobIds,
      tracePlanId: id,
      rejectedSubjects: rejected,
      status: "executing"
    });
  })
);

/**
 * Get trace job status and progress.
 */
aiRouter.get(
  "/trace-jobs/:id",
  requirePermission("ai:read"),
  asyncRoute(async (req: Request, res: Response) => {
    const db = await getDb();
    const id = z.string().uuid().parse(req.params.id);

    const job = await one<{
      id: string;
      case_id: string;
      trace_plan_id: string | null;
      chain: string;
      root_address: string;
      max_hops: number;
      direction: string;
      max_nodes: number;
      max_edges: number;
      status: string;
      progress: unknown;
      result_trace_id: string | null;
      error: string | null;
      started_at: string | null;
      completed_at: string | null;
      created_at: string;
    }>(db, `SELECT * FROM trace_jobs WHERE id = $1`, [id]);
    if (!job) throw notFound("Trace job not found");

    // Get snapshots for this job
    const snapshots = await many<{
      id: string;
      snapshot_type: string;
      node_count: number;
      edge_count: number;
      risk_score: number;
      risk_level: string;
      description: string | null;
      created_at: string;
    }>(
      db,
      `SELECT id, snapshot_type, node_count, edge_count, risk_score, risk_level, description, created_at
       FROM trace_snapshots WHERE trace_job_id = $1 ORDER BY created_at`,
      [id]
    );

    res.json({ job, snapshots });
  })
);

/**
 * List trace jobs for a case.
 */
aiRouter.get(
  "/cases/:id/trace-jobs",
  requirePermission("ai:read"),
  asyncRoute(async (req: Request, res: Response) => {
    const db = await getDb();
    const caseId = z.string().uuid().parse(req.params.id);
    const q = z.object({ status: z.enum(["queued","running","partial","completed","failed","cancelled"]).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(req.query);

    const clauses = q.status ? "AND status = $3" : "";
    const params = q.status ? [caseId, q.limit, q.status] : [caseId, q.limit];

    const jobs = await many<{
      id: string;
      trace_plan_id: string | null;
      chain: string;
      root_address: string;
      max_hops: number;
      direction: string;
      max_nodes: number;
      max_edges: number;
      status: string;
      progress: unknown;
      result_trace_id: string | null;
      error: string | null;
      started_at: string | null;
      completed_at: string | null;
      created_at: string;
    }>(
      db,
      `SELECT id, trace_plan_id, chain, root_address, max_hops, direction, max_nodes, max_edges, status, progress, result_trace_id, error, started_at, completed_at, created_at
       FROM trace_jobs WHERE case_id = $1 ${clauses}
       ORDER BY created_at DESC LIMIT $${q.status ? 3 : 2}`,
      params
    );

    res.json({ jobs });
  })
);

/* ------------------------------------------------------------------ AI tool execution */

/**
 * Execute an AI tool call.
 * The AI calls this endpoint with a tool name and arguments; the server
 * executes the tool against the database and returns structured results.
 * This is the controlled tool interface — the AI never gets raw DB access.
 */
aiRouter.post(
  "/cases/:id/tools/execute",
  requirePermission("ai:read"),
  asyncRoute(async (req: Request, res: Response) => {
    const db = await getDb();
    const caseId = z.string().uuid().parse(req.params.id);

    const body = z.object({
      tool: z.enum([
        "lookup_address",
        "lookup_transaction",
        "trace_address",
        "get_case_entities",
        "get_case_transactions",
        "get_case_alerts",
        "get_case_evidence",
        "get_case_notes",
        "get_case_traces",
        "search_entities",
        "explain_node",
        "explain_path"
      ]),
      arguments: z.record(z.unknown())
    }).parse(req.body);

    const tool = toolSchemas[body.tool as ToolName];
    if (!tool) throw badRequest(`Unknown tool: ${body.tool}`);

    // Validate input
    const parsed = tool.inputSchema.safeParse(body.arguments);
    if (!parsed.success) {
      throw badRequest(`Invalid arguments for ${body.tool}: ${parsed.error.issues.map(i => i.message).join("; ")}`);
    }
const args = parsed.data;

    try {
      let result: unknown;

      // Use switch for clean discriminated union handling
      switch (body.tool) {
        case "lookup_address": {
          const argsTyped = args as z.infer<typeof toolSchemas.lookup_address.inputSchema>;
          const { address, chain } = argsTyped;
          if (chain) {
            const adapter = adapterFor(chain);
            const addrInfo = await adapter.getAddress(address);
            result = {
              address,
              chain,
              normalized: addrInfo.address,
              balance: addrInfo.balance?.toString() ?? null,
              txCount: addrInfo.txCount ?? null,
              firstSeen: addrInfo.firstSeen ?? null,
              lastSeen: addrInfo.lastSeen ?? null,
              riskScore: null,
              riskLevel: null,
              labels: [],
              error: null
            };
          } else {
            const chains: ("bitcoin" | "ethereum" | "tron" | "polygon")[] = ["bitcoin", "ethereum", "tron", "polygon"];
            let found = false;
            for (const c of chains) {
              try {
                const adapter = adapterFor(c);
                const addrInfo = await adapter.getAddress(address);
                if (addrInfo.address) {
                  result = {
                    address,
                    chain: c,
                    normalized: addrInfo.address,
                    balance: addrInfo.balance?.toString() ?? null,
                    txCount: addrInfo.txCount ?? null,
                    firstSeen: addrInfo.firstSeen ?? null,
                    lastSeen: addrInfo.lastSeen ?? null,
                    riskScore: null,
                    riskLevel: null,
                    labels: [],
                    error: null
                  };
                  found = true;
                  break;
                }
              } catch {
                // Try next chain
              }
            }
            if (!found) {
              result = {
                address,
                chain: "bitcoin",
                normalized: address,
                balance: null,
                txCount: null,
                firstSeen: null,
                lastSeen: null,
                riskScore: null,
                riskLevel: null,
                labels: [],
                error: "Address not found on any supported chain"
              };
            }
          }
          break;
        }

        case "lookup_transaction": {
          const argsTyped = args as z.infer<typeof toolSchemas.lookup_transaction.inputSchema>;
          const { txHash, chain } = argsTyped;
          if (chain) {
            const adapter = adapterFor(chain);
            const tx = await adapter.getTransaction(txHash);
            if (!tx) {
              result = { error: "Transaction not found", chain, txHash, ...emptyTx() };
            } else {
              result = {
                txHash: tx.txHash,
                chain: tx.chain,
                blockHeight: tx.blockHeight,
                timestamp: tx.timestamp,
                from: tx.from,
                to: tx.to,
                valueNative: tx.valueNative,
                valueUsd: tx.valueUsd,
                status: tx.status,
                feeNative: tx.feeNative,
                transfers: tx.transfers?.map(t => ({
                  kind: t.kind,
                  asset: t.asset,
                  from: t.from,
                  to: t.to,
                  amount: t.amount,
                  decimals: t.decimals,
                  contract: t.contract
                })) ?? [],
                error: null
              };
            }
          } else {
            const chains: ("bitcoin" | "ethereum" | "tron" | "polygon")[] = ["bitcoin", "ethereum", "tron", "polygon"];
            let found = false;
            for (const c of chains) {
              try {
                const adapter = adapterFor(c);
                const tx = await adapter.getTransaction(txHash);
                if (tx) {
                  result = {
                    txHash: tx.txHash,
                    chain: tx.chain,
                    blockHeight: tx.blockHeight,
                    timestamp: tx.timestamp,
                    from: tx.from,
                    to: tx.to,
                    valueNative: tx.valueNative,
                    valueUsd: tx.valueUsd,
                    status: tx.status,
                    feeNative: tx.feeNative,
                    transfers: tx.transfers?.map(t => ({
                      kind: t.kind,
                      asset: t.asset,
                      from: t.from,
                      to: t.to,
                      amount: t.amount,
                      decimals: t.decimals,
                      contract: t.contract
                    })) ?? [],
                    error: null
                  };
                  found = true;
                  break;
                }
              } catch {
                // Try next chain
              }
            }
            if (!found) {
              result = { error: "Transaction not found on any supported chain", chain: "bitcoin", txHash, ...emptyTx() };
            }
          }
          break;
        }

case "trace_address": {
          const argsTyped = args as z.infer<typeof toolSchemas.trace_address.inputSchema>;
          const graph = await trace(db, {
            chain: argsTyped.chain,
            rootAddress: argsTyped.address,
            direction: argsTyped.direction,
            amountToTrace: argsTyped.amountToTrace ?? null,
            asset: argsTyped.asset,
            method: argsTyped.method,
            maxHops: argsTyped.maxHops,
            maxNodes: argsTyped.maxNodes ?? 120,
            maxEdges: argsTyped.maxEdges ?? 150,
            offline: argsTyped.offline,
            maxCounterpartiesPerTx: argsTyped.maxCounterpartiesPerTx,
            persistCaseId: caseId,
            userId: req.user!.id
          });
          result = { graph, error: null };
          break;
        }

        case "get_case_entities": {
          const entities = await many(db,
            `SELECT e.id, e.chain, e.address, e.kind, e.label, e.risk_score, e.risk_level,
                    e.first_seen, e.last_seen, ce.hop_count, ce.amount_usd
             FROM case_entities ce JOIN entities e ON e.id = ce.entity_id
             WHERE ce.case_id = $1 ORDER BY e.risk_score DESC`,
            [caseId]
          );
          result = { entities, error: null };
          break;
        }

        case "get_case_transactions": {
          const argsTyped = args as z.infer<typeof toolSchemas.get_case_transactions.inputSchema>;
          const transactions = await many(db,
            `SELECT t.tx_hash, t.chain, t.block_height, t.timestamp, t.from_address, t.to_address,
                    t.value_native, t.value_usd, t.status
             FROM transactions t
             JOIN case_transactions ct ON ct.transaction_id = t.id
             WHERE ct.case_id = $1 ORDER BY t.timestamp DESC LIMIT $2`,
            [caseId, argsTyped.limit ?? 200]
          );
          result = { transactions, error: null };
          break;
        }

        case "get_case_alerts": {
          const alerts = await many(db,
            `SELECT a.id, a.severity, a.category, a.title, a.detail, a.created_at,
                    e.address AS entity_address, e.chain AS entity_chain, a.risk_score
             FROM alerts a LEFT JOIN entities e ON e.id = a.entity_id
             WHERE a.case_id = $1 ORDER BY a.created_at DESC`,
            [caseId]
          );
          result = { alerts, error: null };
          break;
        }

        case "get_case_evidence": {
          const evidence = await many(db,
            `SELECT id, kind, title, description, content_sha256, collected_at,
                    address, tx_hash
             FROM evidence WHERE case_id = $1 ORDER BY collected_at DESC`,
            [caseId]
          );
          result = { evidence, error: null };
          break;
        }

        case "get_case_notes": {
          const argsTyped = args as z.infer<typeof toolSchemas.get_case_notes.inputSchema>;
          let query = `SELECT n.id, n.body, n.kind, n.pinned, n.created_at, u.display_name AS author
                       FROM case_notes n LEFT JOIN users u ON u.id = n.author_id
                       WHERE n.case_id = $1`;
          const params: (string | string[])[] = [caseId];
          if (argsTyped.kind) {
            query += ` AND n.kind = $2`;
            params.push(argsTyped.kind);
          }
          query += ` ORDER BY n.created_at DESC`;
          const notes = await many(db, query, params);
          result = { notes, error: null };
          break;
        }

        case "get_case_traces": {
          const traces = await many(db,
            `SELECT id, chain, root_address, max_hops, direction, node_count, edge_count,
                    risk_score, risk_level, created_at
             FROM traces WHERE case_id = $1 ORDER BY created_at DESC`,
            [caseId]
          );
          result = { traces, error: null };
          break;
        }

        case "search_entities": {
          const argsTyped = args as z.infer<typeof toolSchemas.search_entities.inputSchema>;
          const entities = await many(db,
            `SELECT id, chain, address, kind, label, risk_score, risk_level
             FROM entities
             WHERE (address ILIKE $1 OR label ILIKE $1)
               ${argsTyped.chain ? "AND chain = $2" : ""}
             ORDER BY risk_score DESC LIMIT $${argsTyped.chain ? 3 : 2}`,
            argsTyped.chain
              ? [`%${argsTyped.query}%`, argsTyped.chain, argsTyped.limit]
              : [`%${argsTyped.query}%`, argsTyped.limit]
          );
          result = { entities, error: null };
          break;
        }

        case "explain_node": {
          const argsTyped = args as z.infer<typeof toolSchemas.explain_node.inputSchema>;
          const entity = await one(db,
            `SELECT e.chain, e.address, e.kind, e.label, e.risk_score, e.risk_level,
                    e.risk_factors, e.first_seen, e.last_seen, e.tx_count, ce.hop_count
             FROM case_entities ce JOIN entities e ON e.id = ce.entity_id
             WHERE ce.case_id = $1 AND e.address = $2 AND e.chain = $3`,
            [caseId, argsTyped.address.toLowerCase(), argsTyped.chain]
          );
          if (!entity) {
            result = { error: "Entity not found in this case" };
          } else {
            result = {
              address: entity.address,
              chain: entity.chain,
              hopDistance: entity.hop_count,
              riskScore: entity.risk_score,
              riskLevel: entity.risk_level,
              riskFactors: entity.risk_factors ?? [],
              source: "added_by_trace_expansion",
              evidence: [],
              status: "known",
              error: null
            };
          }
          break;
        }

        case "explain_path": {
          const argsTyped = args as z.infer<typeof toolSchemas.explain_path.inputSchema>;
          const pathResult = await explainPath(db, caseId, argsTyped.fromAddress, argsTyped.toAddress, argsTyped.chain);
          result = pathResult;
          break;
        }

        default:
          throw badRequest(`Tool ${body.tool} not implemented`);
}

      // Validate output
      const outputParsed = tool.outputSchema.safeParse(result);
      if (!outputParsed.success) {
        logger.warn("Tool output validation failed", { tool: body.tool, issues: outputParsed.error.issues });
      }

      await audit(db, {
        actorId: req.user!.id,
        actorEmail: req.user!.email,
        action: `ai.tool.${body.tool}`,
        entityType: "ai_tool",
        entityId: null,
        caseRef: (await one<{ case_ref: string }>(db, `SELECT case_ref FROM cases WHERE id = $1`, [caseId]))?.case_ref ?? null,
        after: { tool: body.tool, args, success: !outputParsed.success ? "validation_failed" : "ok" },
        req
      });

      res.json({ result });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error("Tool execution failed", { tool: body.tool, caseId, error });
      res.json({ result: { error } });
    }
  })
);

function emptyTx() {
  return {
    blockHeight: null,
    timestamp: null,
    from: null,
    to: null,
    valueNative: "0",
    valueUsd: null,
    status: "unknown",
    feeNative: null,
    transfers: []
  };
}

async function explainPath(
  db: Awaited<ReturnType<typeof getDb>>,
  caseId: string,
  fromAddress: string,
  toAddress: string,
  chain: "bitcoin" | "ethereum" | "tron" | "polygon"
): Promise<{
  path: Array<{ from: string; to: string; txHash: string; valueNative: string; valueUsd: number | null; timestamp: string | null; hop: number }>;
  totalValueUsd: number;
  hopCount: number;
  evidence: string[];
  error: string | null;
}> {
  // Get the trace graph for this case and chain
  const trace = await one<{ graph: unknown }>(
    db,
    `SELECT graph FROM traces WHERE case_id = $1 AND chain = $2 ORDER BY created_at DESC LIMIT 1`,
    [caseId, chain]
  );

  if (!trace || !trace.graph) {
    return { path: [], totalValueUsd: 0, hopCount: 0, evidence: [], error: "No trace graph found for this case and chain" };
  }

  const graph = trace.graph as {
    nodes: Array<{ id: string; address: string }>;
    edges: Array<{ source: string; target: string; txHash: string; timestamp: string | null; valueNative: string; valueUsd: number | null; hop: number }>;
  };

  // Build adjacency map
  const adj = new Map<string, typeof graph.edges>();
  for (const edge of graph.edges) {
    const list = adj.get(edge.source) ?? [];
    list.push(edge);
    adj.set(edge.source, list);
  }

  // BFS to find shortest path
  const fromLower = fromAddress.toLowerCase();
  const toLower = toAddress.toLowerCase();

  const queue: Array<{ addr: string; path: typeof graph.edges }> = [{ addr: fromLower, path: [] }];
  const visited = new Set<string>([fromLower]);

  while (queue.length > 0) {
    const { addr, path } = queue.shift()!;

    if (addr === toLower) {
      const totalValueUsd = path.reduce((sum, e) => sum + (e.valueUsd ?? 0), 0);
      return {
        path: path.map((e) => ({
          from: e.source,
          to: e.target,
          txHash: e.txHash,
          valueNative: e.valueNative,
          valueUsd: e.valueUsd,
          timestamp: e.timestamp,
          hop: e.hop
        })),
        totalValueUsd,
        hopCount: path.length,
        evidence: path.map((e) => `Transaction ${e.txHash}: ${e.valueNative} (${e.valueUsd?.toFixed(2) ?? "N/A"} USD)`),
        error: null
      };
    }

    const edges = adj.get(addr) ?? [];
    for (const edge of edges) {
      if (!visited.has(edge.target.toLowerCase())) {
        visited.add(edge.target.toLowerCase());
        queue.push({ addr: edge.target.toLowerCase(), path: [...path, edge] });
      }
    }
  }

  return { path: [], totalValueUsd: 0, hopCount: 0, evidence: [], error: `No path found from ${fromAddress} to ${toAddress} in the trace graph` };
}















