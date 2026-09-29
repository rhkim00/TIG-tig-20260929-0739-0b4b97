import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { pool, transaction, type DB, hash } from "./index.js";
export async function migrate(db: DB) {
  await transaction(db, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(709004)");
    await tx.query(
      "CREATE TABLE IF NOT EXISTS migrations(name text PRIMARY KEY,hash text NOT NULL,applied_at timestamptz DEFAULT now())",
    );
    const dir = resolve("packages/db/migrations");
    for (const file of (await readdir(dir))
      .filter((p) => p.endsWith(".sql"))
      .sort()) {
      const sql = await readFile(resolve(dir, file), "utf8");
      const previous = (
        await tx.query("SELECT hash FROM migrations WHERE name=$1", [file])
      ).rows[0];
      if (previous) {
        if (previous.hash !== hash(sql))
          throw new Error(`Migration ${file} was edited after applying`);
        continue;
      }
      await tx.query(sql);
      await tx.query("INSERT INTO migrations(name,hash) VALUES($1,$2)", [
        file,
        hash(sql),
      ]);
    }
  });
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
  const db = pool(process.env.DATABASE_URL);
  try {
    await migrate(db);
    console.log("Migrations applied");
  } finally {
    await db.end();
  }
}
