import { z } from "zod";
import { join } from "node:path";
import { one, many, type Db } from "../db/index.js";
import { env } from "../config.js";
import { logger } from "../logger.js";
import { extractText } from "../ai/extract.js";
import { callStructured, isAiAvailable } from "../ai/client.js";
import { trace } from "../trace/tracer.js";
import { detect } from "../chains/index.js";
import { sha256Json } from "../security.js";
import {
  SYSTEM_PROMPT,
  buildExtractionPrompt,
  proposalSchema,
  PROMPT_VERSION,
  type CaseProposal
} from "../ai/prompts.js";
import { buildReportPdf } from "../reports/pdf.js";
import { audit } from "../middleware/audit.js";
import { dataDir, uploadsDir } from "../paths.js";
import { type Chain, type UserRole } from "../types.js";
import type { JobHandler } from "./jobQueue.js";

const autoProcessConfigSchema = z.object({
  createCase: z.boolean().default(true),
  caseTitle: z.string().max(300).optional(),
  caseChain: z.enum(["bitcoin", "ethereum", "tron", "polygon"]).optional(),
  analyzeDocument: z.boolean().default(true),
  applyIndicators: z.boolean().default(true),
  applyCaseFields: z.boolean().default(false),
  runTraces: z.boolean().default(true),
  maxHops: z.number().int().min(1).max(6).default(2),
  generateAlerts: z.boolean().default(true),
  generatePdf: z.boolean().default(true),
  traceSubjects: z.array(z.string()).optional()
});

/**
 * Parsed at the start of `handle`, not just typed. The config is read back out
 * of a JSONB column, so it can be older than the current schema, hand-edited,
 * or written by a different caller. Trusting it unchecked meant every boolean
 * came through `undefined` and the job skipped all of its work while still
 * reporting success.
 */
const autoProcessPayloadSchema = z.object({
  documentId: z.string().uuid(),
  caseId: z.string().uuid().optional(),
  config: autoProcessConfigSchema.extend({ userId: z.string().uuid() })
});

type AutoProcessPayload = z.infer<typeof autoProcessPayloadSchema>;

function isRealChain(chain: Chain): chain is Exclude<Chain, "unknown"> {
  return chain !== "unknown";
}

function entityKindFor(role: string): string {
  switch (role) {
    case "exchange": return "exchange";
    case "mixer": return "mixer";
    case "bridge": return "bridge";
    default: return "unknown";
  }
}

async function updateProgress(db: Db, jobId: string, progress: Record<string, unknown>): Promise<void> {
  await db.query(`UPDATE auto_process_jobs SET progress = $1 WHERE id = $2`, [JSON.stringify(progress), jobId]);
}

