/**
 * Structural check on the hand-rolled PDF writer.
 *
 * There is no PDF library to validate against, so this walks the produced file
 * the way a reader does: parse the xref table, follow every indirect reference
 * from the catalog, and confirm each page's /Contents points at a real stream
 * object with a matching /Length. The original bug — /Kids off by one and
 * /Contents self-referencing — is invisible without this.
 */
import { buildReportPdf } from "../dist/reports/pdf.js";
import { getDb } from "../dist/db/index.js";
import { migrate } from "../dist/db/migrate.js";

const db = await getDb();
await migrate();

const { rows } = await db.query(`SELECT id FROM cases ORDER BY created_at DESC LIMIT 1`);
if (!rows[0]) {
  console.error("No case to render. Run `npm run db:seed` first.");
  process.exit(2);
}

const report = await buildReportPdf(db, rows[0].id, {
  id: "00000000-0000-0000-0000-000000000000",
  email: "probe@cryptotrace.local",
  displayName: "Probe",
  role: "admin",
  agency: null
});

const buf = report.buffer;
const text = buf.toString("latin1");

let failures = 0;
const check = (ok, label, extra = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}${extra ? `  ${extra}` : ""}`);
};

check(text.startsWith("%PDF-1.4"), "header");
check(text.trimEnd().endsWith("%%EOF"), "trailer ends with %%EOF");

// --- xref ---------------------------------------------------------------
const startxref = Number(/startxref\s+(\d+)/.exec(text.slice(text.lastIndexOf("startxref")))?.[1]);
check(Number.isInteger(startxref) && startxref > 0, "startxref is a byte offset", `@${startxref}`);
check(text.slice(startxref, startxref + 4) === "xref", "startxref points at the xref table");

const xrefBody = text.slice(startxref);
const header = xrefBody.match(/^xref\s+0\s+(\d+)\s/);
check(!!header, "xref subsection header");
const size = Number(header[1]);

const entryRe = /^(\d{10}) (\d{5}) ([nf]) ?$/gm;
const entries = [];
let m;
while ((m = entryRe.exec(xrefBody)) !== null) entries.push({ off: Number(m[1]), gen: Number(m[2]), type: m[3] });
check(entries.length === size, "one xref entry per object", `${entries.length} vs ${size}`);

const objAt = (n) => {
  const e = entries[n];
  if (!e) return null;
  const body = text.slice(e.off);
  if (!body.startsWith(`${n} 0 obj`)) return null;
  return body.slice(0, body.indexOf("endobj"));
};

const badOffsets = [];
for (let n = 1; n < size; n++) {
  const e = entries[n];
  if (!e || e.type !== "n") {
    badOffsets.push(`${n}:missing`);
    continue;
  }
  if (!text.slice(e.off).startsWith(`${n} 0 obj`)) badOffsets.push(`${n}:misaligned`);
}
check(badOffsets.length === 0, "every xref offset lands on its object", badOffsets.join(" "));

// --- object graph -------------------------------------------------------
const catalog = objAt(1);
check(!!catalog && catalog.includes("/Type /Catalog"), "object 1 is the catalog");
check(!!catalog && catalog.includes("/Pages 2 0 R"), "catalog references the page tree");

const pageTree = objAt(2);
check(!!pageTree && pageTree.includes("/Type /Pages"), "object 2 is the page tree");

const kids = [...(pageTree ?? "").matchAll(/(\d+) 0 R/g)].map((x) => Number(x[1]));
const count = Number((pageTree ?? "").match(/\/Count (\d+)/)?.[1] ?? -1);
check(kids.length === count, "Kids length matches /Count", `${kids.length} vs ${count}`);
check(
  kids.every((k) => (objAt(k) ?? "").includes("/Type /Page")),
  "every /Kids entry is a page, not a font",
  kids.join(",")
);

const infoNo = size - 1;
const info = objAt(infoNo) ?? "";
check(info.includes("/Type /Font") === false, "/Info is not a font dictionary");
check(
  (text.match(new RegExp(`/Info ${infoNo} 0 R`)) ?? []).length > 0,
  "trailer /Info points at the last object",
  `/Info ${infoNo}`
);

for (const n of kids) {
  const page = objAt(n) ?? "";
  const ref = Number(page.match(/\/Contents (\d+) 0 R/)?.[1] ?? -1);
  check(ref !== n, `page ${n} /Contents is not a self-reference`);
  const content = objAt(ref) ?? "";
  const isStream = content.includes("stream") && content.includes("endstream");
  check(isStream, `page ${n} /Contents ${ref} is a stream`);
  const declared = Number(content.match(/\/Length (\d+)/)?.[1] ?? -1);
  const actual = Buffer.byteLength(
    content.slice(content.indexOf("stream\n") + 7, content.lastIndexOf("\nendstream")),
    "latin1"
  );
  check(declared === actual, `page ${n} stream /Length matches its bytes`, `${declared} vs ${actual}`);
}

console.log(`\n${report.meta.caseRef}: ${report.buffer.length} bytes, ${kids.length} page(s), ${failures} failure(s)`);
await db.close();
process.exit(failures ? 1 : 0);
