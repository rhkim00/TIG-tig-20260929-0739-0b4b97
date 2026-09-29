import { randomUUID } from "node:crypto";
import {
  pool,
  transaction,
  upsertUser,
  transfer,
} from "../packages/db/src/index.js";
import { uploadArtifact, publish, manifest } from "../apps/api/src/domain.js";
import { configFromEnv } from "../apps/api/src/config.js";
const config = configFromEnv();
if (!config.devMode)
  throw new Error("Seed requires loopback-only TIG_DEV_MODE=true");
const db = pool(config.databaseUrl);
try {
  await transaction(db, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(709006)");
    const requester = await upsertUser(tx, "dev:requester", "demo-requester"),
      worker = await upsertUser(tx, "dev:worker", "demo-worker");
    for (const user of [requester, worker]) {
      if (
        !(
          await tx.query(
            "SELECT 1 FROM ledger_transactions WHERE business_key=$1",
            [`dev-seed:${user.id}`],
          )
        ).rowCount
      )
        await transfer(
          tx,
          `dev-seed:${user.id}`,
          "development.seed",
          "system:issuance",
          `user:${user.id}`,
          300000n,
        );
    }
    const project = (
      await tx.query(
        "INSERT INTO projects(id,github_repo_id,repository,canonical_url) VALUES($1,'dev:starter','demo/starter-kit','https://github.com/octocat/Hello-World') ON CONFLICT(github_repo_id) DO UPDATE SET repository=excluded.repository RETURNING id",
        [randomUUID()],
      )
    ).rows[0];
    for (const user of [requester, worker])
      await tx.query(
        "INSERT INTO project_links VALUES($1,$2,'web_app','[\"TypeScript\",\"React\"]') ON CONFLICT DO NOTHING",
        [user.id, project.id],
      );
    if (
      (await tx.query("SELECT 1 FROM tasks WHERE project_id=$1", [project.id]))
        .rowCount
    )
      return;
    const artifact = await uploadArtifact(tx, worker.id, {
      baseCommit: "a".repeat(40),
      summary:
        "Development example handoff. This task is sample data for the local preview.",
      files: [],
      manifestHash: manifest([]),
    });
    const titles = [
      "Add keyboard shortcuts to search",
      "Give the onboarding flow a little polish",
      "Write tests for the settings page",
    ];
    for (let i = 0; i < titles.length; i++)
      await publish(
        tx,
        worker.id,
        {
          projectId: project.id,
          baseCommit: "a".repeat(40),
          title: titles[i],
          requestCategory: ["feature", "refactor", "test"][i],
          scope:
            "This is a local development example. No external work is executed.",
          acceptanceChecks: ["Sample acceptance check for UI preview"],
          aiRequirement: {
            provider: i === 1 ? "claude" : "codex",
            model: "Example model",
            effort: "Example reasoning",
            source: "declared",
          },
          rewardTig: ["600", "450", "350"][i],
          executionDeadlineAt: new Date(Date.now() + 86400000).toISOString(),
          handoffArtifactId: artifact.id,
          packageManifestHash: artifact.manifestHash,
          commandApproval: {
            kind: "explicit_post",
            text: "Create local preview sample task",
          },
        },
        new Date(),
      );
  });
  console.log(
    "Local preview seeded: two demo users, sample TIG and three sample tasks. No provider grants.",
  );
} finally {
  await db.end();
}
