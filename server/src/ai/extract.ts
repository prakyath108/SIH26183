import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { badRequest } from "../middleware/error.js";
import { logger } from "../logger.js";
import { createWorker } from "tesseract.js";

/**
 * Text extraction for uploaded case documents.
 *
 * Three input families, because a case folder is rarely homogeneous: narrative
 * PDFs (filings, SARs, reports), machine exports (CSV from an explorer or an
 * analytics tool), and JSON dumps.
 *
 * Two things this deliberately does not do:
 *
 *  - **No silent truncation of the record.** Long input is clipped to a
 *    configured ceiling, but the fact that it was clipped travels with the
 *    result so the proposal can disclose it.
 *  - **OCR is best-effort.** A scanned PDF gets OCR attempted automatically.
 *    If OCR fails, the error is reported rather than passing an empty document.
 */

export const SUPPORTED_EXTENSIONS = [".pdf", ".csv", ".tsv", ".txt", ".json"] as const;

const MIME_BY_EXT: Record<string, string> = {
  ".pdf": "application/pdf",
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".txt": "text/plain",
  ".json": "application/json"
};

export function mimeForExtension(filename: string): string | null {
  return MIME_BY_EXT[extname(filename).toLowerCase()] ?? null;
}

export function isSupported(filename: string): boolean {
  return mimeForExtension(filename) !== null;
}

export interface ExtractedText {
  text: string;
  pageCount: number | null;
  charCount: number;
  /** True when the input exceeded `maxChars` and the tail was dropped. */
  truncated: boolean;
  kind: "pdf" | "csv" | "text" | "json";
  /** OCR metadata when OCR was used. */
  ocr?: {
    used: boolean;
    language: string;
    averageConfidence: number;
    pagesProcessed: number;
  };
}

