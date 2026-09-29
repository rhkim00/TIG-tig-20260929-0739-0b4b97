import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { gh, requesterServices } from "./requester.js";
import type { WorkerOutput } from "./worker-code.js";
import type { WorkerReport, WorkspaceChanges } from "./worker-agent.js";
import {
  formatBytes,
  ResultSecretDetected,
  scanResultCommit,
  secretGateWhere,
} from "./worker-agent.js";
const exec = promisify(execFile);

// Where a worker's result lives in Git so the requester sees it in their own
// repository: a `tig/results/<taskId>` branch (pushed directly when the worker may
// push, otherwise to the worker's fork) and a pull request against the request branch.
export const resultPublication = z
  .object({
    repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    branch: z.string().regex(/^tig\/results\/[a-f0-9-]{36}$/),
    commit: z.string().regex(/^[a-f0-9]{40}$/),
    pullRequestUrl: z.url().nullable(),
  })
  .strict();
export type ResultPublication = z.infer<typeof resultPublication>;

export function renderWorkerReport(options: {
  taskId: string;
  requestUrl: string;
  title: string;
  provider: string;
  model: string;
  effort: string;
  elapsedMs: number;
  output: WorkerOutput;
}) {
  const { output } = options;
  return [
    `# Worker result: ${options.title}`,
    "",
    `Task: ${options.taskId}`,
    `Request: ${options.requestUrl}`,
    "",
    "**Submitted for the requester's review. Runtime tests were NOT run by Tokenisgold; the requester verifies before approving.**",
    "",
    "## What was done (AI-authored)",
    output.summary,
    "",
    "## Changed files",
    ...output.changes.map((c) => `- code/${c.path}`),
    ...output.deletedPaths.map((p) => `- deleted: code/${p}`),
    "",
    "## Execution (worker-declared, not verified)",
    `Local AI: ${options.provider}`,
    `Requested model / reasoning: ${options.model} / ${options.effort}`,
    `Elapsed local generation time: ${options.elapsedMs} ms`,
    "",
    "## Suggested tests — not executed",
    ...output.suggestedTests.map((s) => "- " + s),
    "",
    "## Limitations (AI-authored)",
    ...output.limitations.map((s) => "- " + s),
    "",
  ].join("\n");
}

