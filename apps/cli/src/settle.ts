// Settlement the requester never has to run by hand: tig reads the worker's
// result against the request it wrote and decides on its own. Two rules shape
// everything in this file. Only what can be PROVEN by reading refuses a result —
// a refund takes back work that was really done, and that is the irreversible
// direction. Anything the validator itself could not read holds instead of
// deciding: "I could not read it" is never "it is bad".
//
// This section is the proving half. mechanicalChecks is pure: no clock, no
// network, no AI, no file system. It is handed the evidence another module
// gathered (result-review.ts gatherEvidence) and returns the rules it ran, in
// the order §3 fixes, stopping at the first one that refuses or cannot be judged
// — an already-refused result must never spend the requester's AI usage.
import { createHash } from "node:crypto";
import {
  mkdir,
  open,
  readdir,
  readFile,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { provider as aiProvider } from "../../../packages/contracts/src/index.js";
import {
  containsSecret,
  protectedPathReason,
} from "../../../packages/contracts/src/files.js";
import {
  requestEnvelope,
  type RequestEnvelope,
} from "../../../packages/contracts/src/request.js";
import { atomicJson, digest, stateDir } from "./drafts.js";
import {
  formatBytes,
  SECRET_SCAN_MAX_BYTES,
  type ChangedFile,
} from "./worker-agent.js";

// ---------------------------------------------------------------------------
// The evidence the checks read
// ---------------------------------------------------------------------------
// Only the fields the mechanical rules need are declared here, so a fixture can
// be built without a network and gatherEvidence's richer object still satisfies
// it structurally.

export interface ResultGitCoordinates {
  // Always the coordinates the submission carries: the repository can be the
  // worker's fork, so it is followed, never assembled from the requester's own.
  repository: string;
  branch: string;
  commit: string;
  pullRequestUrl: string | null;
}

export interface ResultTreeEntry {
  path: string;
  mode: string;
  type: string;
  sha: string;
}

export interface ResultChanges {
  files: ChangedFile[];
  // Files whose bytes were never read (binary over the scan limit). Neither a
  // pass nor a failure: it travels with every line the requester is shown.
  unscanned: number;
  stat?: string;
}

// What the platform shows next to the same result: the mirror is a comparison
// surface, never the source of the code (a result too large to mirror has none).
export interface ShownArtifact {
  files: { path: string; content: string; sha256?: string }[];
  deletedPaths: string[];
}

export interface SubmissionEvidence {
  // The worker AI's own summary string on the task.
  report: string;
  // report.md, the long report file in the platform artifact. A different thing
  // from `report`, and both are the worker's claims, not findings.
  reportMarkdown: string | null;
  execution: { provider: string } | null;
  // Parsed by gatherEvidence when it can; derived from report.md otherwise.
  commandsRun?: string[] | null;
}

export interface MechanicalEvidence {
  // submission.baseCommit, cross-checked against requestUrl by gatherEvidence.
  requestCommit: string;
  gitResult: ResultGitCoordinates | null;
  fetched: boolean;
  // Recorded for diagnosis, never printed: git's stderr carries remote text.
  fetchReason?: string | null;
  parents: string[];
  branchTip: string | null;
  // null when the diff could not be described; `secret` / `unscanned` say why.
  changes: ResultChanges | null;
  // ResultSecretDetected and ResultUnscannedText, classified rather than thrown:
  // one refuses the result, the other only holds it.
  secret: { paths: string[] } | null;
  unscanned: { paths: string[] } | null;
  resultTree: ResultTreeEntry[];
  // request.md and request.json exactly as the request artifact carries them.
  requestDocs: { path: string; content: string }[];
  artifacts: ShownArtifact | null;
  submission: SubmissionEvidence;
  // The requester's own "no" at publication time. null (or hasPlan false) means
  // the plan is not on this computer, which skips M7 rather than failing it.
  untrackedNotShared: string[] | null;
  hasPlan?: boolean;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export type MechanicalId =
  "P2" | "P3" | "M1" | "M2" | "M3" | "M4" | "M5" | "M6" | "M7" | "M8" | "M9";

// "failed" refuses the result (refund), "hold" settles nothing at all, "skipped"
// is a rule that could not apply and does not count against the worker.
export type MechanicalOutcome = "passed" | "failed" | "hold" | "skipped";

export interface MechanicalCheck {
  id: MechanicalId;
  // True only when the rule was satisfied: a hold is neither a pass nor a refusal.
  passed: boolean;
  outcome: MechanicalOutcome;
  // One sentence, exactly as the requester is shown it (§8 for a refusal).
  detail: string;
}

interface Verdict {
  outcome: MechanicalOutcome;
  detail: string;
}
const passed = (detail: string): Verdict => ({ outcome: "passed", detail });
const refused = (detail: string): Verdict => ({ outcome: "failed", detail });
const held = (detail: string): Verdict => ({ outcome: "hold", detail });
const skipped = (detail: string): Verdict => ({ outcome: "skipped", detail });

// ---------------------------------------------------------------------------
// Shared phrasing
// ---------------------------------------------------------------------------
// Nothing here may claim a worker's code passes, is verified, works, or builds:
// nothing was run. The refusal sentences are the whole list a requester can be
// shown, so they live next to the rules that produce them.

export const shortSha = (sha: string) => sha.slice(0, 7);
// tig/results/<uuid> reads as tig/results/9f3c… in a line meant for a person.
export const shortBranch = (branch: string) => {
  const cut = branch.lastIndexOf("/");
  const last = branch.slice(cut + 1);
  return last.length > 8
    ? `${branch.slice(0, cut + 1)}${last.slice(0, 4)}…`
    : branch;
};
// P-052: the reason named here is the reason that was applied. Two different
// things leave a changed file unread — a known binary container (a PNG, a zip, a
// gzip stream, at any size at all) and a blob past the scan limit — and each
// file already carries which one it was: `scanned: false` with bytes over the
// limit is the second, `scanned: false` below it is the first. Naming the limit
// for both tells a requester that a 70-byte logo.png was "over the 10 MB scan
// limit", which is a sentence about a limit nothing hit. The files are named for
// the same reason the worker's report names them: a count nobody can resolve to
// a path is a disclosure the requester cannot act on.
const NAMED_UNSCANNED = 5;
export const scanClause = (files: ChangedFile[], unscanned: number) => {
  const total = files.length;
  if (!unscanned)
    return `no secret found in ${total} of ${total} files scanned`;
  const skipped = files.filter((f) => !f.scanned && f.status !== "deleted");
  const named = skipped
    .slice(0, NAMED_UNSCANNED)
    .map(
      (f) =>
        `${f.path} (${f.bytes > SECRET_SCAN_MAX_BYTES ? `over the ${formatBytes(SECRET_SCAN_MAX_BYTES)} scan limit` : "binary format"})`,
    );
  const rest =
    skipped.length > named.length
      ? `, and ${skipped.length - named.length} more`
      : "";
  return `no secret found in ${total - unscanned} of ${total} files scanned (${unscanned} not examined${named.length ? `: ${named.join(", ")}${rest}` : ""})`;
};
// THE RULE, at the one place it is convenient to break: every sentence tig
// prints about the worker's code carries the same three facts — a diff was read,
// nothing was run, and a named AI did the reading. tig has no spawn and no
// child_process; it never executes a line the worker wrote. A line that says
// only "implemented" reads like a test result the requester never got, and they
// will approve a merge on the strength of it. Shorten this and the screen starts
// promising something tig did not do.
// The parameter is the provider itself and never a nullable one, so that a
// missing reader cannot be rendered as "a local AI": a payment line credited an
// AI with reading a diff no AI was ever shown, because null had a label here.
// A caller with nothing to name has to say so; the type will not let it guess.
export type AiProvider = z.infer<typeof aiProvider>;
export const providerLabel = (provider: AiProvider) =>
  provider === "codex" ? "Codex" : "Claude Code";
export const readingClause = (provider: AiProvider) =>
  `${providerLabel(provider)} read the diff only, nothing was run`;
export const NO_AI_READING_CLAUSE =
  "no local AI read this change — tig settled it on a rule it could prove by reading, and nothing was run";
// The other half of the same rule, for a payment. What tig approved is a diff of
// a given size on a named branch; the pull request is still the requester's to
// merge, because tig never merges and never could. `ai` is the record's own
// proof that a reading happened, not a provider string that defaults to one.
export const approvalClause = (o: {
  changeSize: string | null;
  branch: string | null;
  ai: { ran: boolean; provider: AiProvider | null } | null;
}) =>
  `${o.changeSize ?? "The change"}${o.branch ? ` on ${shortBranch(o.branch)}` : ""}: ${
    o.ai?.ran && o.ai.provider
      ? readingClause(o.ai.provider)
      : NO_AI_READING_CLAUSE
  }, and merging the pull request is still your decision.`;
export const NO_PLAN_DETAIL =
  "the list of files you chose not to share was not available on this computer, so that check did not run";
export const NOT_MIRRORED_DETAIL =
  "not mirrored on the platform; the result branch is the only place the change can be read";

const requestDocSentence = (path: string) =>
  `The worker's result changed ${path}, which the request fixes.`;
const secretSentence = (where: string[]) =>
  `The result contains what looks like a secret in ${where.join(", ")}.`;
const mirrorSentence = (path: string) =>
  `The files shown on Tokenisgold do not match the result branch (${path} differs).`;
const describeParents = (parents: string[]) =>
  parents.length === 0
    ? "it has no parent"
    : parents.length === 1
      ? `its parent is ${shortSha(parents[0]!)}`
      : `its parents are ${parents.map(shortSha).join(" and ")}`;

// The same sha1 a Git tree entry holds, so a result commit is checked against the
// request documents the way verifyRequestTree checks the request commit itself
// (requester.ts keeps its copy private; the formula is Git's, not ours).
export function gitBlobSha(content: string) {
  return createHash("sha1")
    .update(`blob ${Buffer.byteLength(content)}\0`)
    .update(content)
    .digest("hex");
}

const CODE_PREFIX = "code/";
const isCode = (path: string) => path.startsWith(CODE_PREFIX);
const withoutCode = (path: string) => path.slice(CODE_PREFIX.length);

// ---------------------------------------------------------------------------
// The rules, in the order §3 fixes
// ---------------------------------------------------------------------------

// M1: the server checks that the commit exists and the repository is public, and
// nothing else — whether the result is built on the request is the requester's
// own check.
function checkBase(e: MechanicalEvidence): Verdict {
  if (e.parents.length === 1 && e.parents[0] === e.requestCommit)
    return passed("built on your request commit");
  return refused(
    `The result is not built on your request commit (${describeParents(e.parents)}).`,
  );
}

// M2: a branch that moved after submission is a force push over what was
// reviewed. Only a successful fetch can say that; a fetch that failed holds.
function checkBranchTip(
  e: MechanicalEvidence,
  git: ResultGitCoordinates,
): Verdict {
  if (!e.branchTip)
    return held(
      `Could not read the branch ${shortBranch(git.branch)} on github.com/${git.repository} (network, or the branch was removed).`,
    );
  if (e.branchTip !== git.commit)
    return refused(
      `The branch ${shortBranch(git.branch)} now points at ${shortSha(e.branchTip)}, not at the commit ${shortSha(git.commit)} that was submitted.`,
    );
  return passed("the branch still points at the commit that was submitted");
}

// M3: an empty diff against the request commit is an empty result (the same
// thing as a result tree identical to the base tree).
function checkDiff(e: MechanicalEvidence): Verdict {
  if (!e.changes)
    return e.secret || e.unscanned
      ? // What stopped the read is a rule of its own below; it decides, not this one.
        skipped(
          "the diff could not be described; what stopped the read is judged below",
        )
      : held("The diff against your request commit could not be read.");
  const n = e.changes.files.length;
  if (!n)
    return refused(
      "The result changes nothing: the diff against your request commit is empty.",
    );
  return passed(`${n} file${n === 1 ? "" : "s"} changed`);
}

// M4: verifyRequestTree's rule applied to the result commit — the two documents
// are what the request fixes, at mode 100644 with the artifact's own bytes, and
// they never appear in the diff.
function checkRequestDocuments(e: MechanicalEvidence): Verdict {
  const docs = e.requestDocs;
  if (docs.length !== 2)
    return held(
      "The request documents could not be read from the platform, so the result could not be checked against them.",
    );
  const changed = e.changes?.files.find((f) =>
    docs.some((d) => d.path === f.path),
  );
  if (changed) return refused(requestDocSentence(changed.path));
  for (const doc of docs) {
    const row = e.resultTree.find((r) => r.path === doc.path);
    if (
      !row ||
      row.mode !== "100644" ||
      row.type !== "blob" ||
      row.sha !== gitBlobSha(doc.content)
    )
      return refused(requestDocSentence(doc.path));
  }
  return e.changes
    ? passed("request.md and request.json unchanged")
    : skipped(
        "request.md and request.json hold the request's own bytes; the diff could not be read",
      );
}

// M5: the request tree's table, applied to the result — both to what changed and
// to everything the result commit carries.
function checkProtectedPaths(e: MechanicalEvidence): Verdict {
  const paths = [
    ...(e.changes?.files.map((f) => f.path) ?? []),
    ...e.resultTree.map((r) => r.path),
  ];
  const leaked = paths.find((p) => protectedPathReason(p));
  if (leaked)
    return refused(
      `The result touches a protected path: ${leaked} (never shared and never accepted).`,
    );
  return passed("no protected path");
}

// M6: a secret in the result is proven by reading, so it refuses. Text too large
// to scan is the opposite: nothing was read, so nothing is judged — it holds.
function checkSecrets(e: MechanicalEvidence): Verdict {
  if (e.secret?.paths.length) return refused(secretSentence(e.secret.paths));
  if (containsSecret(e.submission.report))
    return refused(secretSentence(["the worker's report"]));
  const reportFile =
    e.artifacts?.files.find((f) => f.path === "report.md")?.content ??
    e.submission.reportMarkdown;
  if (reportFile && containsSecret(reportFile))
    return refused(secretSentence(["report.md"]));
  if (e.unscanned?.paths.length)
    return held(
      `The result holds text too large to scan for secrets (over the ${formatBytes(SECRET_SCAN_MAX_BYTES)} scan limit): ${e.unscanned.paths.join(", ")}. Nothing was read from it, so nothing is judged.`,
    );
  if (!e.changes)
    return held("The changed files could not be read, so none were scanned.");
  return passed(scanClause(e.changes.files, e.changes.unscanned));
}

// M7: the requester's own "no" at publication, checked against the result the way
// it is checked against the request. Without the plan the list does not exist on
// this computer, and a rule that could not run is recorded as not run.
function checkRefusedFiles(e: MechanicalEvidence): Verdict {
  if (e.hasPlan === false || e.untrackedNotShared === null)
    return skipped(NO_PLAN_DETAIL);
  const refusedPaths = new Set(e.untrackedNotShared);
  const kept = e.resultTree.find((r) => refusedPaths.has(r.path));
  if (kept)
    return refused(
      `A file you chose not to share is in the result: ${kept.path}.`,
    );
  return passed("no file you chose not to share is in the result");
}

// M8: the two review surfaces must be the same result. The mirror is not the
// source of the code — a result too large to mirror has none, and then there is
// nothing to disagree with. Not being able to read what the platform shows is a
// different thing and holds: a missing list must never read as agreement.
function checkMirrorAgreement(e: MechanicalEvidence): Verdict {
  const artifact = e.artifacts;
  if (!artifact)
    return held("The files shown on Tokenisgold could not be read.");
  const mirrored =
    artifact.files.some((f) => isCode(f.path)) ||
    artifact.deletedPaths.length > 0;
  if (!mirrored) return passed(NOT_MIRRORED_DETAIL);
  if (!e.changes)
    return skipped(
      "the files shown on Tokenisgold could not be compared with a diff that could not be read",
    );
  const shown = new Map<string, string>();
  for (const f of artifact.files) {
    if (!isCode(f.path)) continue;
    const path = withoutCode(f.path);
    // A row must agree with itself before it can agree with the branch.
    if (f.sha256 && f.sha256 !== digest(f.content))
      return refused(mirrorSentence(path));
    shown.set(path, digest(f.content));
  }
  const shownDeleted = new Set(
    artifact.deletedPaths.filter(isCode).map(withoutCode),
  );
  const changed = e.changes.files.filter((f) => f.status !== "deleted");
  const deleted = e.changes.files.filter((f) => f.status === "deleted");
  const differing: string[] = [];
  for (const f of changed) {
    const sha = shown.get(f.path);
    // A mirrored file is text the platform holds whole; anything else differs.
    if (sha === undefined || f.content === null || sha !== digest(f.content))
      differing.push(f.path);
  }
  for (const path of shown.keys())
    if (!changed.some((f) => f.path === path)) differing.push(path);
  for (const f of deleted)
    if (!shownDeleted.has(f.path)) differing.push(f.path);
  for (const path of shownDeleted)
    if (!deleted.some((f) => f.path === path)) differing.push(path);
  if (differing.length)
    return refused(
      mirrorSentence(differing.sort((a, b) => a.localeCompare(b))[0]!),
    );
  return passed("the files shown on Tokenisgold match the result branch");
}

// The "## Commands run by the tool" list in report.md, which is the only place a
// submitted result carries it. Free text the worker's AI wrote: read for M9's
// note and for nothing else.
const COMMANDS_HEADING = "## Commands run by the tool";
export function declaredCommandsRun(reportMarkdown: string | null): string[] {
  if (!reportMarkdown) return [];
  const lines = reportMarkdown.split("\n");
  const start = lines.findIndex((l) => l.startsWith(COMMANDS_HEADING));
  if (start < 0) return [];
  const commands: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith("- ")) break;
    const item = line.slice(2).trim();
    if (item && item !== "none") commands.push(item);
  }
  return commands;
}

