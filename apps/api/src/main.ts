import { pool } from "../../../packages/db/src/index.js";
import { configFromEnv } from "./config.js";
import { buildApp } from "./app.js";
const config = configFromEnv(),
  db = pool(config.databaseUrl),
  app = await buildApp(config, db);
await app.listen({ host: config.host, port: config.port });
console.log(`Tokenisgold API listening on ${config.host}:${config.port}`);
async function close() {
  await app.close();
  await db.end();
}
process.once("SIGTERM", () => void close());
process.once("SIGINT", () => void close());