// report.md for a workspace (tree-layout) result: the changes are a Git diff, so the
// report lists them with the diff stat, says what tig dropped or restored, and
// whether the platform mirrors the files or the pull request is the only place
// to review them.
export function renderWorkspaceReport(options: {
  taskId: string;
  requestUrl: string;
  title: string;
  provider: string;
  model: string;
  effort: string;
  elapsedMs: number;
  report: WorkerReport;
  changes: Pick<WorkspaceChanges, "files" | "stat" | "unexamined"> &
    Partial<Pick<WorkspaceChanges, "dropped" | "restored">>;
  mirrored: boolean;
  // false for a personal trial: nothing was published or submitted.
  submitted?: boolean;
}) {
  const { report, changes } = options;
  const tool = options.provider === "codex" ? "Codex" : "Claude Code";
  const execution =
    options.provider === "codex"
      ? "Codex ran agentically in the request checkout (workspace-write sandbox, no network); commands it ran are listed below and were not verified by Tokenisgold."
      : "Claude Code ran agentically in the request checkout (restricted file tools, no command execution).";
  const listed = changes.files.slice(0, 300);
  return [
    `# Worker result: ${options.title}`,
    "",
    `Task: ${options.taskId}`,
    `Request: ${options.requestUrl}`,
    "",
    options.submitted === false
      ? "**Personal trial. Not submitted. Not eligible for TIG payment. Runtime tests: NOT RUN.**"
      : "**Submitted for the requester's review. Runtime tests were NOT run by Tokenisgold; the requester verifies before approving.**",
    "",
    "## What was done (AI-authored)",
    report.summary,
    "",
    "## Changed files",
    ...listed.map((f) => `- ${f.status}: ${f.path}`),
    ...(changes.files.length > listed.length
      ? [`- … and ${changes.files.length - listed.length} more (see the diff)`]
      : []),
    ...(changes.files.length ? [] : ["- (none)"]),
    "",
    "```",
    changes.stat || "(no diff stat)",
    "```",
    "",
    ...(options.submitted === false
      ? []
      : [
          `Mirrored in the platform: ${options.mirrored ? "yes (code/ files in the submission)" : "no — review the changed files in the pull request"}.`,
        ]),
    // The secret gate read every blob of the commit that was pushed, byte for
    // byte, except the ones named here. P-052: this count is the gate's own, so
    // the sentence cannot describe a scan that did not happen.
    ...(changes.unexamined.length
      ? [
          `${changes.unexamined.length} file(s) in the pushed commit were not examined by the secret gate (a compressed or entropy-coded container): ${changes.unexamined
            .slice(0, 10)
            .map((u) => `${u.path} (${formatBytes(u.bytes)})`)
            .join(
              ", ",
            )}${changes.unexamined.length > 10 ? `, and ${changes.unexamined.length - 10} more` : ""}. Every other blob was read whole.`,
        ]
      : []),
    ...(changes.dropped?.length
      ? [
          "",
          "## Dropped from the commit by tig",
          ...changes.dropped.map((d) => `- ${d.path} (${d.reason})`),
        ]
      : []),
    ...(changes.restored?.length
      ? [
          "",
          "## Restored by tig (request documents are not part of the result)",
          ...changes.restored.map((p) => `- ${p}`),
        ]
      : []),
    "",
    "## Execution (worker-declared, not verified)",
    `Local AI: ${tool}`,
    `Mode: agentic in workspace`,
    execution,
    `Requested model / reasoning: ${options.model} / ${options.effort}`,
    `Elapsed local generation time: ${options.elapsedMs} ms`,
    "",
    "## Commands run by the tool (declared by the tool, not verified)",
    ...(report.commandsRun.length
      ? report.commandsRun.map((c) => "- " + c)
      : ["- none"]),
    "",
    "## Suggested tests — not executed by Tokenisgold",
    ...report.suggestedTests.map((s) => "- " + s),
    "",
    "## Limitations (AI-authored)",
    ...report.limitations.map((s) => "- " + s),
    "",
  ].join("\n");
}

export interface PublishResultInput {
  taskId: string;
  title: string;
  baseRepository: string; // requester's delivery repository OWNER/REPO
  baseBranch: string; // tig/requests/<id>
  baseCommit: string; // the pinned request commit
  // Bundle layout: full result files (code/... and report.md) written on top of the
  // request commit in a fresh checkout.
  files?: { path: string; content: string }[];
  // Tree layout: the result commit already exists in the worker's trial git dir.
  // workTree is only where a refusal tells the worker to look; the gate reads
  // the commit, never the checkout.
  workspace?: { gitDir: string; commit: string; workTree?: string };
  prBody: string;
}