// M9 — NEVER promote this to a refusal, however tempting it looks. `execution`
// is client_observed and report.md is free text: a Claude Code run with no
// command-running tool that reports commands contradicts itself, but neither
// side is evidence of anything. It is recorded, handed to the AI review as
// context, and settles nothing by itself.
function noteSelfContradiction(e: MechanicalEvidence): Verdict {
  const commands =
    e.submission.commandsRun ??
    declaredCommandsRun(e.submission.reportMarkdown);
  if (e.submission.execution?.provider === "claude" && commands.length)
    return passed(
      `the result declares Claude Code, which runs here with no command-running tool, and the report lists ${commands.length} command(s) it ran — recorded, not judged`,
    );
  return passed("the report does not contradict the tool the result declares");
}

// ---------------------------------------------------------------------------
// The pass over the rules
// ---------------------------------------------------------------------------

/**
 * Run M1..M9 in order over one result's evidence. Pure. The returned list stops
 * at the first rule that refuses (the refund is already decided; reading further
 * spends the requester's AI usage on a result that will not be paid) or that
 * cannot be judged (nothing will be settled either way). A skipped rule is not a
 * stop: it is recorded and the pass continues.
 */
export function mechanicalChecks(e: MechanicalEvidence): MechanicalCheck[] {
  const checks: MechanicalCheck[] = [];
  const add = (id: MechanicalId, v: Verdict) => {
    checks.push({
      id,
      passed: v.outcome === "passed",
      outcome: v.outcome,
      detail: v.detail,
    });
    return v.outcome === "failed" || v.outcome === "hold";
  };
  const git = e.gitResult;
  // P2/P3: the validator's own preconditions. Failing them is the validator's
  // situation, never the worker's fault, so they hold and never refuse.
  if (!git) {
    add(
      "P2",
      held(
        "The worker's result was not published in Git, so there is nothing to read.",
      ),
    );
    return checks;
  }
  if (!e.fetched) {
    add(
      "P3",
      held(
        `Could not fetch the result branch from github.com/${git.repository} (network, or the branch was removed).`,
      ),
    );
    return checks;
  }
  if (add("M1", checkBase(e))) return checks;
  if (add("M2", checkBranchTip(e, git))) return checks;
  if (add("M3", checkDiff(e))) return checks;
  if (add("M4", checkRequestDocuments(e))) return checks;
  if (add("M5", checkProtectedPaths(e))) return checks;
  if (add("M6", checkSecrets(e))) return checks;
  if (add("M7", checkRefusedFiles(e))) return checks;
  if (add("M8", checkMirrorAgreement(e))) return checks;
  add("M9", noteSelfContradiction(e));
  return checks;
}

export const mechanicalFailure = (checks: MechanicalCheck[]) =>
  checks.find((c) => c.outcome === "failed") ?? null;
export const mechanicalHold = (checks: MechanicalCheck[]) =>
  checks.find((c) => c.outcome === "hold") ?? null;

/**
 * Whether the AI review may read this result at all: every rule ran and was
 * satisfied, M7 alone excepted (the plan is missing on this computer, which says
 * nothing about the result). A refused result is never read — it is already
 * decided — and a held one settles nothing, so reading it buys nothing and burns
 * the requester's own usage window.
 */
export function aiMayRun(checks: MechanicalCheck[]): boolean {
  return (
    checks.some((c) => c.id === "M8") &&
    checks.every((c) => c.passed || (c.outcome === "skipped" && c.id === "M7"))
  );
}

// ---------------------------------------------------------------------------
// The settlement record store (§7)
// ---------------------------------------------------------------------------
// What tig already checked about a submitted result, kept on this computer only.
// The same machine can run a settlement pass from a bare `tig`, from `tig work`
// and from a `tig work --watch` cycle at once, so every pass reads this store
// first and no task is verified, paid or refused twice. Nothing in this section
// talks to the server and nothing in it decides anything: it stores the verdict,
// lends out the per-task lock and the evidence directory, and says whether a
// task still needs looking at.

// Task and request ids come from the server; parsing them as UUIDs is what keeps
// them from becoming a path of their own inside the state directory.
const uuid = z.uuid();

// Settling after review_due_at pays the worker whatever the settlement says
// (apps/api/src/lifecycle.ts: at the deadline the timeout rule wins), so tig
// stops well before it rather than turning a refusal into a payment.
export const SETTLE_DEADLINE_MARGIN_MS = 15 * 60000;
const MARGIN_MINUTES = SETTLE_DEADLINE_MARGIN_MS / 60000;
// The margin is sampled again immediately before every POST, because a verdict
// waits: reading takes real time (a git fetch, three minutes of local AI) and a
// POST that failed waits whole passes. What the requester is told when the
// deadline arrived before the verdict could be delivered.
export const DEADLINE_AT_POST_DETAIL = `The review deadline came within ${MARGIN_MINUTES} minutes before this verdict could be sent, so nothing was sent: a settlement that arrives at the deadline pays the worker whatever it says. Read it on Tokenisgold, or the deadline rule pays the reward to the worker.`;
// TASK_CHANGED: the task moved under the verdict tig made. The result is put
// back to "not checked yet" rather than abandoned — the version that changed may
// be a new submission, and the next pass reads it.
export const TASK_CHANGED_DETAIL =
  "The task changed on Tokenisgold while tig was reading this result, so this verdict was not settled; the next run reads the result again.";
