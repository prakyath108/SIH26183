import { PGlite } from "@electric-sql/pglite";

async function trial(label, sql) {
  const db = new PGlite();
  await db.waitReady;
  try {
    await db.exec(sql);
    console.log(`OK    ${label}`);
  } catch (err) {
    console.log(`FAIL  ${label}: ${err.message}`);
  }
  await db.close();
}

await trial("UPPERCASE TIMESTAMP WITH TIME ZONE", "CREATE TABLE a (x TIMESTAMP WITH TIME ZONE);");
await trial("lowercase timestamp with time zone", "CREATE TABLE a (x timestamp with time zone);");
await trial("UPPERCASE timestamptz quoted", 'CREATE TABLE a (x "TIMESTAMPTZ");');
await trial("pglite version check", "SELECT version();");
