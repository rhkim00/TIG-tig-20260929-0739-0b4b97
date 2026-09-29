import { randomUUID } from "node:crypto";
import {
  artifactSchema,
  cents,
  taskSpec,
  taskView,
  type TaskSpec,
  amount,
} from "../../../packages/contracts/src/index.js";
import {
  safePath,
  containsSecret,
} from "../../../packages/contracts/src/files.js";
import {
  DomainError,
  emit,
  hash,
  canonical,
  transfer,
  type Tx,
} from "../../../packages/db/src/index.js";
export const week = 7 * 86400000;
export function viewTask(row: Record<string, any>) {
  const spec = row.spec as TaskSpec;
  return taskView.parse({
    id: row.id,
    title: spec.title,
    requestCategory: spec.requestCategory,
    rewardTig: row.reward,
    state: row.state,
    version: row.version,
    executionDeadlineAt: new Date(row.execution_deadline_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString(),
    aiRequirement: spec.aiRequirement,
    requestUrl: spec.gitRequest
      ? `https://github.com/${spec.gitRequest.repository}/blob/${spec.baseCommit}/request.md`
      : null,
    requesterId: row.requester_id,
    projectId: row.project_id,
    workerId: row.worker_id ?? null,
    generation: row.claim_generation ?? 0,
    phaseDueAt: row.phase_due_at
      ? new Date(row.phase_due_at).toISOString()
      : null,
    reviewDueAt: row.review_due_at
      ? new Date(row.review_due_at).toISOString()
      : null,
    developmentFixture: row.development_fixture ?? false,
  });
}
export function manifest(
  files: { path: string; sha256: string; source: string }[],
  deletedPaths: string[] = [],
) {
  const entries = files
    .map(({ path, sha256, source }) => ({ path, sha256, source }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return hash(
    canonical(
      deletedPaths.length
        ? { files: entries, deletedPaths: [...deletedPaths].sort() }
        : entries,
    ),
  );
}
export async function uploadArtifact(tx: Tx, user: string, input: unknown) {
  const spec = artifactSchema.parse(input);
  if (containsSecret(spec.summary))
    throw new DomainError(
      "SECRET_DETECTED",
      "Remove sensitive content from the handoff.",
    );
  const paths = new Set<string>();
  let size = 0;
  for (const f of spec.files) {
    if (
      !safePath(f.path) ||
      paths.has(f.path) ||
      containsSecret(f.content) ||
      hash(f.content) !== f.sha256
    )
      throw new DomainError(
        "UNSAFE_PACKAGE",
        "The package contains an unsafe path, duplicate, secret, or changed file.",
      );
    paths.add(f.path);
    size += Buffer.byteLength(f.content);
  }
  for (const path of spec.deletedPaths) {
    if (!safePath(path) || paths.has(path))
      throw new DomainError(
        "UNSAFE_PACKAGE",
        "Unsafe or duplicate deleted path.",
      );
    paths.add(path);
  }
  if (size > 1_000_000)
    throw new DomainError(
      "PACKAGE_TOO_LARGE",
      "This development package exceeds the 1 MB upload limit.",
    );
  if (manifest(spec.files, spec.deletedPaths) !== spec.manifestHash)
    throw new DomainError(
      "MANIFEST_MISMATCH",
      "Package manifest does not match its files.",
    );
  const id = randomUUID();
  await tx.query(
    "INSERT INTO artifacts(id,user_id,base_commit,summary,manifest_hash,files,deleted_paths) VALUES($1,$2,$3,$4,$5,$6,$7)",
    [
      id,
      user,
      spec.baseCommit,
      spec.summary,
      spec.manifestHash,
      JSON.stringify(spec.files),
      JSON.stringify(spec.deletedPaths),
    ],
  );
  return { id, manifestHash: spec.manifestHash };
}
export async function publish(tx: Tx, user: string, input: unknown, now: Date) {
  const spec = taskSpec.parse(input);
  if (Date.parse(spec.executionDeadlineAt) <= now.getTime())
    throw new DomainError(
      "DEADLINE_PASSED",
      "Choose a future completion deadline.",
    );
  if (
    [
      spec.title,
      spec.scope,
      ...spec.acceptanceChecks,
      spec.commandApproval.text,
    ].some(containsSecret)
  )
    throw new DomainError(
      "SECRET_DETECTED",
      "Remove sensitive content before posting.",
    );
  const linked = (
    await tx.query(
      "SELECT project_id FROM project_links WHERE user_id=$1 AND project_id=$2",
      [user, spec.projectId],
    )
  ).rowCount;
  if (!linked)
    throw new DomainError(
      "PROJECT_NOT_FOUND",
      "Connect this public repository first.",
      404,
    );
  const artifact = (
    await tx.query("SELECT * FROM artifacts WHERE id=$1 AND user_id=$2", [
      spec.handoffArtifactId,
      user,
    ])
  ).rows[0];
  if (
    !artifact ||
    artifact.manifest_hash !== spec.packageManifestHash ||
    artifact.base_commit !== spec.baseCommit
  )
    throw new DomainError(
      "INVALID_HANDOFF",
      "The handoff does not match this project snapshot.",
    );
  const id = randomUUID();
  await tx.query(
    "INSERT INTO ledger_accounts(id,user_id,kind) VALUES($1,$2,'escrow')",
    [`task:${id}`, user],
  );
  const result = (
    await tx.query(
      "INSERT INTO tasks(id,requester_id,project_id,artifact_id,spec,reward,state,execution_deadline_at,created_at) VALUES($1,$2,$3,$4,$5,$6,'OPEN',$7,$8) RETURNING *",
      [
        id,
        user,
        spec.projectId,
        spec.handoffArtifactId,
        JSON.stringify(spec),
        spec.rewardTig,
        spec.executionDeadlineAt,
        now,
      ],
    )
  ).rows[0];
  await transfer(
    tx,
    `task:${id}:escrow`,
    "task.escrow",
    `user:${user}`,
    `task:${id}`,
    cents(spec.rewardTig),
  );
  await emit(tx, "task.published", id, {
    taskId: id,
    projectId: spec.projectId,
    requestCategory: spec.requestCategory,
    rewardTig: amount(cents(spec.rewardTig)),
    schemaVersion: 1,
    source: "server_verified",
  });
  return viewTask(result);
}
export async function cancelTask(
  tx: Tx,
  user: string,
  id: string,
  expectedVersion: number,
  reason = "requester_cancelled",
) {
  const task = (
    await tx.query(
      "SELECT * FROM tasks WHERE id=$1 AND requester_id=$2 FOR UPDATE",
      [id, user],
    )
  ).rows[0];
  if (!task) throw new DomainError("TASK_NOT_FOUND", "Task not found.", 404);
  if (task.state !== "OPEN" || task.version !== expectedVersion)
    throw new DomainError(
      "TASK_CHANGED",
      "Refresh this task before trying again.",
      409,
    );
  const ledger = await transfer(
    tx,
    `task:${id}:settlement`,
    "task.refund",
    `task:${id}`,
    `user:${user}`,
    cents(task.reward),
  );
  await tx.query(
    "INSERT INTO settlements(task_id,kind,reason,ledger_tx_id) VALUES($1,'refunded',$2,$3)",
    [id, reason, ledger],
  );
  const updated = (
    await tx.query(
      "UPDATE tasks SET state='REFUNDED',version=version+1 WHERE id=$1 RETURNING *",
      [id],
    )
  ).rows[0];
  await emit(tx, "settlement.refunded", id, {
    taskId: id,
    reason,
    amount: task.reward,
    source: "server_verified",
    schemaVersion: 1,
  });
  return viewTask(updated);
}
// Callable only by the internal worker. No HTTP endpoint accepts entitlement writes.
export async function grantDue(tx: Tx, now: Date) {
  const entitlements = (
    await tx.query(
      "SELECT e.*,p.monthly_usd FROM entitlements e JOIN plan_prices p ON p.id=e.price_id AND p.provider=e.provider WHERE e.status='verified' AND e.verified_until>$1 AND e.first_verified_at<=$1 ORDER BY e.id FOR UPDATE OF e",
      [now],
    )
  ).rows;
  let count = 0;
  for (const e of entitlements) {
    const period = Math.floor(
      (now.getTime() - new Date(e.first_verified_at).getTime()) / week,
    );
    if (
      (
        await tx.query(
          "SELECT 1 FROM subscription_grants WHERE entitlement_id=$1 AND period_index=$2",
          [e.id, period],
        )
      ).rowCount
    )
      continue;
    const value = cents(e.monthly_usd) * 50n;
    const ledger = await transfer(
      tx,
      `grant:${e.id}:${period}`,
      "subscription.granted",
      "system:issuance",
      `user:${e.user_id}`,
      value,
    );
    await tx.query("INSERT INTO subscription_grants VALUES($1,$2,$3,$4,$5)", [
      e.id,
      period,
      e.price_id,
      amount(value),
      ledger,
    ]);
    await emit(tx, "subscription.granted", e.id, {
      userId: e.user_id,
      provider: e.provider,
      period,
      amount: amount(value),
      source: "server_verified",
      schemaVersion: 1,
    });
    count++;
  }
  return count;
}