// The same thing with the follow-up question unanswered: TASK_CHANGED still
// means the version this verdict was made against has moved, so the verdict is
// undeliverable whether or not Tokenisgold would say what the task is now.
export const TASK_CHANGED_UNKNOWN_DETAIL =
  "The task changed on Tokenisgold while tig was reading this result, and tig could not reach Tokenisgold to ask what it is now; this verdict was not settled and cannot be sent as it stands, so the next run reads the result again.";
// A pass runs in front of the wizard or inside a watch cycle: three tasks, and
// at most one of them may spend the requester's own AI usage (up to 3 minutes).
export const SETTLE_MAX_PER_PASS = 3;
export const SETTLE_MAX_AI_PER_PASS = 1;
// The same submission is never checked more than this: asking the same model the
// same question again is not new information, it is the requester's quota.
export const SETTLE_MAX_ATTEMPTS = 3;
// A crashed pass must not hold a task hostage until the 48-hour timeout pays it.
export const SETTLE_LOCK_STALE_MS = 20 * 60000;

export const settlementsDir = () => join(stateDir(), "settlements");
export const settlementPath = (taskId: string) =>
  join(settlementsDir(), `${uuid.parse(taskId)}.json`);
export const settlementLockPath = (taskId: string) =>
  join(settlementsDir(), `${uuid.parse(taskId)}.lock`);
// Where the fetched result branch is read. Never the request's own push.git or
// snapshot directory: those belong to the publish check.
export const evidencePath = (taskId: string) =>
  join(settlementsDir(), uuid.parse(taskId));
export const settlementIndexPath = () => join(settlementsDir(), "index.json");

export const settlementState = z.enum([
  "pending", // seen, not yet checked
  "decided", // verdict made, the settlement POST has not landed
  "settled", // the server settled it (by tig or by the requester)
  "held", // checked, deliberately not settled
  "skipped", // never to be looked at again
]);
export const settlementDecision = z.enum(["approve", "issue", "hold"]);
// The AI answers per acceptance check and never in the platform's vocabulary:
// "passed"/"verified" belong to server_verified checks, and a local reading of a
// diff must not be mistaken for one.
export const reviewVerdict = z.enum([
  "implemented_in_diff",
  "not_found_in_diff",
  "cannot_tell",
]);
// One recorded rule. mechanicalChecks above also carries `outcome`; the record
// keeps the line the requester was shown, and `decision` says what it led to.
export const settlementCheckSchema = z
  .object({
    id: z.string().min(1).max(40), // "M1"…, the rule that ran
    passed: z.boolean(),
    detail: z.string().max(1000),
  })
  .strict();
export const settlementReviewSchema = z
  .object({
    ran: z.boolean(),
    provider: aiProvider.nullable(),
    checks: z
      .array(
        z
          .object({
            index: z.number().int().nonnegative(),
            verdict: reviewVerdict,
            evidence: z.string().max(500),
            note: z.string().max(500),
          })
          .strict(),
      )
      .max(20),
    truncated: z.array(z.string().max(300)).max(200),
  })
  .strict();
export const settlementRecordSchema = z
  .object({
    version: z.literal(1),
    taskId: z.uuid(),
    // Which local request this task came from, when this computer prepared it.
    requestId: z.uuid().nullable(),
    // The task version and the submitted commit the verdict was made against: a
    // verdict is never reused for a different one.
    taskVersion: z.number().int().positive(),
    // null only for a result tig can never settle (the older bundle flow submits
    // no commit): the record then exists to say so once, and nothing else.
    submissionCommit: z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .nullable(),
    state: settlementState,
    // On a settled record this is what the SERVER did, and null means its answer
    // named no state tig could read. tig's own intent lives in `reasons`.
    decision: settlementDecision.nullable(),
    // The one distinction the server ledger cannot carry: it records
    // requester_approved/requester_issue whoever decided.
    by: z.enum(["auto", "user"]),
    reasons: z.array(z.string().max(2000)).max(40), // the lines shown, verbatim
    mechanical: z.array(settlementCheckSchema).max(40),
    ai: settlementReviewSchema.nullable(),
    aiSkipReason: z.string().max(500).nullable(),
    unscanned: z.number().int().nonnegative(), // files over the scan limit
    mirrored: z.boolean(), // the platform artifact carried the code too
    attempts: z.number().int().nonnegative(),
    lastAttemptAt: z.iso.datetime(),
    nextAttemptAt: z.iso.datetime().nullable(), // null: final for this result
    settledAt: z.iso.datetime().nullable(),
    localBranch: z.string().max(300).nullable(),
  })
  .strict()
  .superRefine((r, ctx) => {
    // This record is the only local trace that money moved, so it must name when
    // it moved; an abandoned attempt must not read like a payment. `decision`
    // may be null here on purpose — a 200 whose body named no state is a
    // settlement whose outcome tig does not know, and a record that fills that
    // in from what tig asked for is the screen-lie in stored form.
    if (
      r.state === "settled" &&
      (r.settledAt === null || r.decision === "hold")
    )
      ctx.addIssue({
        code: "custom",
        message: "A settled record needs settledAt and may not be a hold.",
      });
    if (r.state === "decided" && r.decision === null)
      ctx.addIssue({
        code: "custom",
        message: "A decided record needs the decision waiting to be posted.",
      });
    // Only a submission tig can name can be delivered, so a record with no
    // commit must not be able to read as a verdict waiting to be sent.
    if (r.submissionCommit === null && r.state !== "skipped")
      ctx.addIssue({
        code: "custom",
        message:
          "A record with no submitted commit can only be a result tig stopped on.",
      });
  });
export type Settlement = z.infer<typeof settlementRecordSchema>;
export type SettlementDecision = z.infer<typeof settlementDecision>;
export type SettlementCheck = z.infer<typeof settlementCheckSchema>;
export type SettlementReview = z.infer<typeof settlementReviewSchema>;

// The rules above as the record keeps them: the sentence the requester was
// shown and whether the rule was satisfied. `outcome` is not stored — `decision`
// already says what the checks led to — and a long detail is cut rather than
// allowed to make the record unwritable at the moment money moved.
export const recordedChecks = (checks: MechanicalCheck[]): SettlementCheck[] =>
  checks.map(({ id, passed, detail }) => ({
    id,
    passed,
    detail: detail.slice(0, 1000),
  }));

export function newSettlement(o: {
  taskId: string;
  requestId?: string | null;
  taskVersion: number;
  submissionCommit: string | null;
  now?: number;
}): Settlement {
  return settlementRecordSchema.parse({
    version: 1,
    taskId: o.taskId,
    requestId: o.requestId ?? null,
    taskVersion: o.taskVersion,
    submissionCommit: o.submissionCommit,
    // With no commit there is nothing for a rule to read, so the record starts
    // where it ends: a result tig will never settle.
    state: o.submissionCommit === null ? "skipped" : "pending",
    decision: null,
    by: "auto",
    reasons: [],
    mechanical: [],
    ai: null,
    aiSkipReason: null,
    unscanned: 0,
    mirrored: false,
    attempts: 0,
    lastAttemptAt: new Date(o.now ?? Date.now()).toISOString(),
    nextAttemptAt: null,
    settledAt: null,
    localBranch: null,
  });
}
// A record that cannot be read is treated as no record: the task is checked
// again from scratch, which costs a pass but can never settle anything the
// current rules would not settle by themselves.
export async function readSettlement(
  taskId: string,
): Promise<Settlement | null> {
  let raw: string;
  try {
    raw = await readFile(settlementPath(taskId), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  try {
    const record = settlementRecordSchema.parse(JSON.parse(raw));
    return record.taskId === uuid.parse(taskId) ? record : null;
  } catch {
    return null;
  }
}
export async function writeSettlement(record: Settlement): Promise<Settlement> {
  const value = settlementRecordSchema.parse(record);
  await atomicJson(settlementPath(value.taskId), value); // 0600, temp + rename
  return value;
}

export interface LocalPlan {
  requestId: string;
  taskId: string | null;
  repository: string | null;
  branch: string | null;
  commit: string | null;
  // The new files the requester refused to share: only the local plan knows them.
  untrackedNotShared: string[];
  envelope: RequestEnvelope | null;
  // The plan's own integrity check (requester.ts readPlan) still holds.
  trusted: boolean;
}
const planShape = z
  .object({
    immutable: z
      .object({
        id: z.uuid(),
        repository: z.string().optional(),
        branch: z.string().optional(),
        commit: z
          .string()
          .regex(/^[a-f0-9]{40}$/)
          .optional(),
        untrackedNotShared: z.array(z.string()).default([]),
        envelope: z.unknown().optional(),
      })
      .passthrough(),
    previewDigest: z.string().regex(/^[a-f0-9]{64}$/),
    receipt: z.object({ taskId: z.uuid() }).passthrough().optional(),
  })
  .passthrough();
const planFile = (requestId: string) =>
  join(stateDir(), "requests", uuid.parse(requestId), "plan.json");
// Never throws: a plan that is missing, unreadable or no longer matches its own
// preview digest simply stops being a source (the API's request artifact is).
async function readLocalPlan(requestId: string): Promise<LocalPlan | null> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(planFile(requestId), "utf8"));
  } catch {
    return null;
  }
  const parsed = planShape.safeParse(raw);
  if (!parsed.success) return null;
  const i = parsed.data.immutable;
  // The digest is checked against the parsed JSON, not zod's output: that is the
  // object requester.ts hashed, key order included.
  const immutable = (raw as { immutable: unknown }).immutable;
  const envelope = requestEnvelope.safeParse(i.envelope);
  return {
    requestId: uuid.parse(requestId),
    taskId: parsed.data.receipt?.taskId ?? null,
    repository: i.repository ?? null,
    branch: i.branch ?? null,
    commit: i.commit ?? null,
    untrackedNotShared: i.untrackedNotShared,
    envelope: envelope.success ? envelope.data : null,
    trusted:
      i.id === uuid.parse(requestId) &&
      digest(JSON.stringify(immutable)) === parsed.data.previewDigest,
  };
}

const indexSchema = z
  .object({ version: z.literal(1), tasks: z.record(z.uuid(), z.uuid()) })
  .strict();
async function readIndex(): Promise<Record<string, string>> {
  try {
    return indexSchema.parse(
      JSON.parse(await readFile(settlementIndexPath(), "utf8")),
    ).tasks;
  } catch {
    return {}; // absent or damaged: rebuilt from the plans on disk
  }
}
// plan.json is keyed by request id and the receipt inside it is the only link to
// a task id, so finding a task's request means reading every plan once. The
// result is cached because a requester keeps one plan per request forever.
async function scanPlans(): Promise<Record<string, string>> {
  let entries;
  try {
    entries = await readdir(join(stateDir(), "requests"), {
      withFileTypes: true,
    });
  } catch {
    return {};
  }
  const tasks: Record<string, string> = {};
  for (const entry of entries) {
    if (!entry.isDirectory() || !uuid.safeParse(entry.name).success) continue;
    const plan = await readLocalPlan(entry.name);
    // A plan whose digest no longer matches still says which request this task
    // came from. That is a label for the record, never evidence: its content is
    // only handed out by localPlanForTask, which refuses an untrusted plan.
    if (plan?.taskId) tasks[plan.taskId] = plan.requestId;
  }
  return tasks;
}
export async function requestIdForTask(taskId: string): Promise<string | null> {
  const id = uuid.parse(taskId);
  const cached = await readIndex();
  if (cached[id]) return cached[id];
  const tasks = { ...cached, ...(await scanPlans()) };
  try {
    await atomicJson(settlementIndexPath(), { version: 1, tasks });
  } catch {
    /* the index is a cache; a pass that cannot write it still works */
  }
  return tasks[id] ?? null;
}
// The local plan for a task, or null when this computer did not prepare the
// request (a reinstall, another machine) or the plan can no longer be trusted.
export async function localPlanForTask(
  taskId: string,
): Promise<LocalPlan | null> {
  const requestId = await requestIdForTask(taskId);
  if (!requestId) return null;
  const plan = await readLocalPlan(requestId);
  // A stale index entry must not attach another request's refused files to this task.
  if (!plan || !plan.trusted || plan.taskId !== uuid.parse(taskId)) return null;
  return plan;
}

