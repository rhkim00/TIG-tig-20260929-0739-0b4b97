// Isolated test server: real PostgreSQL and HTTP; GitHub is an explicit deterministic test transport.
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { pool } from "../../packages/db/src/index.js";
import { migrate } from "../../packages/db/src/migrate.js";
import { tick } from "../../apps/worker/src/jobs.js";
import { buildApp } from "../../apps/api/src/app.js";
if (!process.env.TEST_DATABASE_URL)
  throw new Error("TEST_DATABASE_URL required");
const admin = pool(process.env.TEST_DATABASE_URL),
  schema = `e2e_${randomBytes(8).toString("hex")}`;
await admin.query(`CREATE SCHEMA ${schema}`);
const url = new URL(process.env.TEST_DATABASE_URL);
url.searchParams.set("options", `-c search_path=${schema}`);
const db = pool(url.href);
await migrate(db);
async function seed() {
  await new Promise<void>((ok, fail) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "scripts/seed.ts"],
      {
        env: {
          ...process.env,
          DATABASE_URL: url.href,
          TIG_DEV_MODE: "true",
          APP_ORIGIN: "http://127.0.0.1:4175",
        },
        stdio: "inherit",
      },
    );
    child.on("error", fail);
    child.on("exit", (c) => (c === 0 ? ok() : fail(new Error("Seed failed"))));
  });
}
await seed();
const requestTrees = new Map<
  string,
  { path: string; mode: string; type: string; sha: string }[]
>();
// Reset the rate-limit key with the DB between independent scenarios.
// Request IP/auth checks and the real rate-limit algorithm remain unchanged.
let scenarioClient = 1;
const app = await buildApp(
  {
    databaseUrl: url.href,
    origin: "http://127.0.0.1:4175",
    production: false,
    devMode: true,
    localTrial: true,
    host: "127.0.0.1",
    port: 4175,
  },
  db,
  {
    identity: async () => ({ id: "e2e:github", login: "e2e-user" }),
    repository: async (name) => ({
      id: `e2e:${name}`,
      repository: name,
      url: `https://github.com/${name}`,
      forkParent: null,
    }),
    commit: async () => {},
    requestTree: async (_name, sha) => {
      const tree = requestTrees.get(sha);
      if (!tree) throw new Error("Missing test tree");
      return tree;
    },
    // Non-recursive view of the same stored tree (tree-layout requests).
    requestRoot: async (_name, sha) => {
      const tree = requestTrees.get(sha);
      if (!tree) throw new Error("Missing test tree");
      return tree.filter((f) => !f.path.includes("/"));
    },
  },
  (req) => `${req.ip}:scenario:${scenarioClient}`,
);
let resetting = false;
let work: Promise<unknown> = Promise.resolve();
const timer = setInterval(() => {
  if (resetting) return;
  resetting = true;
  work = tick(db)
    .catch((e) => console.error("Test worker failed:", e.message))
    .finally(() => {
      resetting = false;
    });
}, 500);
app.get(
  "/__test/rate-probe",
  { config: { rateLimit: { max: 2, timeWindow: 60000 } } },
  async () => ({ scenario: scenarioClient }),
);
app.post("/__test/request-tree", async (req) => {
  const body = req.body as any;
  requestTrees.set(body.commit, body.tree);
  return { stored: true };
});
app.post("/__test/reset", async () => {
  scenarioClient = (scenarioClient % 250) + 1;
  requestTrees.clear();
  await work;
  resetting = true;
  try {
    await db.query(
      "TRUNCATE users,ledger_accounts,ledger_transactions,outbox,plan_prices,idempotency RESTART IDENTITY CASCADE",
    );
    await db.query(
      "INSERT INTO ledger_accounts(id,kind) VALUES('system:issuance','issuance')",
    );
    await seed();
    return { reset: true };
  } finally {
    resetting = false;
  }
});
await app.listen({ host: "127.0.0.1", port: 4175 });
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  clearInterval(timer);
  await work;
  await app.close();
  await db.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
}
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