async function validateIndicators(proposal: CaseProposal): Promise<{ proposal: CaseProposal; rejected: { value: string; reason: string }[] }> {
  const rejected: { value: string; reason: string }[] = [];
  const seen = new Set<string>();
  const kept: CaseProposal["indicators"] = [];

  for (const indicator of proposal.indicators) {
    const det = detect(indicator.value);
    if (!det || !isRealChain(det.chain)) {
      rejected.push({ value: indicator.value.slice(0, 80), reason: "Not a recognised address or transaction hash for any supported chain" });
      continue;
    }
    const key = `${det.chain}:${det.normalized.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    kept.push({
      ...indicator,
      value: det.normalized,
      kind: det.type === "tx" ? "tx" : "address",
      chain: det.chain
    });
  }

  return { proposal: { ...proposal, indicators: kept }, rejected };
}

export const autoProcessHandler: JobHandler<AutoProcessPayload> = {
  jobType: "auto_process",
  maxRetries: 2,
  pollIntervalMs: 10_000,

  async handle(jobId: string, rawPayload: AutoProcessPayload, db: Db): Promise<void> {
    const { documentId, caseId: providedCaseId, config } = autoProcessPayloadSchema.parse(rawPayload);
    const userId = config.userId;

    await updateProgress(db, jobId, { stage: "creating_case", step: 1, totalSteps: 7 });

    let caseId = providedCaseId;
    let caseRef: string;

    if (!caseId && config.createCase) {
      const caseResult = await one<{ id: string; case_ref: string }>(
        db,
        `INSERT INTO cases (case_ref, title, description, chain, status, priority, lead_investigator_id, seed_kind, seed_value, referral_source)
         VALUES (
           'CT-' || EXTRACT(YEAR FROM now()) || '-' || nextval('case_ref_seq'),
           $1, $2, $3, 'Open', 'Unrated', $4, $5, $6, $7
         ) RETURNING id, case_ref`,
        [
          config.caseTitle ?? "Auto-generated case from document",
          config.caseTitle ?? "Created automatically from uploaded document",
          config.caseChain ?? "ethereum",
          userId,
          "document",
          "auto",
          "AI auto-process"
        ]
      );
      caseId = caseResult!.id;
      caseRef = caseResult!.case_ref;

      await audit(db, {
        actorId: userId, actorEmail: "system", action: "case.create",
        entityType: "case", entityId: caseId, caseRef,
        after: { title: config.caseTitle, chain: config.caseChain, autoGenerated: true }
      });
    } else if (caseId) {
      const c = await one<{ case_ref: string }>(db, `SELECT case_ref FROM cases WHERE id = $1`, [caseId]);
      caseRef = c!.case_ref;
    } else {
      throw new Error("No caseId provided and createCase is false");
    }

    await updateProgress(db, jobId, { stage: "uploading_document", step: 2, totalSteps: 7, caseId, caseRef });

    const doc = await one<{
      id: string; filename: string; mime: string; byte_size: number; sha256: string;
      storage_path: string; page_count: number | null; char_count: number | null;
      extracted_text: string | null; status: string
    }>(db, `SELECT * FROM documents WHERE id = $1`, [documentId]);
    if (!doc) throw new Error("Document not found");

    if (doc.status === "pending" || doc.status === "extracted") {
      await updateProgress(db, jobId, { stage: "extracting_text", step: 2.5, totalSteps: 7 });

      if (!doc.extracted_text) {
        // storage_path is relative to the configured data dir, not to the
        // process cwd: the worker may be started from the repo root and
        // DATA_DIR is overridable. Confirm containment before reading, so a
        // stored path can never be used to reach outside the upload directory.
        const filePath = join(dataDir, doc.storage_path);
        if (!filePath.startsWith(uploadsDir)) {
          throw new Error("Stored document path is outside the upload directory");
        }
        const extracted = await extractText(filePath, doc.filename, env.AI_MAX_INPUT_CHARS);

        await db.query(
          `UPDATE documents SET status = 'extracted', extracted_text = $1, page_count = $2, char_count = $3, error = NULL WHERE id = $4`,
          [extracted.text, extracted.pageCount, extracted.charCount, documentId]
        );
        doc.extracted_text = extracted.text;
        doc.page_count = extracted.pageCount;
        doc.char_count = extracted.charCount;
      }
    }

    if (config.analyzeDocument && isAiAvailable()) {
      await updateProgress(db, jobId, { stage: "analyzing_document", step: 3, totalSteps: 7 });

      const caseRow = await one<{ case_ref: string; title: string; description: string | null; chain: string | null }>(
        db, `SELECT case_ref, title, description, chain FROM cases WHERE id = $1`, [caseId!]
      );

      const truncated = (doc.char_count ?? 0) >= env.AI_MAX_INPUT_CHARS;
      const prompt = buildExtractionPrompt({
        filename: doc.filename,
        kind: doc.filename.split(".").pop()?.toLowerCase() ?? "text",
        pageCount: doc.page_count,
        charCount: doc.char_count ?? doc.extracted_text?.length ?? 0,
        truncated,
        caseRef: caseRow!.case_ref,
        existingCase: { title: caseRow!.title, description: caseRow!.description, chain: caseRow!.chain },
        text: doc.extracted_text ?? ""
      });

      const proposal = await callStructured<CaseProposal>({
        label: "case_document_extraction",
        system: SYSTEM_PROMPT,
        user: prompt,
        schema: proposalSchema,
        maxOutputTokens: 8_000
      });

      const validated = await validateIndicators(proposal);

      await one(db,
        `INSERT INTO ai_proposals (case_id, document_id, proposal, model, prompt_version, created_by)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [caseId!, documentId, JSON.stringify(validated.proposal), env.OPENAI_MODEL, PROMPT_VERSION, userId]
      );

      await db.query(`UPDATE documents SET status = 'analyzed', analyzed_at = now() WHERE id = $1`, [documentId]);

      await audit(db, {
        actorId: userId, actorEmail: "system", action: "ai.analyze",
        entityType: "ai_proposal", entityId: documentId, caseRef: caseRef!,
        after: { model: env.OPENAI_MODEL, indicatorsReturned: proposal.indicators.length, indicatorsAccepted: validated.proposal.indicators.length }
      });
    }

    if (config.applyIndicators) {
      await updateProgress(db, jobId, { stage: "validating_indicators", step: 4, totalSteps: 7 });

      const proposalRow = await one<{ id: string; proposal: unknown; status: string }>(
        db, `SELECT id, proposal, status FROM ai_proposals WHERE document_id = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 1`, [documentId]
      );

      if (proposalRow && proposalRow.status === "pending") {
        const proposal = proposalRow.proposal as CaseProposal;
        const { proposal: clean, rejected } = await validateIndicators(proposal);
        const indicators = clean.indicators;

        // A rejected indicator is model output we chose not to write. That has
        // to be visible: dropping it silently makes the job look like it
        // applied everything the model proposed.
        if (rejected.length > 0) {
          logger.warn("Auto-process rejected indicators proposed by the model", {
            jobId,
            documentId,
            rejectedCount: rejected.length,
            rejected
          });
        }

        await updateProgress(db, jobId, {
          stage: "applying_indicators",
          step: 5,
          totalSteps: 7,
          indicatorsCount: indicators.length,
          indicatorsRejected: rejected
        });

        const created: { address: string; chain: string; entityId: string }[] = [];
        const createdTx: { txHash: string; chain: string; transactionId: string }[] = [];

        await db.transaction(async (tx) => {
          const claimed = await one<{ id: string }>(
            tx, `UPDATE ai_proposals SET status = 'applying' WHERE id = $1 AND status = 'pending' RETURNING id`, [proposalRow.id]
          );
          if (!claimed) throw new Error("Proposal already claimed");

          for (const indicator of indicators) {
            const det = detect(indicator.value);
            if (!det || !isRealChain(det.chain)) continue;

            if (det.type === "tx") {
              const txRow = await one<{ id: string }>(
                tx,
                `INSERT INTO transactions (chain, tx_hash, status) VALUES ($1,$2,'unverified')
                 ON CONFLICT (chain, tx_hash) DO UPDATE SET chain = EXCLUDED.chain RETURNING id`,
                [det.chain, det.normalized.toLowerCase()]
              );
              if (txRow) {
                await tx.query(
                  `INSERT INTO case_transactions (case_id, transaction_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
                  [caseId!, txRow.id]
                );
                createdTx.push({ txHash: det.normalized, chain: det.chain, transactionId: txRow.id });
              }
              continue;
            }

            const ent = await one<{ id: string }>(
              tx,
              `INSERT INTO entities (chain, address, kind) VALUES ($1,$2,$3)
               ON CONFLICT (chain, address) DO UPDATE SET updated_at = now() RETURNING id`,
              [det.chain, det.normalized.toLowerCase(), entityKindFor(indicator.role)]
            );
            if (ent) {
              await tx.query(
                `INSERT INTO case_entities (case_id, entity_id, hop_count, note) VALUES ($1,$2,0,$3)
                 ON CONFLICT (case_id, entity_id) DO UPDATE SET note = EXCLUDED.note`,
                [caseId!, ent.id, `${indicator.role}${indicator.label ? ` — ${indicator.label}` : ""}: ${indicator.excerpt}`]
              );
              created.push({ address: det.normalized.toLowerCase(), chain: det.chain, entityId: ent.id });
            }
          }

          if (config.applyCaseFields && clean.caseFields) {
            const patch: string[] = [];
            const params: (string | null)[] = [];
            if (clean.caseFields.title?.trim()) { params.push(clean.caseFields.title.trim()); patch.push(`title = $${params.length}`); }
            if (clean.caseFields.description?.trim()) { params.push(clean.caseFields.description.trim()); patch.push(`description = $${params.length}`); }
            if (clean.caseFields.priority?.trim() && ["Low", "Medium", "High", "Critical"].includes(clean.caseFields.priority.trim())) {
              params.push(clean.caseFields.priority.trim()); patch.push(`priority = $${params.length}`);
            }
            if (patch.length) { params.push(caseId!); await tx.query(`UPDATE cases SET ${patch.join(", ")} WHERE id = $${params.length}`, params); }
          }

          if (clean.hypotheses?.length) {
            const noteBody = [`Machine-extracted leads from "${clean.summary.slice(0, 400)}"`, "", ...clean.hypotheses.map((h, i) => `${i + 1}. ${h.text}\n   Basis: ${h.basis}`)].join("\n");
            await tx.query(`INSERT INTO case_notes (case_id, author_id, body, kind, pinned) VALUES ($1,$2,$3,'hypothesis',TRUE)`, [caseId!, userId, noteBody]);
          }

          await tx.query(
            `UPDATE ai_proposals SET status = 'applied', accepted_indexes = $2, decided_by = $3, decided_at = now() WHERE id = $1`,
            [proposalRow.id, JSON.stringify(indicators.map((_, i) => i)), userId]
          );

          await audit(tx, {
            actorId: userId, actorEmail: "system", action: "ai.proposal_apply",
            entityType: "ai_proposal", entityId: proposalRow.id, caseRef: caseRef!,
            after: { entitiesCreated: created.length, transactionsCreated: createdTx.length, autoApplied: true }
          });
        });
      }
    }

    if (config.runTraces) {
      await updateProgress(db, jobId, { stage: "running_traces", step: 6, totalSteps: 7 });

      const entities = await many<{ chain: Chain; address: string; id: string }>(
        db, `SELECT e.chain, e.address, e.id FROM case_entities ce JOIN entities e ON e.id = ce.entity_id WHERE ce.case_id = $1 ORDER BY e.risk_score DESC`, [caseId!]
      );

      const subjectsToTrace = config.traceSubjects?.length
        ? entities.filter(e => config.traceSubjects!.includes(e.address))
        : entities.filter(e => e.chain === (config.caseChain ?? "ethereum")).slice(0, 3);

      for (const entity of subjectsToTrace) {
        // trace_snapshots.trace_job_id is a real FK to trace_jobs, so the
        // inline trace still needs a backing job row to hang the snapshot off.
        const traceJob = await one<{ id: string }>(
          db,
          `INSERT INTO trace_jobs (case_id, chain, root_address, max_hops, direction, max_nodes, max_edges, status, created_by, started_at)
           VALUES ($1,$2,$3,$4,'both',120,150,'running',$5,now()) RETURNING id`,
          [caseId!, entity.chain, entity.address, config.maxHops, userId]
        );

        try {
          const graph = await trace(db, {
            chain: entity.chain,
            rootAddress: entity.address,
            maxHops: config.maxHops,
            direction: "both",
            persistCaseId: caseId!,
            userId
          });

          await db.query(
            `INSERT INTO trace_snapshots (trace_job_id, trace_id, snapshot_type, graph, ledger, risk_summary, node_count, edge_count, risk_score, risk_level, description, created_by)
             VALUES ($1,$2,'original',$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [
              traceJob!.id, graph.traceId ?? null, JSON.stringify(graph),
              graph.ledger ? JSON.stringify(graph.ledger) : null,
              JSON.stringify({ riskScore: graph.riskScore, riskLevel: graph.riskLevel }),
              graph.totals.nodeCount, graph.totals.edgeCount, graph.riskScore, graph.riskLevel,
              `Auto-trace from ${entity.address}`, userId
            ]
          );

          await db.query(
            `UPDATE trace_jobs SET status = 'completed', result_trace_id = $2, completed_at = now() WHERE id = $1`,
            [traceJob!.id, graph.traceId ?? null]
          );
        } catch (err) {
          logger.warn("Auto-trace failed", { address: entity.address, error: err });
          await db.query(
            `UPDATE trace_jobs SET status = 'failed', error = $2, completed_at = now() WHERE id = $1`,
            [traceJob!.id, err instanceof Error ? err.message : String(err)]
          );
        }
      }
    }

    if (config.generateAlerts) {
      await updateProgress(db, jobId, { stage: "generating_alerts", step: 7, totalSteps: 7 });

      const caseEntities = await many<{ entity_id: string; address: string; chain: Chain; risk_score: number; risk_level: string }>(
        db, `SELECT ce.entity_id, e.address, e.chain, e.risk_score, e.risk_level FROM case_entities ce JOIN entities e ON e.id = ce.entity_id WHERE ce.case_id = $1`, [caseId!]
      );

      for (const entity of caseEntities) {
        if (entity.risk_score >= 70) {
          await one(db,
            `INSERT INTO alerts (case_id, entity_id, severity, state, category, title, detail, dedupe_key)
             VALUES ($1,$2,$3,'open','risk_threshold', $4, $5, $6)
             ON CONFLICT (dedupe_key) DO NOTHING`,
            [
              caseId!, entity.entity_id,
              entity.risk_score >= 90 ? "critical" : entity.risk_score >= 80 ? "high" : "medium",
              `High risk entity detected: ${entity.address}`,
              `Entity ${entity.address} on ${entity.chain} has risk score ${entity.risk_score} (${entity.risk_level}). Auto-generated from AI pipeline.`,
              `auto-risk-${caseId}-${entity.entity_id}`
            ]
          );
        }
      }
    }

    if (config.generatePdf) {
      await updateProgress(db, jobId, { stage: "generating_pdf", step: 7.5, totalSteps: 7 });

      // Attribute the report to the real account that requested the job. The
      // PDF builder stamps the actor into the document, so passing a synthetic
      // "system" identity here would put a false author on evidence.
      const actor = await one<{ id: string; email: string; display_name: string; role: UserRole; agency: string | null }>(
        db,
        `SELECT id, email, display_name, role, agency FROM users WHERE id = $1`,
        [userId]
      );
      if (!actor) throw new Error(`Requesting user ${userId} no longer exists`);

      const pdf = await buildReportPdf(db, caseId!, {
        id: actor.id,
        email: actor.email,
        displayName: actor.display_name,
        role: actor.role,
        agency: actor.agency
      });
      if (pdf) {
        // The PDF is rendered to confirm the case is actually reportable, but
        // `evidence.content` is JSONB and the bytes are not retained. The
        // previous envelope claimed "format": "pdf", which read as though a
        // downloadable PDF existed. Record what really happened instead: the
        // report was rendered, and it was not kept.
        const generatedAt = new Date().toISOString();
        const envelope = {
          data: {
            caseRef,
            title: pdf.meta.title,
            generatedAt,
            generatedBy: "auto-process",
            reportRendered: true,
            pdfRetained: false
          },
          provenance: {
            collectedBy: userId,
            collectedAt: generatedAt,
            method: "Report rendered during auto-process to verify the case is reportable; bytes not persisted"
          }
        };
        const digest = sha256Json(envelope);
        await one(db,
          `INSERT INTO evidence (case_id, kind, title, description, content, content_sha256, collected_by)
           VALUES ($1,'report',$2,$3,$4,$5,$6)`,
          [
            caseId!,
            `Report rendered during auto-process: ${caseRef}`,
            `${pdf.meta.title} (rendered, not retained as a file)`,
            JSON.stringify(envelope),
            digest,
            userId
          ]
        );
      }
    }

    // `result` is what the job detail endpoint returns. Without it the job
    // completes but the API reports nothing about what it actually produced.
    const entityCount = await one<{ n: number }>(
      db, `SELECT count(*)::int AS n FROM case_entities WHERE case_id = $1`, [caseId!]
    );
    const alertCount = await one<{ n: number }>(
      db, `SELECT count(*)::int AS n FROM alerts WHERE case_id = $1`, [caseId!]
    );

    await db.query(
      `UPDATE auto_process_jobs SET result = $2 WHERE id = $1`,
      [
        jobId,
        JSON.stringify({
          caseId,
          caseRef,
          entitiesAdded: entityCount?.n ?? 0,
          alertsRaised: alertCount?.n ?? 0,
          config: { ...config, userId: undefined }
        })
      ]
    );

    await updateProgress(db, jobId, { stage: "completed", step: 7, totalSteps: 7, caseId, caseRef });
  }
};