async function acquireLock(path: string, now: number) {
  try {
    return await open(path, "wx", 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  let age: number;
  try {
    age = now - (await stat(path)).mtimeMs;
  } catch {
    return null; // vanished under us: the owner is finishing, leave the task alone
  }
  if (age < SETTLE_LOCK_STALE_MS) return null;
  try {
    await unlink(path);
    return await open(path, "wx", 0o600);
  } catch {
    return null; // another pass won the same race
  }
}
// Runs `run` with this task held, or reports that someone else holds it. Two tig
// processes on one computer is the normal case (a wizard and an open watch), and
// the loser says nothing: the other one is already checking this task.
export async function withSettlementLock<T>(
  taskId: string,
  run: () => Promise<T>,
  now = Date.now(),
): Promise<{ locked: true; value: T } | { locked: false }> {
  const path = settlementLockPath(taskId);
  await mkdir(settlementsDir(), { recursive: true, mode: 0o700 });
  const lock = await acquireLock(path, now);
  if (!lock) return { locked: false };
  try {
    return { locked: true, value: await run() };
  } finally {
    // Released even when the check threw: a validator failure must not keep the
    // next pass from looking at the task again.
    await lock.close().catch(() => {});
    await unlink(path).catch(() => {});
  }
}

export interface EvidencePaths {
  dir: string;
  gitDir: string;
  workTree: string;
}
// The layout worker-agent's readers expect (<dir>/git, <dir>/ws). The work tree
// stays empty: the result is read as a diff, never checked out.
//
// There is deliberately no no-hooks directory here. Nothing in this file runs
// git — it has no spawn and no child_process — so an empty directory named
// no-hooks would only look like core.hooksPath was set somewhere. Whoever
// creates the repository in gatherEvidence sets it on that repository, the way
// requester.ts and request-tree.ts do, and an empty directory here cannot stand
// in for it.
export async function openEvidence(taskId: string): Promise<EvidencePaths> {
  const dir = evidencePath(taskId);
  // A pass killed mid-fetch leaves objects nobody verified; the diff is only
  // trusted when it comes from what this pass fetched itself.
  await rm(dir, { recursive: true, force: true });
  const paths = {
    dir,
    gitDir: join(dir, "git"),
    workTree: join(dir, "ws"),
  };
  for (const p of [paths.dir, paths.gitDir, paths.workTree])
    await mkdir(p, { recursive: true, mode: 0o700 });
  return paths;
}
// A refusal is the one outcome the requester may want to inspect, so what was
// read is kept and its path is printed; everything else is removed at pass end.
export async function closeEvidence(
  taskId: string,
  decision: SettlementDecision | null,
): Promise<string | null> {
  const dir = evidencePath(taskId);
  if (decision !== "issue") {
    await rm(dir, { recursive: true, force: true });
    return null;
  }
  try {
    return (await stat(dir)).isDirectory() ? dir : null;
  } catch {
    return null;
  }
}

export type SettlementStep = {
  // check: run the verification. post: the verdict exists and only the
  // settlement POST is missing (same stable idempotency key). skip: nothing.
  action: "check" | "post" | "skip";
  reason: string;
  // A skip tig will never come back from, as opposed to one that only means
  // "not this pass". The requester hears about the first kind exactly once: a
  // task tig has stopped watching is one the 48-hour rule pays unread.
  giveUp?: boolean;
};
// What a pass should do with one task, from its record alone. The submitted
// commit and the task version identify the submission a verdict belongs to: a
// new one is always checked again, because what was read no longer describes it.
export function nextSettlementStep(
  record: Settlement | null,
  current: { taskVersion: number; submissionCommit: string },
  now = Date.now(),
): SettlementStep {
  if (!record) return { action: "check", reason: "not checked yet" };
  // One terminal state comes before everything: the money already moved, and
  // nothing the worker submits afterwards can move it again.
  if (record.state === "settled")
    return { action: "skip", reason: "already settled" };
  // A new submission is always re-examined, whatever happened to the last one.
  // "skipped" is tested below and not here on purpose: a single 401, or one
  // settlement the server would not take, used to put a task aside for good —
  // and the worker's next result then met silence until the 48-hour rule paid it.
  if (
    record.submissionCommit !== current.submissionCommit ||
    record.taskVersion !== current.taskVersion
  )
    return { action: "check", reason: "a different result was submitted" };
  if (record.state === "skipped")
    return { action: "skip", reason: "tig has already stopped on this result" };
  // THE CAP, before every state that spends a pass on this task and not only
  // before the ones that read it. A verdict the server keeps refusing costs a
  // POST every pass, and a TASK_CHANGED that puts the record back to "pending"
  // costs a fetch and the requester's one AI slot every pass — both used to sit
  // in front of this test, so neither had any bound at all, and three of them
  // take every slot a new submission ever had.
  if (record.attempts >= SETTLE_MAX_ATTEMPTS)
    return {
      action: "skip",
      reason: `checked ${record.attempts} times without a conclusion`,
      giveUp: true,
    };
  if (record.state === "decided")
    // A decision that was made and never reached the server is re-posted with
    // the same stable key, not made again.
    return { action: "post", reason: "decided, not posted" };
  if (record.state === "pending")
    return { action: "check", reason: "seen, not checked" };
  if (record.nextAttemptAt === null)
    // "The AI could not settle the checks" is final for this submission: the
    // same question to the same model is not new information.
    return { action: "skip", reason: "held, nothing left to retry" };
  if (Date.parse(record.nextAttemptAt) > now)
    return { action: "skip", reason: `held until ${record.nextAttemptAt}` };
  return { action: "check", reason: "held for a reason that may have passed" };
}

// ---------------------------------------------------------------------------
// The verdict (§4) and the lines the requester is shown (§8)
// ---------------------------------------------------------------------------
// Where the two halves above meet: the rules that were proven by reading and the
// AI's reading of the change become one of three words. Only proof refuses, only
// a complete reading pays, and everything else settles nothing at all. Pure: the
// pass below does the talking to the server.

export type ReviewVerdict = z.infer<typeof reviewVerdict>;
export interface ReviewAnswer {
  // The acceptance check this answers, by position in the request.
  index: number;
  verdict: ReviewVerdict;
  // Where in the change the answer came from ("src/parse.ts:12"), never a claim
  // that anything was executed.
  evidence: string;
  note: string;
}
export interface ResultReview {
  provider: z.infer<typeof aiProvider>;
  answers: ReviewAnswer[];
  // Parts of the change the AI was not shown (too large for one call). Recorded
  // and printed: an unread file is not a judged file.
  truncated: string[];
}

export interface DecisionInput {
  checks: MechanicalCheck[];
  // The acceptance checks as the request fixes them, in the request's order.
  acceptanceChecks: string[];
  review: ResultReview | null;
  // Why the AI did not read this result, when it did not.
  aiSkipReason?: string | null;
}
export interface SettlementVerdict {
  decision: SettlementDecision;
  // The lines the requester is shown, most important first.
  reasons: string[];
  // true: nothing about this submission will read differently later, so a hold
  // is never retried. false: reading failed, or the usage window was closed.
  final: boolean;
}

// A rule is always named next to its sentence: a refusal the requester cannot
// trace back to a rule is indistinguishable from an opinion.
const ruleLine = (c: MechanicalCheck) => `${c.id}: ${c.detail}`;
// Every rule that has something to say about this result, in the order it ran.
// A rule that could not run is not a rule that passed, and leaving it out is
// worse than either: M1…M9 printed with M7 simply missing reads as a complete
// check, and the sentence saying the "files you chose not to share" rule never
// ran is stored in the record and shown to nobody. One list, one filter, used
// wherever the known lines are built.
export const knownLines = (checks: MechanicalCheck[]) =>
  checks.filter((c) => c.passed || c.outcome === "skipped").map(ruleLine);
export const AI_NOT_RUN_DETAIL =
  "The result was not read by a local AI, so the acceptance checks were not checked against the change.";
export const NO_ACCEPTANCE_CHECKS_DETAIL =
  "The acceptance checks of this request could not be read, so there was nothing to check the change against.";
const answerLine = (
  index: number,
  text: string,
  tail: string,
  // An answer only exists because a named AI produced it, so there is no
  // nullable provider here and no reader to invent.
  provider: AiProvider,
  extra: string,
) => {
  const where = extra.trim() ? `, ${extra.trim()}` : "";
  return `Acceptance check ${index + 1} — "${text}": ${tail} (${readingClause(provider)}${where}).`;
};
export const truncatedLine = (truncated: string[]) =>
  `The AI was not shown all of the change: ${truncated.length} file(s) were left out (${truncated.slice(0, 5).join(", ")}${truncated.length > 5 ? ", …" : ""}).`;
export const PARTIAL_READ_DETAIL =
  "Part of the change never reached the AI, so nothing here is a reading of the whole result.";
// A refusal the AI reached on its own is not a refusal tig may act on. Named so
// the rule and its one sentence live together.
export const AI_NEVER_REFUNDS_DETAIL =
  "A refund takes the worker's money, so no local AI may decide one on its own. What it did not find in the change is below, for you to read.";

// An answer that points into a file the AI was never shown is an answer about
// bytes nobody read. Evidence arrives as "src/parse.ts:12", so the line marker
// is dropped before the paths are compared, and a truncated path found anywhere
// in the string still counts: forcing an answer to "could not tell" is the safe
// direction, and being generous here only ever holds a settlement.
const evidenceUnread = (evidence: string, truncated: string[]) => {
  const text = evidence.trim();
  if (!text) return false;
  const path = text.split(/\s/)[0]!.replace(/:\d+(?::\d+)?$/, "");
  return truncated.some(
    (t) => t === path || (t.length > 0 && text.includes(t)),
  );
};

/**
 * One result's verdict. §4, in order: a rule that refused ends it (the proof is
 * already in hand), a rule that could not be judged settles nothing, and only
 * then is the AI's reading of the acceptance checks read. Pure.
 */
export function decide(input: DecisionInput): SettlementVerdict {
  const { checks, acceptanceChecks, review } = input;
  // What the requester is told even when nothing is settled: a hold that prints
  // no findings is indistinguishable from tig not having looked.
  const known = knownLines(checks);
  const failure = mechanicalFailure(checks);
  if (failure)
    return { decision: "issue", reasons: [ruleLine(failure)], final: true };
  const hold = mechanicalHold(checks);
  if (hold)
    // Reading is what failed (network, a branch that moved, a file over the scan
    // limit). Another pass may read it; SETTLE_MAX_ATTEMPTS ends the retries.
    return {
      decision: "hold",
      reasons: [ruleLine(hold), ...known],
      final: false,
    };
  if (!acceptanceChecks.length)
    return {
      decision: "hold",
      reasons: [NO_ACCEPTANCE_CHECKS_DETAIL, ...known],
      final: false,
    };
  if (!review)
    return {
      decision: "hold",
      reasons: [input.aiSkipReason || AI_NOT_RUN_DETAIL, ...known],
      final: false,
    };
  const answers = new Map(review.answers.map((a) => [a.index, a]));
  const provider = review.provider;
  const missing: string[] = [];
  const unjudged: string[] = [];
  const found: string[] = [];
  acceptanceChecks.forEach((text, index) => {
    const answer = answers.get(index);
    // An answer whose evidence lies in a file the AI was never shown is an
    // answer about bytes nobody read. Pointing at an unread file is not reading
    // it, so the check is forced back to "could not tell" whatever it said.
    const unread =
      !!answer && evidenceUnread(answer.evidence, review.truncated);
    // An acceptance check the AI did not answer is one it could not tell about:
    // silence is never agreement.
    if (!answer || answer.verdict === "cannot_tell" || unread)
      unjudged.push(
        answerLine(
          index,
          text,
          unread
            ? "the AI pointed at a file it was not shown, so it could not tell from the diff"
            : "the AI could not tell from the diff",
          provider,
          answer?.note ?? "",
        ),
      );
    else if (answer.verdict === "not_found_in_diff")
      missing.push(
        answerLine(
          index,
          text,
          "the AI did not find it in the diff",
          provider,
          `${answer.evidence} ${answer.note}`,
        ),
      );
    else
      found.push(
        // Hedged on purpose: what was read is a diff, so the most that can be
        // said is how the diff looks. "Implemented" is a claim about running code.
        answerLine(
          index,
          text,
          "looks implemented in the diff",
          provider,
          answer.evidence,
        ),
      );
  });
  const truncated = review.truncated.length
    ? [truncatedLine(review.truncated)]
    : [];
  // THE RULE, at the one place it is convenient to break: a local AI may move a
  // result from HOLD to APPROVE and never one step toward ISSUE. A refund takes
  // money out of the worker's wallet on a judgement no human ever checked, and
  // the 48-hour rule already pays without tig, so the cost of holding is a delay
  // and the cost of refusing wrongly is somebody's wages. Whoever reads
  // "the AI read the whole change and did not find it" and thinks that is proof
  // enough to refund: it is not, and truncation is not what makes it so.
  // not_found_in_diff holds, whole change or partial, every time.
  if (missing.length)
    return {
      decision: "hold",
      reasons: [
        AI_NEVER_REFUNDS_DETAIL,
        ...truncated,
        ...missing,
        ...found,
        ...known,
      ],
      final: true,
    };
  // "I could not tell" is final for this submission: the same change put to the
  // same model again is the requester's usage, not new information.
  if (unjudged.length)
    return {
      decision: "hold",
      reasons: [...unjudged, ...found, ...truncated, ...known],
      final: true,
    };
  // A payment on the word of a model that was shown part of the result is a
  // payment for the part nobody read. The deadline still pays at 48 hours; that
  // is the requester's decision to let happen, not tig's to make for them.
  if (truncated.length)
    return {
      decision: "hold",
      reasons: [PARTIAL_READ_DETAIL, ...truncated, ...found, ...known],
      final: true,
    };
  return {
    decision: "approve",
    reasons: [...found, ...known],
    final: true,
  };
}

// The record's `reasons` field, kept writable the way recordedChecks keeps
// `mechanical` writable: a long verdict must never make the one local trace of a
// settlement unwritable at the moment money moved.
export const recordedReasons = (reasons: string[]) =>
  reasons.slice(0, 40).map((r) => r.slice(0, 2000));

// The one sentence that says tig has stopped, wherever tig stops: the 48-hour
// rule is then the only thing left that settles the task, and it pays.
export const stoppedWatchingLine = (
  taskId: string,
  reviewDueAt?: string | null,
) =>
  `tig will not check this result again. Read it on Tokenisgold${reviewDueAt ? ` before ${reviewDueAt}` : ""}: without an answer the reward is paid to the worker at the review deadline (tig approve ${taskId} --yes, tig issue ${taskId} --yes).`;
export const gaveUpLine = (attempts: number) =>
  `tig read this result ${attempts} times without reaching a conclusion and will not read it again; putting the same change to the same model again is your AI usage, not new information.`;
// A POST that came back with nothing tig can read as an answer — no status, no
// code — left the machine and may have arrived. "Tokenisgold could not be
// reached" is a claim about the one thing tig cannot know from here.
export const UNDELIVERED_UNKNOWN_DETAIL =
  "tig cannot tell whether Tokenisgold received this settlement, so nothing here says the reward moved or did not; tig sends it again on its next run with the same key, which cannot settle the same task twice.";
export const undeliveredUnknownLine = (kind: string, reason: string) =>
  `tig cannot tell whether Tokenisgold received this settlement${reason ? `: ${reason}` : ""}. It may have arrived, so nothing here says the reward moved or did not; tig sends this ${kind} again on its next run with the same key, which cannot settle the same task twice.`;
// What tig had decided, next to what became of it. The verdict itself is never
// printed as the outcome: it is what tig asked for, not what happened.
export const standDownLine = (intended: SettlementDecision, reason: string) =>
  `tig had decided to ${intended === "approve" ? "pay this result" : "refuse this result"} and did not settle it: ${reason}`;
export const settledElsewhereLine = (
  intended: SettlementDecision,
  actual: SettlementDecision,
  rewardTig: string,
  reason: string,
) =>
  `${standDownLine(intended, reason)} Tokenisgold has settled it since: ${
    actual === "approve"
      ? `the worker was paid ${rewardTig} TIG`
      : `${rewardTig} TIG was returned to you`
  }. The line above is what Tokenisgold did.`;
export const NO_GIT_RESULT_DETAIL =
  "This result was not submitted as a Git commit, so there is nothing for tig's rules to read and tig will never settle it.";
export const UNREADABLE_TASK_DETAIL =
  "Tokenisgold described this task in a way this version of tig could not read, so tig did not check the result.";
export const RECORD_NOT_KEPT_DETAIL = (reason: string) =>
  `tig could not keep its own record of this on this computer: ${reason}. The lines above are what happened; the task on Tokenisgold is now the only record of it.`;

export interface SettlementContext {
  title: string;
  rewardTig: string;
  // Where what tig read was kept, when it refused (closeEvidence).
  evidenceDir?: string | null;
  reviewDueAt?: string | null;
  // Why a made verdict has not reached Tokenisgold. There is more than one
  // reason and they lead somewhere different, so the line names the one that
  // applies instead of guessing the usual one.
  undelivered?: string | null;
}
// Whether tig read this result at all, from the record and nothing else. An
// attempt, a verdict, a rule that ran or an AI reading each prove it; the state
// never does, which is how a task that had been read, judged and recorded came
// to be told "Not checked by tig" by the branch that gave up on delivering it.
export const wasChecked = (r: Settlement) =>
  r.attempts > 0 ||
  r.decision !== null ||
  r.ai?.ran === true ||
  r.mechanical.length > 0;
// THE CHOKEPOINT for what the first line may claim. Every line about where the
// reward went is built here and nowhere else, out of the record alone, so there
// is one place to hold the rule: tig may say what the SERVER did, and when it
// does not know, it says it does not know. Three things it must never do again
// — assert a refund it only intended, name an AI that never read the change,
// and tell a requester their result was not checked after it was checked.
const headline = (record: Settlement, o: SettlementContext) => {
  if (record.state === "settled") {
    // The server took the settlement and its answer named no state tig could
    // read. Filling that in from what tig asked for is the original lie.
    if (record.decision === null)
      return `Settled, and tig cannot tell how — ${o.title}. ${
        record.reasons[0] ?? OUTCOME_UNREADABLE_DETAIL
      }`;
    return record.decision === "approve"
      ? `Checked and paid: ${o.rewardTig} TIG to the worker — ${o.title}. ${approvalClause(
          {
            changeSize:
              record.mechanical.find((c) => c.id === "M3")?.detail ?? null,
            branch: record.localBranch,
            // The record's own proof a reading happened. A mechanical refusal
            // the deadline rule turned into a payment has none, and the line
            // has to say so rather than credit "a local AI" that never ran.
            ai: record.ai,
          },
        )}`
      : `Refused and closed: ${o.rewardTig} TIG is back in your wallet — ${o.title}.`;
  }
  if (record.state === "decided")
    // No default about the server here: the old one asserted Tokenisgold could
    // not be reached for a POST that may well have landed.
    return `Checked, not yet settled — ${o.title}. ${
      o.undelivered ?? UNDELIVERED_UNKNOWN_DETAIL
    }`;
  if (record.state === "skipped")
    // "Not checked by tig" over a page of M1..M9 findings is a lie the requester
    // reads first, and the record is the only thing that can tell the two apart.
    return (
      wasChecked(record)
        ? `Checked, not settled — ${o.title}. ${record.reasons[0] ?? ""}`
        : `Not checked by tig — ${o.title}. ${record.reasons[0] ?? ""}`
    ).trim();
  return `Not settled — ${o.title}. Nothing was paid and nothing was returned.`;
};
/**
 * What one settled (or held) result prints. The requester is not asked anything:
 * these lines say what tig read, which rule decided it, and — when tig stopped
 * short — what happens next if they do nothing.
 */
export function settlementLines(
  record: Settlement,
  o: SettlementContext,
): string[] {
  const head = headline(record, o);
  // headline leads with the first reason wherever it has one to lead with, and
  // printing it again is a second line carrying no new information — which is
  // how the second lines that do carry some come to be skimmed past.
  const first = record.reasons[0];
  const lines = [
    head,
    ...(first && head.endsWith(first)
      ? record.reasons.slice(1)
      : record.reasons),
  ];
  // The caller kept it or it does not exist: a refusal whose money went the
  // other way at the deadline is exactly when the requester wants to read it.
  if (o.evidenceDir) lines.push(`What tig read is kept at ${o.evidenceDir}`);
  if (record.state === "held" && record.nextAttemptAt === null)
    // The 48-hour rule is the one thing that still settles this task without the
    // requester, and it pays. Saying so is the whole reason a hold is printed.
    lines.push(stoppedWatchingLine(record.taskId, o.reviewDueAt));
  return lines;
}

// ---------------------------------------------------------------------------
// The pass (§5)
// ---------------------------------------------------------------------------
// One sweep over the requester's submitted results. It is started by a command
// that is about to do something else (a bare `tig`, `tig work`, a watch cycle),
// so it is bounded, it never asks anything, and it never throws: a settlement
// that cannot run must not stop what the requester actually typed.

// A hold that may read differently later is retried, but not within the hour:
// the usual causes (a network that is down, a usage window that is closed) take
// that long to change.
export const SETTLE_RETRY_MS = 60 * 60000;
// The sentence promises the next run, so the hold it comes with has to allow
// one: a pass is started by whatever the requester actually typed, and that is
// usually a minute away, not an hour.
export const AI_BUDGET_DETAIL =
  "One result at a time is read by your local AI; this one is checked on the next run.";

export const taskForSettlement = z
  .object({
    id: z.uuid(),
    title: z.string(),
    rewardTig: z.string(),
    state: z.string(),
    version: z.number().int().positive(),
    requesterId: z.uuid(),
    reviewDueAt: z.iso.datetime().nullable().default(null),
    developmentFixture: z.boolean().default(false),
    acceptanceChecks: z.array(z.string()).default([]),
    scope: z.string().default(""),
    submission: z
      .object({
        report: z.string().default(""),
        baseCommit: z.string().default(""),
        gitResult: z
          .object({
            repository: z.string(),
            branch: z.string(),
            commit: z.string(),
            pullRequestUrl: z.url().nullable().default(null),
          })
          .loose()
          .nullable()
          .default(null),
        execution: z
          .object({ provider: z.string() })
          .loose()
          .nullable()
          .default(null),
      })
      .loose()
      .nullable()
      .default(null),
    artifacts: z.array(z.unknown()).default([]),
  })
  .loose();
export type TaskForSettlement = z.infer<typeof taskForSettlement>;

// The submitted commit is what a verdict is made against, so a result with none
// is not a result this settlement can reason about (the older bundle flow). The
// P2 rule above covers the case where the coordinates are lost while reading.
export const submittedCommit = (task: TaskForSettlement) => {
  const commit = task.submission?.gitResult?.commit ?? "";
  return /^[a-f0-9]{40}$/.test(commit) ? commit : null;
};

export interface ReviewRequest {
  task: TaskForSettlement;
  acceptanceChecks: string[];
  evidence: MechanicalEvidence;
  plan: LocalPlan | null;
  signal?: AbortSignal;
}
export interface SettlementDeps {
  // The connected client (apps/cli/src/client.ts api), or a stub.
  api: (
    path: string,
    options?: { body?: unknown; key?: string },
  ) => Promise<any>;
  // result-review.ts gatherEvidence: everything the rules read, fetched into the
  // evidence directory this pass owns.
  gatherEvidence: (r: {
    task: TaskForSettlement;
    paths: EvidencePaths;
    plan: LocalPlan | null;
    signal?: AbortSignal;
  }) => Promise<MechanicalEvidence>;
  // The local AI's reading of the acceptance checks against the change. Throwing
  // is how "no usable tool, no usage left" arrives: it holds, it never refuses.
  review: (r: ReviewRequest) => Promise<ResultReview>;
  say: (line: string) => void;
  now?: () => number;
  signal?: AbortSignal;
}

export interface SettlementOutcome {
  // settled: the TIG moved. decided: the verdict stands, undelivered. held:
  // nothing was settled on purpose. skipped: tig did not judge this result.
  taskId: string;
  action: "settled" | "decided" | "held" | "skipped";
  decision: SettlementDecision | null;
  reason: string;
  record: Settlement | null;
  usedAi: boolean;
  // Whether this task cost the pass anything — a fetch, a POST, the AI. A record
  // that was read and put straight back costs nothing and must not use up a slot
  // a task with a new result needs (see runSettlementPass).
  worked: boolean;
}

const failureText = (e: unknown) => {
  const message = (e as Error)?.message ?? String(e);
  // Never a raw stderr line: git and the AI CLIs put remote text in theirs.
  return containsSecret(message) ? "" : message.slice(0, 400);
};
// apps/cli/src/client.ts throws ApiError(status, `${code}: ${message}`) and keeps
// no code field of its own, so the DomainError code is read back off the front
// of the message. It is read before failureText, which blanks a message that
// looks like it carries a secret: whether a 4xx ends this task or is worth
// retrying must not depend on a redaction.
export const errorCode = (e: unknown): string | null => {
  const direct = (e as { code?: unknown })?.code;
  if (typeof direct === "string" && /^[A-Z][A-Z0-9_]{2,60}$/.test(direct))
    return direct;
  const match = /^([A-Z][A-Z0-9_]{2,60}): /.exec((e as Error)?.message ?? "");
  return match ? match[1]! : null;
};
// The answers that mean this verdict can never be delivered. Two say the task is
// not tig's any more; the third says this settlement cannot be sent at all —
// packages/db/src/index.ts raises IDEMPOTENCY_CONFLICT when the stored body for
// this key held different content, and both the key and the body are derived
// from the record, so tig's re-POST is byte-identical and can never resolve it.
// Sending a different key could settle the same task twice. Everything else a
// 4xx can say — an expired token, a rate limit, a version that moved — is a
// reason to come back, not to abandon the result until the deadline pays it.
const TERMINAL_SETTLE_CODES = new Set([
  "ALREADY_SETTLED",
  "REVIEW_CLOSED",
  "IDEMPOTENCY_CONFLICT",
]);

// The server's own word for where the TIG went. apps/api/src/lifecycle.ts
// reviewTask pays the worker whenever review_due_at <= now, whatever action was
// posted, and answers HTTP 200 with the task it settled — so the answer, never
// the request, is what the requester is shown.
export const settledDecision = (state: unknown): SettlementDecision | null =>
  state === "PAID" ? "approve" : state === "REFUNDED" ? "issue" : null;
export const OUTCOME_UNREADABLE_DETAIL =
  "Tokenisgold accepted this settlement but did not say what it did with the reward; read the task on Tokenisgold.";
// The same fact with tig's own intent next to it, so the requester can see what
// tig asked for without the line ever claiming that is what happened.
export const outcomeUnreadableLine = (
  intended: SettlementDecision,
  rewardTig: string,
) =>
  `tig asked Tokenisgold to ${intended === "approve" ? "pay this result" : "refuse this result"}, and Tokenisgold accepted the settlement without saying what it did with the ${rewardTig} TIG: tig cannot tell whether the reward was paid to the worker or returned to you. Read the task on Tokenisgold.`;
export const overriddenLine = (
  intended: SettlementDecision,
  actual: SettlementDecision,
  rewardTig: string,
) =>
  `tig decided to ${intended === "approve" ? "pay this result" : "refuse this result"}, and Tokenisgold ${
    actual === "approve"
      ? `paid the worker ${rewardTig} TIG instead`
      : `returned ${rewardTig} TIG to you instead`
  }: at the review deadline the deadline rule decides, not the settlement that arrives. The line above is what Tokenisgold did.`;

type PostResult =
  | { settled: true; decision: SettlementDecision | null; reason: string }
  | {
      settled: false;
      outcome: "retry" | "terminal" | "changed";
      reason: string;
      code: string | null;
    };

// Deliver a verdict to the server. The key is stable per submission so a POST
// that was sent but never answered cannot pay twice when it is re-sent.
async function postSettlement(
  deps: SettlementDeps,
  task: TaskForSettlement,
  record: Settlement,
): Promise<PostResult> {
  const action = record.decision === "approve" ? "approve" : "issue";
  try {
    const settled = await deps.api(`/v1/tasks/${task.id}/${action}`, {
      // The version the verdict was made against, not whatever the task is now:
      // it is what the stable key was first sent with, so a POST whose answer was
      // lost replays its own response instead of colliding with a newer body.
      body: { expectedVersion: record.taskVersion },
      key: `settle:${task.id}:${record.taskVersion}:${(record.submissionCommit ?? "").slice(0, 12)}`,
    });
    // The body is the task the server settled. Throwing it away is how the
    // screen came to print the requester's intent instead of the outcome: an
    // issue posted at the deadline comes back PAID, with HTTP 200.
    const decision = settledDecision((settled as { state?: unknown })?.state);
    return { settled: true, decision, reason: `${action}d` };
  } catch (e) {
    const status = (e as { status?: number }).status ?? 0;
    if (status >= 400 && status < 500) {
      const code = errorCode(e);
      const reason = failureText(e) || "the task changed";
      if (TERMINAL_SETTLE_CODES.has(code ?? ""))
        return { settled: false, outcome: "terminal", reason, code };
      // The task moved under the verdict. Whether it is still tig's to settle is
      // a question for the server, asked by whoever called this.
      if (code === "TASK_CHANGED")
        return { settled: false, outcome: "changed", reason, code };
      return { settled: false, outcome: "retry", reason, code };
    }
    throw e;
  }
}

export const DEADLINE_TOO_CLOSE_DETAIL =
  "The 48-hour review deadline is too close for tig to settle this itself; the deadline rule decides it.";

/**
 * THE CHOKEPOINT for a task leaving a pass unsettled. It says so once and
 * records that it said so, and every path that gives up on a result goes
 * through it — the deadline guard, the attempt cap, a submission with no Git
 * coordinates, a task Tokenisgold described in a shape tig cannot read.
 *
 * Once, because a line about money repeated on every pass is noise and noise is
 * how the real warning gets missed. At all, because a task that leaves a pass
 * in silence is one the 48-hour rule pays unread. Nothing an earlier pass read
 * is erased: the verdict, the rules it ran and the AI's reading stay on the
 * record, and only the state and the leading sentence change.
 *
 * Never throws: it is called from paths that must not be stoppable.
 */
export async function stopWatching(o: {
  taskId: string;
  title: string;
  rewardTig: string;
  taskVersion: number;
  // null for a result tig cannot even identify a submission for.
  submissionCommit: string | null;
  reviewDueAt: string | null;
  reason: string;
  now: number;
  say: (line: string) => void;
  // Left out, the record is read here; settleOnce has already read it.
  existing?: Settlement | null;
}): Promise<Settlement | null> {
  const existing =
    o.existing !== undefined
      ? o.existing
      : await readSettlement(o.taskId).catch(() => null);
  // Already said, about this same submission and for this same reason: this is
  // what keeps a watch loop from repeating the sentence for ever.
  if (
    existing &&
    existing.state === "skipped" &&
    existing.submissionCommit === o.submissionCommit &&
    existing.taskVersion === o.taskVersion &&
    existing.reasons[0] === o.reason
  )
    return existing;
  const stamp = new Date(o.now).toISOString();
  const base =
    existing ??
    newSettlement({
      taskId: o.taskId,
      taskVersion: o.taskVersion,
      submissionCommit: o.submissionCommit,
      now: o.now,
    });
  const stopped = stoppedWatchingLine(o.taskId, o.reviewDueAt);
  // What an earlier pass read, but only about THIS submission: a different one
  // is a different result and its sentences are not about this one. The old
  // copy of the sentence below is dropped so it cannot accumulate.
  const earlier =
    base.submissionCommit === o.submissionCommit &&
    base.taskVersion === o.taskVersion
      ? base.reasons.filter((r) => r !== stopped && r !== o.reason)
      : [];
  const record: Settlement = {
    ...base,
    taskVersion: o.taskVersion,
    submissionCommit: o.submissionCommit,
    state: "skipped",
    reasons: recordedReasons([o.reason, stopped, ...earlier]),
    lastAttemptAt: stamp,
    nextAttemptAt: null,
  };
  let written: Settlement | null = null;
  let unwritten: string | null = null;
  try {
    written = await writeSettlement(record);
  } catch (e) {
    unwritten = failureText(e) || "the settlement record could not be written";
  }
  for (const line of settlementLines(written ?? record, {
    title: o.title,
    rewardTig: o.rewardTig,
    reviewDueAt: o.reviewDueAt,
  }))
    o.say(line);
  // A record that was not kept cannot keep the next pass quiet either, so the
  // requester is told rather than shown the same line again with no reason.
  if (unwritten) o.say(RECORD_NOT_KEPT_DETAIL(unwritten));
  return written;
}

/**
 * Check and settle one submitted result. Never asks the requester anything, and
 * decides only from what it could read itself.
 */
export async function settleOnce(
  task: TaskForSettlement,
  deps: SettlementDeps,
  budget: { ai: number } = { ai: SETTLE_MAX_AI_PER_PASS },
): Promise<SettlementOutcome> {
  const now = deps.now?.() ?? Date.now();
  const skip = (reason: string, record: Settlement | null = null) => ({
    taskId: task.id,
    action: "skipped" as const,
    decision: null,
    reason,
    record,
    usedAi: false,
    // Reading a record and putting it straight back costs nothing.
    worked: false,
  });
  const existing = await readSettlement(task.id).catch(() => null);
  const commit = submittedCommit(task);
  // Every give-up in this function goes through here, so none of them can drop
  // a task with no sentence and none of them can repeat one.
  const retire = async (
    reason: string,
    record: Settlement | null,
  ): Promise<SettlementOutcome> => {
    const kept = await stopWatching({
      taskId: task.id,
      title: task.title,
      rewardTig: task.rewardTig,
      taskVersion: task.version,
      submissionCommit: commit,
      reviewDueAt: task.reviewDueAt ?? null,
      reason,
      now,
      say: deps.say,
      existing: record,
    });
    return { ...skip(reason, kept), decision: kept?.decision ?? null };
  };
  if (!commit) return retire(NO_GIT_RESULT_DETAIL, existing);
  const current = { taskVersion: task.version, submissionCommit: commit };
  const step = nextSettlementStep(existing, current, now);
  if (step.action === "skip")
    // Two kinds of skip. Most are a task nobody needs to hear about again — the
    // money moved, another tig holds it, a hold whose hour has not come round.
    // The other is tig giving up on a result the 48-hour rule will pay unread.
    return step.giveUp
      ? retire(gaveUpLine(existing?.attempts ?? SETTLE_MAX_ATTEMPTS), existing)
      : skip(step.reason, existing);
  // P1: settling at or after the review deadline pays the worker whatever tig
  // decided (apps/api/src/lifecycle.ts reviewTask), so a refusal posted late
  // would read as a refund and be a payment.
  //
  // The rule itself lives in deliver(), which is the one place a verdict
  // becomes a POST — the verdict this pass makes and the verdict an earlier
  // pass made and could not deliver both arrive there. This guard only keeps
  // tig from STARTING a reading it could never deliver, and it is deliberately
  // confined to step "check": overwriting a verdict that already exists is how
  // a task that had been read came to be told it was not checked by tig, with
  // the reading, the rules and the AI's answers deleted on the way.
  const due = task.reviewDueAt ? Date.parse(task.reviewDueAt) : null;
  if (
    step.action === "check" &&
    due !== null &&
    due - now <= SETTLE_DEADLINE_MARGIN_MS
  )
    return retire(DEADLINE_TOO_CLOSE_DETAIL, existing);

  // Nothing this pass writes may throw. The one write that matters happens
  // AFTER money moved, and a state directory that has gone read-only at that
  // instant used to turn a settled result into a task that vanished from the
  // screen with no record of the settlement anywhere on this computer.
  const write = { failed: null as string | null };
  const persist = async (record: Settlement): Promise<Settlement> => {
    try {
      return await writeSettlement(record);
    } catch (e) {
      write.failed =
        failureText(e) || "the settlement record could not be written";
      return record;
    }
  };
  // Every line this function prints goes through here, so a record that could
  // not be kept is one more line rather than a silence where an outcome was.
  const print = (
    record: Settlement,
    o: { evidenceDir?: string | null; undelivered?: string | null } = {},
  ) => {
    for (const line of settlementLines(record, {
      title: task.title,
      rewardTig: task.rewardTig,
      evidenceDir: o.evidenceDir ?? null,
      reviewDueAt: task.reviewDueAt,
      undelivered: o.undelivered ?? null,
    }))
      deps.say(line);
    if (write.failed) {
      deps.say(RECORD_NOT_KEPT_DETAIL(write.failed));
      write.failed = null;
    }
  };

  const serverState = async (): Promise<string | null> =>
    deps
      .api(`/v1/tasks/${task.id}`)
      .then((t: unknown) => {
        const s = (t as { state?: unknown })?.state;
        return typeof s === "string" ? s : null;
      })
      .catch(() => null);

  // THE CHOKEPOINT for a verdict that will never be delivered. The one question
  // left is where the reward went, and only the server can answer it, so every
  // path that gives up on delivering asks here — the deadline that arrived, the
  // 409 that closed the task, the settlement key that can never be replayed.
  // The 409 branch used not to ask at all and recorded tig's own refusal as
  // though it had happened, while the reward had been paid on the web.
  const standDown = async (o: {
    decided: Settlement;
    evidenceDir: string | null;
    stamp: string;
    reason: string;
    // Already asked, by a caller that had to know before it could give up.
    state?: string | null;
  }): Promise<{
    record: Settlement;
    action: SettlementOutcome["action"];
    reason: string;
  }> => {
    const intended: SettlementDecision =
      o.decided.decision === "approve" ? "approve" : "issue";
    const state = o.state === undefined ? await serverState() : o.state;
    const actual = settledDecision(state);
    if (actual) {
      const record = await persist({
        ...o.decided,
        state: "settled",
        decision: actual,
        // Not tig's settlement: the ledger records it as the requester's,
        // whoever or whatever on the server side actually moved the reward.
        by: "user",
        settledAt: o.stamp,
        lastAttemptAt: o.stamp,
        reasons: recordedReasons([
          settledElsewhereLine(intended, actual, task.rewardTig, o.reason),
          ...o.decided.reasons,
        ]),
      });
      print(record, { evidenceDir: o.evidenceDir });
      return { record, action: "settled", reason: o.reason };
    }
    const record = await persist({
      ...o.decided,
      state: "skipped",
      // tig's verdict is not what happened, and a record that keeps it reads as
      // a refusal that never took place. What tig decided is in the sentence.
      decision: null,
      settledAt: null,
      lastAttemptAt: o.stamp,
      reasons: recordedReasons([
        `${standDownLine(intended, o.reason)} ${
          state
            ? `Tokenisgold says this task is ${state}.`
            : "tig could not ask Tokenisgold where the reward went, so nothing here says whether it was paid to the worker or returned to you."
        }`,
        ...o.decided.reasons,
      ]),
    });
    print(record, { evidenceDir: o.evidenceDir });
    return { record, action: "skipped", reason: o.reason };
  };

  // The one place a verdict becomes money, so the one place the deadline is
  // checked against the clock that is actually there and the server's answer is
  // read back. Every branch prints: a settlement that failed silently is a
  // requester who thinks tig is still watching a task it has given up on.
  const deliver = async (
    decided: Settlement,
    evidenceDir: string | null,
  ): Promise<{
    record: Settlement;
    action: SettlementOutcome["action"];
    reason: string;
  }> => {
    const at = deps.now?.() ?? Date.now();
    const stamp = new Date(at).toISOString();
    const kind = decided.decision === "approve" ? "payment" : "refusal";
    // P1, at the one place every POST passes: the verdict this pass made, and
    // the verdict an earlier pass made and could not deliver. Reading takes
    // real time (a git fetch with no timeout, three minutes of local AI) and a
    // failed POST waits whole passes, so the deadline is usually crossed
    // BETWEEN passes, not inside one. Settling now pays the worker whatever the
    // settlement says, so a refusal sent here is a payment wearing a refund's
    // words. The deadline only ever gets closer: this verdict is never
    // deliverable again, and the reward may already have moved, so tig keeps
    // what it read, stops, and asks where the reward went.
    if (due !== null && due - at <= SETTLE_DEADLINE_MARGIN_MS)
      return standDown({
        decided,
        evidenceDir,
        stamp,
        reason: DEADLINE_AT_POST_DETAIL,
      });
    const posted = await postSettlement(deps, task, decided).catch(
      (e): PostResult => ({
        settled: false,
        outcome: "retry",
        reason: failureText(e),
        code: errorCode(e),
      }),
    );
    if (posted.settled) {
      // The server's answer, never tig's intent. reviewTask pays the worker at
      // the deadline whatever was posted, so an issue can come back PAID — and
      // a 200 that names no state at all is an outcome tig does not know, which
      // the record says instead of filling in from what tig asked for.
      const intended: SettlementDecision =
        decided.decision === "approve" ? "approve" : "issue";
      const actual = posted.decision;
      const record = await persist({
        ...decided,
        state: "settled",
        decision: actual,
        by: "auto",
        settledAt: stamp,
        lastAttemptAt: stamp,
        reasons: recordedReasons([
          ...(actual === null
            ? [outcomeUnreadableLine(intended, task.rewardTig)]
            : actual !== intended
              ? [overriddenLine(intended, actual, task.rewardTig)]
              : []),
          ...decided.reasons,
        ]),
      });
      print(record, { evidenceDir });
      return { record, action: "settled", reason: posted.reason };
    }
    if (posted.outcome === "changed") {
      // The task moved under the verdict. Whether it is still tig's to settle is
      // the server's to say, so tig asks instead of abandoning the result.
      const state = await serverState();
      if (state !== null && state !== "AWAITING_REVIEW")
        return standDown({
          decided,
          evidenceDir,
          stamp,
          state,
          reason: `Tokenisgold did not accept this settlement: ${posted.reason}`,
        });
      // Still the requester's to answer, or Tokenisgold would not say. Either
      // way TASK_CHANGED means the version this verdict was made against has
      // already moved, so it can never be delivered as it stands: promising to
      // send it on the next run promises something that cannot happen. The
      // result goes back to "not checked yet" and is read again — and the
      // attempt is counted, because re-reading costs a fetch and the one AI
      // slot, and an unbounded loop of it starves every other result.
      const record = await persist({
        ...decided,
        state: "pending",
        decision: null,
        settledAt: null,
        nextAttemptAt: null,
        attempts: decided.attempts + 1,
        lastAttemptAt: stamp,
        reasons: recordedReasons([
          state === null ? TASK_CHANGED_UNKNOWN_DETAIL : TASK_CHANGED_DETAIL,
          ...decided.reasons,
        ]),
      });
      print(record, { evidenceDir });
      return {
        record,
        action: "held",
        reason: state === null ? TASK_CHANGED_UNKNOWN_DETAIL : TASK_CHANGED_DETAIL,
      };
    }
    if (posted.outcome === "terminal")
      // The task moved on without tig (settled on the web, reopened), or this
      // settlement can never be sent at all.
      return standDown({
        decided,
        evidenceDir,
        stamp,
        reason:
          posted.code === "IDEMPOTENCY_CONFLICT"
            ? `Tokenisgold holds this settlement key against different content (${posted.reason}), and tig re-sends it byte for byte, so sending it again could never change that answer.`
            : `Tokenisgold did not accept this settlement: ${posted.reason}`,
      });
    // Retryable: offline, an expired token, a rate limit. The verdict stands and
    // the next pass delivers it with the same key. The attempt is counted: a
    // POST the server keeps refusing costs a pass slot every time, and three
    // such results took every slot a new submission ever had.
    const undelivered = posted.code
      ? `Tokenisgold would not take this settlement yet (${posted.reason}); tig delivers this ${kind} on its next run.`
      : // No status and no code: the POST left this machine and may have
        // arrived. The old line asserted the server was never reached, which is
        // exactly the thing tig cannot know from here, and dropped the one
        // sentence the requester could have acted on.
        undeliveredUnknownLine(kind, posted.reason);
    const record = await persist({
      ...decided,
      state: "decided",
      settledAt: null,
      attempts: decided.attempts + 1,
      lastAttemptAt: stamp,
    });
    print(record, { evidenceDir, undelivered });
    return { record, action: "decided", reason: posted.reason };
  };

  const held = await withSettlementLock(
    task.id,
    async (): Promise<SettlementOutcome> => {
      const requestId = await requestIdForTask(task.id).catch(() => null);
      const base =
        existing ??
        newSettlement({ ...current, taskId: task.id, requestId, now });
      // A verdict that was made and never reached the server is delivered, not
      // made again: re-reading could not change it and the AI would be spent twice.
      if (step.action === "post" && base.decision && base.decision !== "hold") {
        // A refusal decided by an earlier pass kept what it read; say where.
        const kept =
          base.decision === "issue"
            ? await closeEvidence(task.id, "issue").catch(() => null)
            : null;
        const delivered = await deliver(base, kept);
        return {
          taskId: task.id,
          action: delivered.action,
          decision: delivered.record.decision,
          reason: delivered.reason,
          record: delivered.record,
          usedAi: false,
          worked: true,
        };
      }

      const plan = await localPlanForTask(task.id).catch(() => null);
      // The request the verdict is made against: the server's own copy of the
      // acceptance checks, and the local plan only when the server has none.
      const acceptanceChecks = task.acceptanceChecks.length
        ? task.acceptanceChecks
        : (plan?.envelope?.request.acceptanceChecks ?? []);
      let checks: MechanicalCheck[] = [];
      let read: MechanicalEvidence | null = null;
      let review: ResultReview | null = null;
      let aiSkipReason: string | null = null;
      let usedAi = false;
      // The AI slot was taken by another result in THIS pass, which is not a
      // reading that failed: nothing about this result was tried, so there is
      // nothing to wait an hour for. The line promises the next run, and the
      // next run is what the requester actually types a minute later.
      let aiDeferred = false;
      let verdict: SettlementVerdict;
      try {
        const paths = await openEvidence(task.id);
        const evidence = await deps.gatherEvidence({
          task,
          paths,
          plan,
          signal: deps.signal,
        });
        read = evidence;
        checks = mechanicalChecks(evidence);
        if (aiMayRun(checks) && acceptanceChecks.length) {
          if (budget.ai <= 0) {
            aiSkipReason = AI_BUDGET_DETAIL;
            aiDeferred = true;
          } else {
            budget.ai -= 1;
            usedAi = true;
            try {
              review = await deps.review({
                task,
                acceptanceChecks,
                evidence,
                plan,
                signal: deps.signal,
              });
            } catch (e) {
              // No usable local AI, no usage left, a timeout: the requester's
              // situation, never the worker's. It holds and says so.
              aiSkipReason = `The local AI could not read this result: ${failureText(e) || "it did not answer"}`;
            }
          }
        }
        verdict = decide({ checks, acceptanceChecks, review, aiSkipReason });
      } catch (e) {
        // Reading the result is the one thing that may throw here. A validator
        // that fell over settles nothing and blames no one.
        aiSkipReason = null;
        verdict = {
          decision: "hold",
          reasons: [
            `tig could not read this result: ${failureText(e) || "the check did not finish"}`,
            ...knownLines(checks),
          ],
          final: false,
        };
      }
      const evidenceDir = await closeEvidence(task.id, verdict.decision).catch(
        () => null,
      );
      // A pass that never asked the AI asked nothing new, so it does not count
      // against the cap on readings: otherwise three crowded passes would
      // retire a result the AI has still never been shown.
      const attempts = base.attempts + (aiDeferred ? 0 : 1);
      const record: Settlement = {
        ...base,
        ...current,
        requestId: base.requestId ?? requestId,
        state: verdict.decision === "hold" ? "held" : "decided",
        decision: verdict.decision,
        by: "auto",
        reasons: recordedReasons(verdict.reasons),
        mechanical: recordedChecks(checks),
        ai: review
          ? {
              ran: true,
              provider: review.provider,
              checks: review.answers.slice(0, 20).map((a) => ({
                index: a.index,
                verdict: a.verdict,
                evidence: a.evidence.slice(0, 500),
                note: a.note.slice(0, 500),
              })),
              truncated: review.truncated
                .slice(0, 200)
                .map((t) => t.slice(0, 300)),
            }
          : null,
        aiSkipReason: aiSkipReason ? aiSkipReason.slice(0, 500) : null,
        // Both come from what was read, not from the sentences about it: a
        // record is read back long after the evidence directory is gone.
        unscanned: read?.changes?.unscanned ?? 0,
        mirrored: mirroredResult(read),
        attempts,
        lastAttemptAt: new Date(now).toISOString(),
        nextAttemptAt:
          verdict.decision === "hold" && !verdict.final
            ? // An hour is how long the usual causes of a failed reading take to
              // change (a network that is down, a usage window that is closed).
              // A slot another result took in this pass is not one of them, and
              // holding this result for an hour is the pass refusing to honour
              // the sentence it just printed.
              new Date(aiDeferred ? now : now + SETTLE_RETRY_MS).toISOString()
            : null,
        settledAt: null,
        // The branch the verdict was read from, as the submission named it. The
        // evidence directory is not stored: it is evidencePath(taskId) while it
        // exists, and a path that was deleted must not read like one that is there.
        localBranch:
          (task.submission?.gitResult?.branch ?? "").slice(0, 300) || null,
      };
      if (verdict.decision === "hold") {
        const written = await persist(record);
        print(written, { evidenceDir });
        return {
          taskId: task.id,
          action: "held",
          decision: written.decision,
          reason: verdict.reasons[0] ?? "",
          record: written,
          usedAi,
          worked: true,
        };
      }
      const delivered = await deliver(record, evidenceDir);
      return {
        taskId: task.id,
        action: delivered.action,
        decision: delivered.record.decision,
        reason: delivered.reason,
        record: delivered.record,
        usedAi,
        worked: true,
      };
    },
    now,
  );
  return held.locked
    ? held.value
    : skip("another tig on this computer is checking it", existing);
}

// Whether the platform carried the code next to the result, the same reading M8
// makes: report.md alone is a result that was too large to mirror.
const mirroredResult = (e: MechanicalEvidence | null) =>
  !!e?.artifacts &&
  (e.artifacts.files.some((f) => f.path.startsWith(CODE_PREFIX)) ||
    e.artifacts.deletedPaths.length > 0);

export interface SettlementPassResult {
  // How many tasks the pass examined. Not a budget: a task that cost nothing is
  // examined for free, and only `worked` outcomes are capped.
  looked: number;
  outcomes: SettlementOutcome[];
  // Why the pass did nothing, when it did nothing. Recorded here and said aloud.
  stopped: string | null;
}
// How far down the waiting list one pass reads records. Separate from — and
// larger than — SETTLE_MAX_PER_PASS, which bounds the work.
export const SETTLE_MAX_LOOKED_PER_PASS = 20;
// The least a row has to say for tig to keep a record against it, so that a
// task whose full shape this CLI cannot read is still told about exactly once.
const looseTask = z
  .object({
    id: z.uuid(),
    title: z.string().default(""),
    rewardTig: z.string().default(""),
    version: z.number().int().positive().default(1),
    requesterId: z.uuid(),
    state: z.string(),
  })
  .loose();
export const NO_REVIEW_DEADLINE_DETAIL =
  "Tokenisgold did not say when the review of this result closes, so tig cannot tell whether settling it would still refuse it or already pay it.";
export const unreadableTasksLine = (count: number) =>
  `${count} task${count === 1 ? "" : "s"} waiting for your review could not be read from Tokenisgold at all, so tig did not check ${count === 1 ? "it" : "them"}; read them on Tokenisgold, or the reward is paid to the worker at each review deadline.`;
export const passStoppedLine = (reason: string) =>
  `tig could not check the results waiting for your review: ${reason || "the check did not finish"}. Nothing was paid and nothing was returned; without an answer each reward is paid to its worker at the review deadline.`;
/**
 * Every result of this requester's that is waiting on them, checked and settled
 * without a question. Bounded by the work it does (SETTLE_MAX_PER_PASS results
 * actually checked, one AI reading) and never throws: this runs in front of what
 * the requester actually typed, and must not be able to stop it. It is not
 * silent, though — a pass that gave up says so, because the alternative is a
 * requester who believes tig is watching a task it stopped watching.
 */
export async function runSettlementPass(
  deps: SettlementDeps,
): Promise<SettlementPassResult> {
  const outcomes: SettlementOutcome[] = [];
  const budget = { ai: SETTLE_MAX_AI_PER_PASS };
  const say = (line: string) => {
    try {
      deps.say(line);
    } catch {
      /* a screen that cannot be written to must not stop a settlement pass */
    }
  };
  try {
    const me = z.object({ id: z.uuid() }).parse(await deps.api("/v1/me"));
    const list = z
      .object({ tasks: z.array(z.unknown()) })
      .parse(await deps.api("/v1/tasks?mine=true"));
    const waiting: TaskForSettlement[] = [];
    // Rows this version of tig cannot name at all. There is nowhere to keep a
    // record for them, so they are counted and mentioned once per pass rather
    // than not at all: a result waiting on the requester's money is the one
    // thing that may not leave a pass unmentioned.
    let unnamed = 0;
    for (const row of list.tasks) {
      const task = taskForSettlement.safeParse(row);
      if (!task.success) {
        // The strict shape was rejected — a review_due_at carrying a UTC
        // offset, a field whose shape drifted from this CLI's schema. Dropping
        // the row is the same disappearance the null-deadline line was added to
        // stop, one branch earlier, so tig says so once and keeps the record
        // that stops it saying so again.
        const named = looseTask.safeParse(row);
        if (!named.success || named.data.requesterId !== me.id) {
          if (!named.success) unnamed += 1;
          continue;
        }
        if (named.data.state !== "AWAITING_REVIEW") continue;
        await stopWatching({
          taskId: named.data.id,
          title: named.data.title || named.data.id,
          rewardTig: named.data.rewardTig,
          taskVersion: named.data.version,
          submissionCommit: null,
          reviewDueAt: null,
          reason: UNREADABLE_TASK_DETAIL,
          now: deps.now?.() ?? Date.now(),
          say,
        }).catch(() => null);
        continue;
      }
      if (
        task.data.requesterId !== me.id ||
        task.data.state !== "AWAITING_REVIEW" ||
        task.data.developmentFixture
      )
        continue;
      // settleOnce's deadline guard can only stop what it can measure. A task
      // with no review deadline would walk straight past it and be settled with
      // no idea whether the server would refuse or pay, so it is not settled at
      // all — and the requester is told once, rather than it disappearing
      // quietly (silence) or being told again on every pass for ever (noise).
      if (task.data.reviewDueAt === null) {
        await stopWatching({
          taskId: task.data.id,
          title: task.data.title,
          rewardTig: task.data.rewardTig,
          taskVersion: task.data.version,
          submissionCommit: submittedCommit(task.data),
          reviewDueAt: null,
          reason: NO_REVIEW_DEADLINE_DETAIL,
          now: deps.now?.() ?? Date.now(),
          say,
        }).catch(() => null);
        continue;
      }
      waiting.push(task.data);
    }
    if (unnamed) say(unreadableTasksLine(unnamed));
    // Oldest deadline first: the one closest to being paid by the 48-hour rule
    // is the one a bounded pass must look at.
    waiting.sort(
      (a, b) =>
        (a.reviewDueAt ? Date.parse(a.reviewDueAt) : Infinity) -
        (b.reviewDueAt ? Date.parse(b.reviewDueAt) : Infinity),
    );
    // The budget counts results tig actually checked, not records it read. Held
    // results stay AWAITING_REVIEW with the nearest deadline, so they sort to the
    // front of every pass: counting them would let three of them starve a real
    // new submission out of every pass it ever had, until the 48-hour rule paid
    // it unread.
    let looked = 0;
    let worked = 0;
    for (const task of waiting) {
      if (deps.signal?.aborted) break;
      if (worked >= SETTLE_MAX_PER_PASS) break;
      // A record that costs nothing to read is still a file read, and this pass
      // runs in front of whatever the requester actually typed. The list is
      // sorted by deadline, so the tail of a long one is the part with the most
      // time left. The two caps are separate on purpose: counting free tasks
      // against the work budget is what let three held results starve a new
      // submission out of every pass it ever had.
      if (looked >= SETTLE_MAX_LOOKED_PER_PASS) break;
      looked += 1;
      try {
        const outcome = await settleOnce(task, deps, budget);
        outcomes.push(outcome);
        if (outcome.worked) worked += 1;
      } catch (e) {
        // One result that could not be checked never stops the others, and the
        // requester is not shown a stack trace for a task they did not ask about.
        const reason = failureText(e);
        outcomes.push({
          taskId: task.id,
          action: "skipped",
          decision: null,
          reason,
          record: null,
          usedAi: false,
          worked: true,
        });
        worked += 1;
        say(
          `Not checked by tig — ${task.title}. tig could not finish checking this result: ${reason || "the check did not finish"}.`,
        );
      }
    }
    return { looked, outcomes, stopped: null };
  } catch (e) {
    // Not connected, offline, an unexpected shape. Silence about money is never
    // acceptable: a pass the requester cannot see failing is one they assume ran.
    const reason = failureText(e);
    say(passStoppedLine(reason));
    return { looked: 0, outcomes, stopped: reason };
  }
}