export async function publishWorkerResult(
  input: PublishResultInput,
  s = requesterServices,
): Promise<ResultPublication> {
  const login = await s.githubIdentity();
  const base = await s.repository(input.baseRepository);
  if (!base.public)
    throw new Error("The requester's delivery repository is not public.");
  // Direct push when allowed; otherwise publish from the worker's own fork.
  let target = base.repository;
  if (!base.push) {
    await gh([
      "repo",
      "fork",
      `github.com/${base.repository}`,
      "--clone=false",
    ]);
    const forks = z
      .array(
        z.object({
          full_name: z.string(),
          fork: z.boolean(),
          owner: z.object({ login: z.string() }),
        }),
      )
      .parse(
        JSON.parse(
          await gh([
            "api",
            "--hostname",
            "github.com",
            `repos/${base.repository}/forks?per_page=100`,
          ]),
        ),
      );
    const mine = forks.find(
      (f) => f.fork && f.owner.login.toLowerCase() === login.toLowerCase(),
    );
    if (!mine)
      throw new Error(
        "Could not find your fork of the requester's repository. Fork it on GitHub and run tig work again.",
      );
    target = mine.full_name;
  }
  const branch = `tig/results/${input.taskId}`;
  const dir = await mkdtemp(join(tmpdir(), "tig-result-"));
  try {
    const hooks = join(dir, "no-hooks");
    await mkdir(hooks, { recursive: true, mode: 0o700 });
    const git = async (args: string[], at = dir) =>
      (
        await exec(
          "git",
          [
            "-C",
            at,
            "-c",
            `core.hooksPath=${hooks}`,
            "-c",
            "commit.gpgsign=false",
            "-c",
            "credential.helper=",
            ...args,
          ],
          {
            maxBuffer: 4_000_000,
            timeout: 120000,
            env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
          },
        )
      ).stdout.trim();
    let commit: string, pushFrom: string, gitDir: string;
    if (input.workspace) {
      // Tree layout: the commit was made in the trial's separate git dir; push it
      // from there after checking it really sits on the pinned request commit.
      gitDir = input.workspace.gitDir;
      commit = input.workspace.commit;
      const parents = (
        await git(["rev-list", "--parents", "-n", "1", commit], gitDir)
      ).split(/\s+/);
      if (parents[0] !== commit || parents[1] !== input.baseCommit)
        throw new Error(
          "The result commit does not sit on the pinned request commit. Nothing was pushed.",
        );
      pushFrom = gitDir;
    } else {
      await git(["init", "--template=", "-q"]);
      await git(["config", "user.name", "Tokenisgold worker"]);
      await git(["config", "user.email", "worker@tokenisgold.invalid"]);
      // The result commit sits on top of the exact request commit so the requester's
      // review diff is precisely "request → result".
      await git([
        "fetch",
        "-q",
        "--depth",
        "1",
        `https://github.com/${base.repository}.git`,
        input.baseBranch,
      ]);
      if ((await git(["rev-parse", "FETCH_HEAD"])) !== input.baseCommit)
        throw new Error(
          "The request branch no longer points at the pinned request commit. Nothing was pushed.",
        );
      await git(["checkout", "-q", "FETCH_HEAD"]);
      await rm(join(dir, "code"), { recursive: true, force: true });
      for (const f of input.files ?? []) {
        if (f.path.includes("..") || f.path.startsWith("/"))
          throw new Error("Unsafe result path.");
        await mkdir(dirname(join(dir, f.path)), { recursive: true });
        await writeFile(join(dir, f.path), f.content, { mode: 0o644 });
      }
      await git(["add", "--all", "--", "."]);
      await git([
        "commit",
        "-q",
        "-m",
        `Tokenisgold result for task ${input.taskId}`,
      ]);
      commit = await git(["rev-parse", "HEAD"]);
      pushFrom = dir;
      gitDir = join(dir, ".git");
    }
    // The gate, on the commit that is about to leave the machine, whichever way
    // it was built. Once a byte reaches a public branch it cannot be taken back,
    // so this runs here — after every caller, inside the function that pushes —
    // and not only where the result was described.
    const gate = await scanResultCommit({
      gitDir,
      baseCommit: input.baseCommit,
      commit,
    });
    if (gate.hits.length)
      throw new ResultSecretDetected(
        secretGateWhere(gate.hits),
        input.workspace?.workTree ?? pushFrom,
      );
    await s.push(pushFrom, target, branch, commit);
    const head = target === base.repository ? branch : `${login}:${branch}`;
    const body = join(dir, "pr-body.md");
    await writeFile(body, input.prBody, { mode: 0o600 });
    let pullRequestUrl: string | null = null;
    try {
      pullRequestUrl = (
        await gh([
          "pr",
          "create",
          "--repo",
          base.repository,
          "--base",
          input.baseBranch,
          "--head",
          head,
          "--title",
          `Tokenisgold result: ${input.title}`.slice(0, 200),
          "--body-file",
          body,
        ])
      )
        .trim()
        .split("\n")
        .at(-1)!;
    } catch {
      // A pull request for this head may already exist (retry after a failed submit).
      const existing = z
        .array(z.object({ url: z.string() }))
        .parse(
          JSON.parse(
            await gh([
              "pr",
              "list",
              "--repo",
              base.repository,
              "--head",
              head,
              "--state",
              "open",
              "--json",
              "url",
            ]),
          ),
        );
      pullRequestUrl = existing[0]?.url ?? null;
    }
    return resultPublication.parse({
      repository: target,
      branch,
      commit,
      pullRequestUrl:
        pullRequestUrl && /^https:\/\/github\.com\//.test(pullRequestUrl)
          ? pullRequestUrl
          : null,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
