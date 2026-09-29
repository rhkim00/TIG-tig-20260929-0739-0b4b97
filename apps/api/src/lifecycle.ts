import { randomUUID } from "node:crypto";
import { z } from "zod";
import { cents, type TaskSpec } from "../../../packages/contracts/src/index.js";
import {
  fixtureOutput,
  fixtureSummary,
} from "../../../packages/contracts/src/lifecycle.js";
import { containsSecret } from "../../../packages/contracts/src/files.js";
import {
  DomainError,
  emit,
  transfer,
  hash,
  type Tx,
} from "../../../packages/db/src/index.js";
import { viewTask, publish, uploadArtifact, manifest } from "./domain.js";
const minute = 60000;
export async function lockedTask(tx: Tx, id: string) {
  const row = (
    await tx.query("SELECT * FROM tasks WHERE id=$1 FOR UPDATE", [id])
  ).rows[0];
  if (!row) throw new DomainError("TASK_NOT_FOUND", "Task not found.", 404);
  return row;
}
function checkVersion(task: any, version: number) {
  if (task.version !== version)
    throw new DomainError(
      "TASK_CHANGED",
      "This task changed. Refresh and try again.",
      409,
    );
}
function checkExecution(
  task: any,
  user: string,
  body: { expectedVersion: number; generation: number },
  states: string[],
  now: Date,
) {
  if (task.worker_id !== user)
    throw new DomainError("TASK_NOT_FOUND", "Task not found.", 404);
  checkVersion(task, body.expectedVersion);
  if (
    !states.includes(task.state) ||
    task.claim_generation !== body.generation ||
    new Date(task.execution_deadline_at) <= now ||
    new Date(task.phase_due_at) <= now
  )
    throw new DomainError(
      "CLAIM_EXPIRED",
      "This execution permission expired. Refresh the task.",
      409,
    );
}
export async function claimTask(
  tx: Tx,
  user: string,
  id: string,
  version: number,
  now: Date,
) {
  // Serialize competing claims by one worker across different tasks.
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,709029))", [
    user,
  ]);
  const task = await lockedTask(tx, id);
  checkVersion(task, version);
  if (task.requester_id === user)
    throw new DomainError(
      "OWN_TASK",
      "Choose a task posted by someone else.",
      409,
    );
  if (task.state !== "OPEN" || new Date(task.execution_deadline_at) <= now)
    throw new DomainError(
      "TASK_UNAVAILABLE",
      "This task is no longer available.",
      409,
    );
  if (
    (
      await tx.query(
        "SELECT 1 FROM tasks WHERE worker_id=$1 AND state IN ('CLAIMED','EXECUTING','INTERRUPTED','VALIDATING')",
        [user],
      )
    ).rowCount
  )
    throw new DomainError(
      "WORKER_BUSY",
      "Finish your current task first.",
      409,
    );
  const updated = (
    await tx.query(
      "UPDATE tasks SET worker_id=$2,state='CLAIMED',claim_generation=claim_generation+1,version=version+1,phase_due_at=$3 WHERE id=$1 RETURNING *",
      [id, user, new Date(now.getTime() + 10 * minute)],
    )
  ).rows[0];
  await emit(tx, "task.claimed", id, {
    taskId: id,
    workerId: user,
    generation: updated.claim_generation,
    source: "server_verified",
    schemaVersion: 1,
  });
  return viewTask(updated);
}
export async function executionAction(
  tx: Tx,
  user: string,
  id: string,
  body: { expectedVersion: number; generation: number },
  action: string,
  now: Date,
) {
  const task = await lockedTask(tx, id);
  const states =
    action === "start"
      ? ["CLAIMED"]
      : action === "resume"
        ? ["INTERRUPTED"]
        : ["EXECUTING"];
  checkExecution(task, user, body, states, now);
  const next = action === "interrupt" ? "INTERRUPTED" : "EXECUTING";
  const updated = (
    await tx.query(
      "UPDATE tasks SET state=$2,version=version+1,phase_due_at=$3 WHERE id=$1 RETURNING *",
      [id, next, new Date(now.getTime() + 30 * minute)],
    )
  ).rows[0];
  await emit(tx, `task.${action}`, id, {
    taskId: id,
    generation: task.claim_generation,
    source: "server_verified",
    schemaVersion: 1,
  });
  return viewTask(updated);
}
export async function submitFixture(
  tx: Tx,
  user: string,
  id: string,
  body: any,
  now: Date,
) {
  const task = await lockedTask(tx, id);
  checkExecution(task, user, body, ["EXECUTING"], now);
  if (!task.development_fixture)
    throw new DomainError(
      "RUNNER_NOT_READY",
      "Verified execution is not available yet.",
      503,
    );
  if (containsSecret(body.report))
    throw new DomainError(
      "SECRET_DETECTED",
      "Remove sensitive content from the report.",
    );
  if (body.artifact.baseCommit !== task.spec.baseCommit)
    throw new DomainError(
      "BASE_CHANGED",
      "The result must use the requested base commit.",
      409,
    );
  const files = body.artifact.files;
  // Independent validation over bounded JSON data; no eval, shell, or untrusted repository execution.
  let output: unknown;
  try {
    output = JSON.parse(files[0]?.content ?? "");
  } catch {
    output = null;
  }
  const labels = z
    .object({
      available: z.literal(fixtureOutput.available),
      escrow: z.literal(fixtureOutput.escrow),
      paid: z.literal(fixtureOutput.paid),
    })
    .strict()
    .safeParse(output);
  if (
    files.length !== 1 ||
    files[0].path !== "wallet-labels.json" ||
    body.artifact.deletedPaths.length ||
    !labels.success
  )
    throw new DomainError(
      "CHECKS_FAILED",
      "Required check failed: wallet-labels.json must contain all three requested labels. Fix the result and submit again.",
      422,
    );
  const artifact = await uploadArtifact(tx, user, body.artifact);
  const submission = {
    artifactId: artifact.id,
    report: body.report,
    checks: [
      {
        name: "wallet label schema and exact requested copy",
        status: "passed",
        source: "server_verified",
      },
    ],
    execution: { kind: "development_fixture", providerVerified: false },
    baseCommit: task.spec.baseCommit,
    generation: task.claim_generation,
  };
  const updated = (
    await tx.query(
      "UPDATE tasks SET state='AWAITING_REVIEW',version=version+1,submission=$2,submitted_at=$3,review_due_at=$4,phase_due_at=NULL WHERE id=$1 RETURNING *",
      [
        id,
        JSON.stringify(submission),
        now,
        new Date(now.getTime() + 48 * 60 * minute),
      ],
    )
  ).rows[0];
  await emit(tx, "task.submitted", id, {
    taskId: id,
    workerId: user,
    requestCategory: task.spec.requestCategory,
    projectId: task.project_id,
    elapsedMs: now.getTime() - new Date(task.created_at).getTime(),
    executionKind: "development_fixture",
    source: "server_verified",
    schemaVersion: 1,
  });
  return viewTask(updated);
}
// Git requests in development mode: a worker's local AI result is accepted for the
// requester's review without any verified execution. Runtime tests are recorded as
// not_run and the provider/model as client_observed; nothing here proves the AI ran.
export async function submitLocalTrial(
  tx: Tx,
  user: string,
  id: string,
  body: any,
  now: Date,
) {
  const task = await lockedTask(tx, id);
  checkExecution(task, user, body, ["EXECUTING"], now);
  if (!task.spec.gitRequest)
    throw new DomainError(
      "RUNNER_NOT_READY",
      "Verified execution is not available yet.",
      503,
    );
  if (containsSecret(body.report))
    throw new DomainError(
      "SECRET_DETECTED",
      "Remove sensitive content from the report.",
    );
  if (body.artifact.baseCommit !== task.spec.baseCommit)
    throw new DomainError(
      "BASE_CHANGED",
      "The result must use the requested base commit.",
      409,
    );
  const files: { path: string }[] = body.artifact.files;
  if (
    (!files.length && !body.artifact.deletedPaths.length) ||
    files.some((f) => f.path !== "report.md" && !f.path.startsWith("code/")) ||
    body.artifact.deletedPaths.some((p: string) => !p.startsWith("code/"))
  )
    throw new DomainError(
      "CHECKS_FAILED",
      "A result must contain changed files under code/ (plus an optional report.md) and nothing else.",
      422,
    );
  const artifact = await uploadArtifact(tx, user, body.artifact);
  const submission = {
    artifactId: artifact.id,
    report: body.report,
    checks: [
      {
        name: "package paths, content hashes and limits",
        status: "passed",
        source: "server_verified",
      },
      {
        name: "runtime tests and acceptance checks",
        status: "not_run",
        source: "server_verified",
        reason:
          "Verified command execution is not available in this development flow. Review the files and report before approving.",
      },
    ],
    execution: {
      kind: "local_trial",
      provider: body.execution?.provider ?? task.spec.aiRequirement.provider,
      requestedModel: body.execution?.model ?? null,
      requestedEffort: body.execution?.effort ?? null,
      source: "client_observed",
      providerVerified: false,
    },
    // Route-level GitHub checks (public repository, commit exists) already passed.
    gitResult: body.gitResult
      ? { ...body.gitResult, commitVerified: "server_verified" }
      : null,
    baseCommit: task.spec.baseCommit,
    generation: task.claim_generation,
  };
  const updated = (
    await tx.query(
      "UPDATE tasks SET state='AWAITING_REVIEW',version=version+1,submission=$2,submitted_at=$3,review_due_at=$4,phase_due_at=NULL WHERE id=$1 RETURNING *",
      [
        id,
        JSON.stringify(submission),
        now,
        new Date(now.getTime() + 48 * 60 * minute),
      ],
    )
  ).rows[0];
  await emit(tx, "task.submitted", id, {
    taskId: id,
    workerId: user,
    requestCategory: task.spec.requestCategory,
    projectId: task.project_id,
    elapsedMs: now.getTime() - new Date(task.created_at).getTime(),
    executionKind: "local_trial",
    source: "server_verified",
    schemaVersion: 1,
  });
  return viewTask(updated);
}
export async function submitResult(
  tx: Tx,
  user: string,
  id: string,
  body: any,
  now: Date,
) {
  const row = (
    await tx.query("SELECT development_fixture FROM tasks WHERE id=$1", [id])
  ).rows[0];
  if (!row) throw new DomainError("TASK_NOT_FOUND", "Task not found.", 404);
  return row.development_fixture
    ? submitFixture(tx, user, id, body, now)
    : submitLocalTrial(tx, user, id, body, now);
}
export async function settle(
  tx: Tx,
  task: any,
  kind: "paid" | "refunded",
  reason: string,
) {
  if (["PAID", "REFUNDED"].includes(task.state))
    throw new DomainError(
      "ALREADY_SETTLED",
      "This task is already closed.",
      409,
    );
  const beneficiary = kind === "paid" ? task.worker_id : task.requester_id;
  if (!beneficiary) throw new Error("Settlement beneficiary missing");
  const ledger = await transfer(
    tx,
    `task:${task.id}:settlement`,
    `task.${kind === "paid" ? "paid" : "refund"}`,
    `task:${task.id}`,
    `user:${beneficiary}`,
    cents(task.reward),
  );
  await tx.query(
    "INSERT INTO settlements(task_id,kind,reason,ledger_tx_id) VALUES($1,$2,$3,$4)",
    [task.id, kind, reason, ledger],
  );
  const updated = (
    await tx.query(
      "UPDATE tasks SET state=$2,version=version+1,phase_due_at=NULL WHERE id=$1 RETURNING *",
      [task.id, kind === "paid" ? "PAID" : "REFUNDED"],
    )
  ).rows[0];
  await emit(tx, `settlement.${kind}`, task.id, {
    taskId: task.id,
    amount: task.reward,
    reason,
    source: "server_verified",
    schemaVersion: 1,
  });
  return viewTask(updated);
}
export async function reviewTask(
  tx: Tx,
  user: string,
  id: string,
  version: number,
  action: "approve" | "issue",
  now: Date,
) {
  const task = await lockedTask(tx, id);
  if (task.requester_id !== user)
    throw new DomainError("TASK_NOT_FOUND", "Task not found.", 404);
  checkVersion(task, version);
  if (task.state !== "AWAITING_REVIEW")
    throw new DomainError(
      "REVIEW_CLOSED",
      "This task is not awaiting review.",
      409,
    );
  // Exactly at the deadline, the automatic payment rule takes precedence.
  if (new Date(task.review_due_at) <= now)
    return settle(tx, task, "paid", "review_timeout");
  return settle(
    tx,
    task,
    action === "approve" ? "paid" : "refunded",
    action === "approve" ? "requester_approved" : "requester_issue",
  );
}
export async function lifecycleDue(tx: Tx, now: Date) {
  const due = (
    await tx.query(
      "SELECT * FROM tasks WHERE (state='AWAITING_REVIEW' AND review_due_at<=$1) OR (state IN ('OPEN','CLAIMED','EXECUTING','INTERRUPTED','VALIDATING') AND (execution_deadline_at<=$1 OR phase_due_at<=$1)) ORDER BY id FOR UPDATE",
      [now],
    )
  ).rows;
  for (const task of due) {
    if (task.state === "AWAITING_REVIEW") {
      await settle(tx, task, "paid", "review_timeout");
      continue;
    }
    if (new Date(task.execution_deadline_at) <= now) {
      await settle(tx, task, "refunded", "execution_deadline");
      continue;
    }
    const started = task.state !== "CLAIMED";
    if (started && task.replacement_count >= 1) {
      await settle(tx, task, "refunded", "replacement_exhausted");
      continue;
    }
    await tx.query(
      "UPDATE tasks SET state='OPEN',worker_id=NULL,version=version+1,phase_due_at=NULL,replacement_count=replacement_count+$2 WHERE id=$1",
      [task.id, started ? 1 : 0],
    );
    await emit(tx, "task.reopened", task.id, {
      taskId: task.id,
      revokedGeneration: task.claim_generation,
      workerId: task.worker_id,
      reason: started ? "execution_interrupted" : "start_timeout",
      source: "server_verified",
      schemaVersion: 1,
    });
  }
  return due.length;
}
export async function createFixture(
  tx: Tx,
  user: string,
  reward: string,
  now: Date,
) {
  const project = (
    await tx.query(
      "INSERT INTO projects(id,github_repo_id,repository,canonical_url) VALUES($1,'dev:wallet-labels','development/wallet-labels','https://example.invalid/development-fixture') ON CONFLICT(github_repo_id) DO UPDATE SET repository=excluded.repository RETURNING id",
      [randomUUID()],
    )
  ).rows[0];
  await tx.query(
    "INSERT INTO project_links VALUES($1,$2,'web_app','[\"JSON\"]') ON CONFLICT DO NOTHING",
    [user, project.id],
  );
  const content =
    JSON.stringify(
      { available: "Balance", escrow: "Held", paid: "Done" },
      null,
      2,
    ) + "\n";
  const files = [
    {
      path: "wallet-labels.json",
      content,
      sha256: hash(content),
      source: "tracked",
    },
  ];
  const artifact = await uploadArtifact(tx, user, {
    baseCommit: "d".repeat(40),
    summary: fixtureSummary,
    files,
    manifestHash: manifest(files),
  });
  const spec: TaskSpec = {
    projectId: project.id,
    baseCommit: "d".repeat(40),
    title: "Update wallet labels · local test",
    requestCategory: "feature",
    scope: fixtureSummary,
    acceptanceChecks: ["wallet-labels.json: " + JSON.stringify(fixtureOutput)],
    aiRequirement: {
      provider: "codex",
      model: "Development fixture — no AI execution",
      effort: "Not applicable",
      source: "declared",
    },
    rewardTig: reward,
    executionDeadlineAt: new Date(now.getTime() + 86400000).toISOString(),
    handoffArtifactId: artifact.id,
    packageManifestHash: artifact.manifestHash,
    commandApproval: {
      kind: "explicit_post",
      text: "Post the local wallet-label exercise with the displayed TIG reward",
    },
  };
  const task = await publish(tx, user, spec, now);
  return viewTask(
    (
      await tx.query(
        "UPDATE tasks SET development_fixture=true WHERE id=$1 RETURNING *",
        [task.id],
      )
    ).rows[0],
  );
}
