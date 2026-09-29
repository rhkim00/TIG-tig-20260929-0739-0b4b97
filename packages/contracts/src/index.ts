import { z } from "zod";
export const category = z.enum([
  "build",
  "feature",
  "bug",
  "refactor",
  "test",
  "review",
  "docs",
  "setup",
  "other",
]);
export const provider = z.enum(["codex", "claude"]);
export const provenance = z.enum([
  "server_verified",
  "client_observed",
  "declared",
  "unknown",
]);
export const money = z.string().regex(/^(0|[1-9]\d{0,11})(\.\d{1,2})?$/);
export function cents(value: string): bigint {
  const [whole, fraction = ""] = money.parse(value).split(".");
  return BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0"));
}
export function amount(value: bigint): string {
  const negative = value < 0n;
  const n = negative ? -value : value;
  return `${negative ? "-" : ""}${n / 100n}.${String(n % 100n).padStart(2, "0")}`;
}
export const taskState = z.enum([
  "OPEN",
  "CLAIMED",
  "EXECUTING",
  "INTERRUPTED",
  "VALIDATING",
  "AWAITING_REVIEW",
  "PAID",
  "REFUNDED",
]);
export const aiRequirement = z
  .object({
    provider,
    model: z.string().trim().min(1).max(100),
    effort: z.string().trim().min(1).max(80),
    source: provenance.exclude(["server_verified"]),
  })
  .strict();
export const taskSpec = z
  .object({
    projectId: z.uuid(),
    baseCommit: z.string().regex(/^[a-f0-9]{40}$/),
    title: z.string().trim().min(3).max(140),
    requestCategory: category,
    scope: z.string().trim().min(10).max(12000),
    acceptanceChecks: z.array(z.string().trim().min(3).max(500)).min(1).max(20),
    aiRequirement,
    rewardTig: money.refine((v) => cents(v) > 0n, "Reward must be positive"),
    executionDeadlineAt: z.iso.datetime(),
    handoffArtifactId: z.uuid(),
    packageManifestHash: z.string().regex(/^[a-f0-9]{64}$/),
    gitRequest: z
      .object({
        repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
        // main: the request is its own repository (tig 0.6); tig/requests/<id>:
        // a branch in a shared request repository (earlier requests).
        branch: z.string().regex(/^(?:main|tig\/requests\/[a-f0-9-]{36})$/),
        sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
        requestPath: z.literal("request.md"),
      })
      .strict()
      .optional(),
    commandApproval: z
      .object({
        kind: z.literal("explicit_post"),
        text: z.string().trim().min(3).max(2000),
      })
      .strict(),
  })
  .strict();
export type TaskSpec = z.infer<typeof taskSpec>;
export const fileSchema = z
  .object({
    path: z.string().min(1).max(300),
    content: z.string().max(200000),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    source: z.enum(["tracked", "untracked-approved"]),
  })
  .strict();
export const artifactSchema = z
  .object({
    baseCommit: z.string().regex(/^[a-f0-9]{40}$/),
    summary: z.string().trim().min(10).max(12000),
    files: z.array(fileSchema).max(100),
    deletedPaths: z.array(z.string().max(300)).max(100).default([]),
    manifestHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const projectSchema = z
  .object({
    repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    projectType: z.string().trim().min(1).max(50),
    stack: z.array(z.string().trim().min(1).max(40)).max(12),
  })
  .strict();
export const observationSchema = z
  .object({
    provider,
    planId: z.string().max(100).nullable(),
    source: provenance.exclude(["server_verified"]),
    toolVersion: z.string().max(80),
    windows: z
      .array(
        z
          .object({
            name: z.string().max(80),
            usedPercent: z.number().min(0).max(100).nullable(),
            required: z.boolean(),
            resetsAt: z.iso.datetime().nullable(),
          })
          .strict(),
      )
      .max(10),
  })
  .strict();
export type Observation = z.infer<typeof observationSchema>;
export function usageSignal(
  windows: Observation["windows"],
): "low" | "spare" | "unknown" | "normal" {
  const required = windows.filter((w) => w.required);
  if (required.some((w) => w.usedPercent !== null && w.usedPercent >= 80))
    return "low";
  if (!required.length || required.some((w) => w.usedPercent === null))
    return "unknown";
  return required.every((w) => w.usedPercent! <= 30) ? "spare" : "normal";
}
export const taskView = z.object({
  id: z.uuid(),
  title: z.string(),
  requestCategory: category,
  rewardTig: money,
  state: taskState,
  version: z.number().int(),
  executionDeadlineAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  aiRequirement,
  requestUrl: z.url().nullable().default(null),
  requesterId: z.uuid(),
  projectId: z.uuid(),
  workerId: z.uuid().nullable(),
  generation: z.number().int().nonnegative(),
  phaseDueAt: z.iso.datetime().nullable(),
  reviewDueAt: z.iso.datetime().nullable(),
  developmentFixture: z.boolean(),
});
export type TaskView = z.infer<typeof taskView>;
export const walletView = z.object({ available: money, escrow: money });
export const errorView = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  requestId: z.string(),
});
export const POLICY_VERSION = "P066-v1";