/** Strip control characters and collapse runaway whitespace from decoded text. */
function normalise(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    // Keep newlines and tabs, drop the rest of C0/C1.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

export async function extractText(
  filePath: string,
  originalName: string,
  maxChars: number
): Promise<ExtractedText> {
  const ext = extname(originalName || basename(filePath)).toLowerCase();
  const kind: ExtractedText["kind"] =
    ext === ".pdf" ? "pdf" : ext === ".csv" || ext === ".tsv" ? "csv" : ext === ".json" ? "json" : "text";

  const { text: body, pageCount, ocr } =
    kind === "pdf" ? await extractPdf(filePath, maxChars) : await extractPlain(filePath, kind, maxChars);

  // The extractors already stop at the ceiling, but a PDF that lands exactly on
  // the limit is ambiguous — report truncation only when text was definitely
  // dropped, never as a false "read in full".
  const truncated = body.length >= maxChars;
  const text = truncated ? body.slice(0, maxChars) : body;

  if (!text.trim()) {
    // Almost always a scanned PDF. Saying so is far more useful than handing
    // an empty string to a summariser.
    throw badRequest(
      kind === "pdf"
        ? "No text could be extracted from this PDF. It is most likely a scan or image-only document. OCR was attempted but did not yield readable text."
        : "The document contains no readable text."
    );
  }

  return {
    text,
    pageCount,
    charCount: text.length,
    truncated,
    kind,
    ocr
  };
}

async function extractPlain(
  filePath: string,
  kind: "csv" | "text" | "json",
  maxChars: number
): Promise<{ text: string; pageCount: number | null; ocr?: ExtractedText["ocr"] }> {
  // Read past the ceiling so the truncation flag is honest even for a single
  // enormous line, which `readFile` with no length would otherwise load whole.
  const raw = await readFile(filePath, "utf8");
  const body = normalise(raw);

  if (kind === "json") return { text: prettifyJson(body, maxChars), pageCount: null, ocr: undefined };

  if (kind === "csv") {
    // Column headers carry the semantics of an export ("from","to","value"),
    // so the first rows stay adjacent to the data they describe.
    return { text: describeCsv(body), pageCount: null, ocr: undefined };
  }

  return { text: body.slice(0, maxChars), pageCount: null, ocr: undefined };
}

/**
 * Re-indent a JSON dump so the model sees structure rather than one long line.
 * A minified 2 MB array is far harder to read, and far easier to summarise
 * wrongly, than the same data spread over lines.
 */
function prettifyJson(body: string, maxChars: number): string {
  try {
    const parsed = JSON.parse(body) as unknown;
    return JSON.stringify(parsed, null, 2).slice(0, maxChars);
  } catch {
    // Not valid JSON despite the extension. Treat it as text rather than
    // failing: a truncated or concatenated export is still readable content.
    logger.warn("Upload declared as JSON did not parse; treating as text");
    return body.slice(0, maxChars);
  }
}

/**
 * Summarise a CSV's shape before its body, so the model knows what a row means
 * before it reads one. Row count and headers are facts, not inference, and they
 * stop the model from guessing at column semantics.
 */
function describeCsv(body: string): string {
  const lines = body.split("\n");
  const header = lines[0] ?? "";
  const delimiter = header.includes("\t") && !header.includes(",") ? "\t" : ",";
  const columns = header.split(delimiter).map((c) => c.trim()).filter(Boolean);
  const preview = lines.slice(1, 21).join("\n");

  return [
    `CSV export. ${lines.length > 1 ? lines.length - 1 : 0} data rows.`,
    `Columns (${columns.length}): ${columns.join(", ")}`,
    "",
    "First 20 data rows:",
    preview
  ].join("\n");
}

/**
 * PDF text via unpdf (pdf.js under a Node-friendly wrapper).
 *
 * With `mergePages: false` the result is `{ totalPages, text[] }` — one string
 * per page — which is what makes page numbers available in the provenance
 * markers below. `pdf-parse` was not used because its CommonJS entry runs a
 * debug harness against a bundled test PDF when imported from ESM.
 *
 * If no text layer is found, OCR is attempted automatically using Tesseract.js.
 * The OCR result includes confidence metrics so the reviewer can assess quality.
 */
async function extractPdf(
  filePath: string,
  maxChars: number
): Promise<{ text: string; pageCount: number | null; ocr?: ExtractedText["ocr"] }> {
  const { extractText: pdfExtractText, getDocumentProxy } = await import("unpdf");

  const buffer = await readFile(filePath);
  const document = await getDocumentProxy(new Uint8Array(buffer));

  try {
    const { totalPages, text: pages } = await pdfExtractText(document, { mergePages: false });

    // Check if any text was actually extracted
    const hasText = pages.some((p) => p && p.trim().length > 0);

    if (!hasText) {
      // No text layer — attempt OCR
      logger.info("No text layer found in PDF, attempting OCR", { filePath, totalPages });
      const ocrResult = await extractPdfOcr(buffer, totalPages, maxChars);
      return ocrResult;
    }

    const parts: string[] = [];
    let used = 0;
    for (let i = 0; i < pages.length; i += 1) {
      const pageText = pages[i] ?? "";
      const block = `[page ${i + 1}/${totalPages}]\n${pageText.trim()}`;
      if (used + block.length > maxChars) {
        // Keep as much of this page as the budget allows, then stop. Dropping
        // the page marker entirely would leave unattributable text.
        parts.push(block.slice(0, Math.max(0, maxChars - used)));
        break;
      }
      parts.push(block);
      used += block.length;
    }
    return { text: normalise(parts.join("\n\n")), pageCount: totalPages };
  } finally {
    // pdf.js holds parsed page resources in memory. `cleanup()` is the only
    // teardown on PDFDocumentProxy — `destroy()` lives on the loading task,
    // which getDocumentProxy does not hand back — and without this a
    // long-lived server accumulates one page tree per upload.
    await document.cleanup().catch(() => undefined);
  }
}

/**
 * OCR extraction for scanned/image-only PDFs using Tesseract.js.
 * Tesseract.js v7 returns a single Page object for the entire PDF
 * containing combined text from all pages.
 */
async function extractPdfOcr(
  pdfBuffer: Buffer,
  totalPages: number,
  maxChars: number
): Promise<{ text: string; pageCount: number; ocr: ExtractedText["ocr"] }> {
  const worker = await createWorker("eng");

  try {
    // Tesseract.js v7 returns a single Page object for the entire PDF
    // containing combined text from all pages
    const { data: page } = await worker.recognize(pdfBuffer);

    const pageText = page.text?.trim() ?? "";
    const confidence = page.confidence ?? 0;
    const blocks = page.blocks ?? [];

    // Calculate average confidence from blocks if available
    let totalConfidence = confidence;
    if (blocks.length > 0) {
      const blockConfidences = blocks.map((b) => b.confidence).filter((c) => c != null && c > 0);
      if (blockConfidences.length > 0) {
        totalConfidence = blockConfidences.reduce((a, b) => a + b, 0) / blockConfidences.length;
      }
    }

    if (!pageText) {
      throw new Error("OCR completed but no text was extracted from any page");
    }

    // Add page markers for provenance
    const parts: string[] = [];
    const block = `[page 1-${totalPages}/${totalPages}] (OCR confidence: ${totalConfidence.toFixed(1)}%)\n${pageText}`;
    if (block.length > maxChars) {
      parts.push(block.slice(0, maxChars));
    } else {
      parts.push(block);
    }

    return {
      text: normalise(parts.join("\n\n")),
      pageCount: totalPages,
      ocr: {
        used: true,
        language: "eng",
        averageConfidence: totalConfidence,
        pagesProcessed: 1
      }
    };
  } finally {
    await worker.terminate();
  }
}

/** Streaming sha256 of a file already on disk. */
export async function sha256File(filePath: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest("hex");
}
