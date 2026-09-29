import { pool } from "../../../packages/db/src/index.js";
import { tick } from "./jobs.js";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL required");
const db = pool(process.env.DATABASE_URL);
let stop = false;
process.once("SIGTERM", () => {
  stop = true;
});
process.once("SIGINT", () => {
  stop = true;
});
while (!stop) {
  try {
    const result = await tick(db);
    if (Object.values(result).some(Boolean))
      console.log(JSON.stringify(result));
  } catch {
    console.error("Worker tick failed; next tick will retry.");
  }
  if (!stop) await new Promise((r) => setTimeout(r, 1000));
}
await db.end();
