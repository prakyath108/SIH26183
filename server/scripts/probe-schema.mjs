import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";

const sql = await readFile(new URL("../src/db/schema.sql", import.meta.url), "utf8");
const db = new PGlite();
await db.waitReady;

try {
  await db.exec(sql);
  console.log("whole script OK");
} catch (err) {
  console.log("whole script FAILED:", err.message);
  console.log("position hint:", err.position ?? err.where ?? "n/a");
}

// Is the failure order-dependent? Apply statements in a proper dollar-aware way.
function splitStatements(text) {
  const out = [];
  let i = 0;
  let start = 0;
  let inDollar = false;
  let tag = "";
  while (i < text.length) {
    if (inDollar) {
      if (text.startsWith(tag, i)) {
        i += tag.length;
        inDollar = false;
        tag = "";
      } else i++;
      continue;
    }
    if (text[i] === "$") {
      const m = /^\$[A-Za-z_0-9]*\$/.exec(text.slice(i));
      if (m) {
        inDollar = true;
        tag = m[0];
        i += tag.length;
        continue;
      }
    }
    if (text[i] === "-" && text[i + 1] === "-") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (text[i] === ";") {
      out.push(text.slice(start, i + 1));
      start = i + 1;
    }
    i++;
  }
  if (text.slice(start).trim()) out.push(text.slice(start));
  return out.map((s) => s.trim()).filter((s) => s.length > 3);
}

const stmts = splitStatements(sql);
console.log(`dollar-aware split: ${stmts.length} statements`);

for (let i = 0; i < stmts.length; i++) {
  try {
    await db.exec(stmts[i]);
  } catch (err) {
    console.log(`\n--- statement ${i} FAILED: ${err.message}`);
    console.log(stmts[i].slice(0, 300).replace(/\s+/g, " "));
  }
}
await db.close();
