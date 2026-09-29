import { z } from "zod";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  artifactSchema,
  cents,
  taskView,
} from "../../../packages/contracts/src/index.js";
import {
  requestEnvelope,
  requestLayout,
  renderRequest,
} from "../../../packages/contracts/src/request.js";
import {
  containsSecret,
  safePath,
} from "../../../packages/contracts/src/files.js";
import { api, loadConnection, validateOrigin } from "./client.js";
import { atomicJson, canonical, digest, stateDir } from "./drafts.js";
import {
  claudeEffortLevels,
  claudeReadiness,
  codexReadiness,
  findExecutable,
  localAiTools,
  type LocalAiProvider,
} from "./local-ai.js";
import { matchingModels, readCodexModels } from "./models.js";
import {
  generateWorkerCode,
  validateWorkerOutput,
  type WorkerOutput,
} from "./worker-code.js";
import {
  publishWorkerResult,
  renderWorkerReport,
  renderWorkspaceReport,
} from "./worker-git.js";
import {
  collectWorkspaceChanges,
  commitWorkspace,
  formatBytes,
  hasCommit,
  mirrorFits,
  prepareWorkspace,
  readCommittedChanges,
  ResultSecretDetected,
  runWorkerAgent,
  workerReport,
  workspacePaths,
  type ChangedFile,
  type WorkerReport,
} from "./worker-agent.js";
import type { UnexaminedBlob } from "./secret-gate.js";
import { Cancelled, RequestTerminal, type Terminal } from "./terminal.js";
import { ensureConnection } from "./wizard.js";
import { NoticeBoard } from "./notices.js";
import {
  activeLimit,
  isLimitMessage,
  recordLimitHit,
  resetClock,
} from "./limits.js";
import {
  proposeOnce,
  sleepUnlessAborted,
  toolSignals,
  watchAndWork,
  type WatchDeps,
} from "./worker-auto.js";
const exec = promisify(execFile);
type CodeFile = {
  path: string;
  content: string;
  sha256: string;
  source: "tracked" | "untracked-approved";
};

export function packageManifest(
  files: CodeFile[],
  deletedPaths: string[] = [],
) {
  const entries = files
    .map(({ path, sha256, source }) => ({ path, sha256, source }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return digest(
    canonical(
      deletedPaths.length
        ? { files: entries, deletedPaths: [...deletedPaths].sort() }
        : entries,
    ),
  );
}
function validateFiles(files: CodeFile[]) {
  const paths = new Set<string>();
  for (const file of files) {
    const path = file.path.toLowerCase();
    if (
      !safePath(file.path) ||
      /[\x00-\x1f\x7f]/.test(file.path) ||
      paths.has(path) ||
      file.content.includes("\0") ||
      containsSecret(file.content) ||
      digest(file.content) !== file.sha256
    )
      throw new Error(
        "The package contains unsafe paths, sensitive content or changed files.",
      );
    paths.add(path);
  }
  for (const path of paths) {
    const pieces = path.split("/");
    while (pieces.length > 1) {
      pieces.pop();
      if (paths.has(pieces.join("/")))
        throw new Error("Package file/directory paths conflict.");
    }
  }
}

export function readWorkerPackage(
  detail: unknown,
  userId: string,
  mode: "own" | "market" = "own",
) {
  const task = taskView.parse(detail);
  if (mode === "own" && task.requesterId !== userId)
    throw new Error(
      "This is another user's request; a personal trial uses your own published request. Run tig work --market to accept and submit it instead.",
    );
  if (mode === "market" && task.workerId !== userId)
    throw new Error(
      "request.md and its branch are public; accept the request to work on it.",
    );
  if (!task.requestUrl || task.developmentFixture)
    throw new Error(
      "Choose a Git request posted with tig. The fixed development exercise uses tig demo-run.",
    );
  const url = new URL(task.requestUrl);
  const match = url.pathname.match(
    /^\/([^/]+\/[^/]+)\/blob\/([a-f0-9]{40})\/request\.md$/,
  );
  if (url.origin !== "https://github.com" || !match || url.search || url.hash)
    throw new Error("A pinned Git request is required.");
  const raw = z
    .object({
      artifacts: z
        .array(
          z.object({
            base_commit: z.string(),
            summary: z.string(),
            files: artifactSchema.shape.files,
            deleted_paths: z.array(z.string()),
            manifest_hash: z.string(),
          }),
        )
        .max(2),
    })
    .parse(detail)
    .artifacts.find(
      (a) =>
        a.base_commit === match[2] &&
        a.files.some((f) => f.path === "request.json"),
    );
  if (!raw || raw.deleted_paths.length)
    throw new Error("The original request package is unavailable.");
  validateFiles(raw.files);
  if (packageManifest(raw.files) !== raw.manifest_hash)
    throw new Error("Request package hash mismatch.");
  const envelope = requestEnvelope.parse(
    JSON.parse(raw.files.find((f) => f.path === "request.json")!.content),
  );
  const request = envelope.request;
  if (
    envelope.repository !== match[1] ||
    renderRequest(envelope) !==
      raw.files.find((f) => f.path === "request.md")?.content ||
    task.title !== request.title ||
    task.requestCategory !== request.requestCategory ||
    cents(task.rewardTig) !== cents(request.rewardTig) ||
    canonical(task.aiRequirement) !== canonical(request.aiRequirement) ||
    task.executionDeadlineAt !== request.executionDeadlineAt ||
    raw.files.some(
      (f) =>
        !["request.md", "request.json"].includes(f.path) &&
        !f.path.startsWith("code/"),
    )
  )
    throw new Error("The request document does not match its posted terms.");
  // Tree layout: the artifact holds only the two documents; the code is the request
  // branch itself, cloned into a workspace when the work starts. No inline code and
  // no 98-file / 180 KB limit apply. Bundle layout keeps the inline code/ package.
  const layout = requestLayout(envelope);
  if (layout === "tree" && raw.files.length !== 2)
    throw new Error("The request package does not match its tree layout.");
  // The branch the request was published as, from the task the server shows a
  // participant: main for a request's own repository, tig/requests/<id> for an
  // earlier request in a shared one (the default when the detail omits it).
  const branch =
    z
      .object({
        gitRequest: z.object({ branch: z.string() }).loose().optional(),
      })
      .loose()
      .parse(detail).gitRequest?.branch ?? `tig/requests/${envelope.id}`;
  const code =
    layout === "tree"
      ? []
      : raw.files
          .filter((f) => f.path.startsWith("code/"))
          .map((f) => ({ ...f, path: f.path.slice(5) }));
  // code may be empty for a new-project request; the AI then creates files.
  if (
    layout === "bundle" &&
    (code.length > 98 || Buffer.byteLength(JSON.stringify(raw.files)) > 180000)
  )
    throw new Error(
      "This trial supports up to 98 code files and about 160 KB of selected context.",
    );
  return {
    task,
    envelope,
    layout,
    code,
    files: raw.files,
    commit: match[2],
    branch,
    manifestHash: raw.manifest_hash,
  };
}
export type WorkerPackage = ReturnType<typeof readWorkerPackage>;

export function applyWorkerChanges(original: CodeFile[], output: WorkerOutput) {
  validateWorkerOutput(output);
  const files = new Map(original.map((f) => [f.path, f]));
  for (const path of output.deletedPaths) {
    if (!files.delete(path))
      throw new Error("The result deletes a file that was not in the request.");
  }
  for (const file of output.changes)
    files.set(file.path, {
      ...file,
      sha256: digest(file.content),
      source: "tracked",
    });
  const result = [...files.values()].sort((a, b) =>
    a.path.localeCompare(b.path),
  );
  if (
    !result.length ||
    result.length > 98 ||
    Buffer.byteLength(JSON.stringify(result)) > 500000
  )
    throw new Error(
      "The result package is empty or exceeds the trial size limit.",
    );
  validateFiles(result);
  return result;
}

async function trialLock(folder: string) {
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const path = join(folder, "active.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const file = await open(path, "wx", 0o600);
      await file.writeFile(String(process.pid));
      await file.close();
      return () => rm(path, { force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const pid = Number(await readFile(path, "utf8"));
      if (!Number.isSafeInteger(pid) || pid <= 0)
        throw new Error("A worker lock needs inspection before starting.");
      try {
        process.kill(pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") {
          throw new Error(
            `A previous worker process stopped unexpectedly. Its saved files are preserved. Inspect and remove the stale lock before retrying: ${path}`,
          );
        }
      }
      throw new Error(
        "Another tig work session is active. Continue or stop that session first.",
      );
    }
  }
  throw new Error("Could not acquire the worker session lock. Try again.");
}

const candidateSchema = z
  .object({
    // Earlier candidates were always Codex; keep them readable.
    provider: z.enum(["codex", "claude"]).default("codex"),
    model: z.string(),
    effort: z.string(),
    elapsedMs: z.number().nonnegative(),
    completedAt: z.iso.datetime(),
    output: z.unknown(),
  })
  .strict();
type Candidate = z.infer<typeof candidateSchema>;

export async function saveWorkerResult(
  folder: string,
  input: WorkerPackage,
  candidate: Candidate,
) {
  const output = validateWorkerOutput(candidate.output),
    files = applyWorkerChanges(input.code, output);
  const temporary = await mkdtemp(join(folder, ".result-"));
  const destination = join(folder, "result");
  const gitEnv = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    TEMP: process.env.TEMP,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
  };
  const git = async (args: string[]) =>
    (
      await exec(
        "git",
        [
          "-c",
          "core.hooksPath=" + join(folder, "empty-hooks"),
          "-c",
          "commit.gpgsign=false",
          "-c",
          "user.name=Tokenisgold local trial",
          "-c",
          "user.email=local-trial@tokenisgold.invalid",
          ...args,
        ],
        { cwd: temporary, env: gitEnv, maxBuffer: 1000000 },
      )
    ).stdout.trim();
  const write = async (path: string, content: string) => {
    await mkdir(dirname(join(temporary, path)), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(join(temporary, path), content, {
      mode: 0o600,
      flag: "wx",
    });
  };
  try {
    await mkdir(join(folder, "empty-hooks"), { recursive: true, mode: 0o700 });
    await git(["init", "--template=" + join(folder, "empty-hooks")]);
    await mkdir(join(temporary, ".git", "info"), { recursive: true });
    await writeFile(
      join(temporary, ".git", "info", "exclude"),
      "/local-receipt.json\n",
      { flag: "a" },
    );
    for (const file of input.files) await write(file.path, file.content);
    await git(["add", "--", "."]);
    await git(["commit", "-m", "Snapshot of published TIG request"]);
    const baseline = await git(["rev-parse", "HEAD"]);
    await rm(join(temporary, "code"), { recursive: true, force: true });
    for (const file of files) await write("code/" + file.path, file.content);
    const result = {
      version: 1,
      kind: "personal_trial",
      taskId: input.task.id,
      requestUrl: input.task.requestUrl,
      inputCommit: input.commit,
      sourceCommit: input.envelope.sourceCommit,
      inputManifestHash: input.manifestHash,
      requestedAI: input.task.aiRequirement,
      execution: {
        provider: candidate.provider,
        requestedModel: candidate.model,
        requestedEffort: candidate.effort,
        source: "client_observed",
        providerVerified: false,
        elapsedMs: candidate.elapsedMs,
        completedAt: candidate.completedAt,
      },
      checks: [
        {
          name: "package paths, content hashes and limits",
          status: "passed",
          source: "local_validator",
        },
        {
          name: "runtime tests and acceptance checks",
          status: "not_run",
          source: "local_validator",
          reason:
            "Verified command execution is not available in this personal trial.",
        },
      ],
      submitted: false,
      paymentEligible: false,
      reportSource: "ai_authored",
      summary: output.summary,
      suggestedTests: output.suggestedTests,
      limitations: output.limitations,
      artifact: {
        baseCommit: input.commit,
        summary: output.summary,
        files,
        deletedPaths: output.deletedPaths,
        manifestHash: packageManifest(files, output.deletedPaths),
      },
    };
    await write("result.json", JSON.stringify(result, null, 2) + "\n");
    const report = [
      "# Personal worker trial",
      "",
      `Task: ${input.task.id}`,
      `Request: ${input.task.requestUrl}`,
      "",
      "**Not submitted. Not eligible for TIG payment. Runtime tests: NOT RUN.**",
      "",
      "## Changes (AI-authored)",
      output.summary,
      "",
      "## Execution",
      `Requested CLI model: ${candidate.model}`,
      `Requested reasoning: ${candidate.effort}`,
      "Provider/model execution is not independently verified.",
      `Elapsed local generation time: ${candidate.elapsedMs} ms`,
      "",
      "## Suggested tests — not executed",
      ...output.suggestedTests.map((s) => "- " + s),
      "",
      "## Limitations (AI-authored)",
      ...output.limitations.map((s) => "- " + s),
      "",
      "## Validation",
      "Package paths, hashes and limits checked locally. Runtime/acceptance checks have not run. The posted task and its TIG escrow are unchanged.",
      "",
    ].join("\n");
    await write("report.md", report);
    await git(["add", "--all", "--", "."]);
    await git([
      "commit",
      "-m",
      "Personal worker result; runtime validation pending",
    ]);
    const commit = await git(["rev-parse", "HEAD"]);
    const receipt = {
      folder: destination,
      taskId: input.task.id,
      baseline,
      commit,
      submitted: false,
      paymentEligible: false,
    };
    // Receipt and output become visible together. A retry after rename never repeats inference.
    await write("local-receipt.json", JSON.stringify(receipt, null, 2) + "\n");
    await rename(temporary, destination);
    return receipt;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export const workServices = {
  api,
  loadConnection,
  findExecutable,
  codexReadiness,
  claudeReadiness,
  readCodexModels,
  generateWorkerCode,
  publishResult: publishWorkerResult,
  // Tree layout: clone the request branch into a workspace and run the tool there.
  prepareWorkspace,
  runWorkerAgent,
};
type WorkServices = Omit<typeof workServices, "claudeReadiness"> & {
  claudeReadiness?: typeof claudeReadiness;
};
// The worker chooses among their own installed official CLIs — explicit choice, no
// default. A single different CLI needs an explicit substitution. Codex models are
// matched in its catalog; Claude Code names are passed through unchanged.
export async function selectWorkerAi(
  requirement: { provider: LocalAiProvider; model: string; effort: string },
  ui: Terminal,
  services: WorkServices,
  signal?: AbortSignal,
  // A tool decided before the user's yes (tig work --market/--watch): no prompts here.
  preset?: LocalAiProvider,
) {
  const requested = requirement.provider;
  const found: Record<LocalAiProvider, string | null> = {
    codex: await services.findExecutable("codex"),
    claude: await services.findExecutable("claude"),
  };
  const installed = (["codex", "claude"] as const).filter((p) => found[p]);
  if (!installed.length)
    throw new Error(
      `${localAiTools[requested].name} was not found in your terminal or VS Code extensions, and no other supported local AI is installed. Install it: ${localAiTools[requested].installUrl}, then run tig work again.`,
    );
  let provider: LocalAiProvider;
  if (preset && found[preset]) {
    provider = preset;
    if (provider !== requested)
      ui.say(
        `This request asks for ${localAiTools[requested].name}; ${localAiTools[provider].name} runs it here, as proposed.`,
      );
  } else if (installed.length > 1) {
    ui.section("local AI", "Choose who implements this work");
    provider =
      installed[
        await ui.choose(
          `Both Codex and Claude Code are installed. The request asks for ${localAiTools[requested].name}; which one should run this work? It uses that tool's own sign-in and plan allowance.`,
          installed.map((p) => localAiTools[p].name),
          null,
        )
      ];
  } else {
    provider = installed[0];
    if (provider !== requested) {
      ui.say(
        `This request asks for ${localAiTools[requested].name}, which is not installed here. ${localAiTools[provider].name} is available.`,
      );
      if (
        !(await ui.confirm(
          `Run this work with ${localAiTools[provider].name} instead?`,
        ))
      )
        throw new Cancelled();
    }
  }
  const tool = localAiTools[provider];
  const binary = found[provider]!;
  await ui.busy(`Checking local ${tool.name}…`, () =>
    provider === "codex"
      ? services.codexReadiness(binary)
      : (services.claudeReadiness ?? claudeReadiness)(binary),
  );
  const requestedModel = requirement.model,
    effort = requirement.effort;
  let model: string, availability: string;
  if (provider === "codex") {
    const models = await ui.busy("Checking available models…", () =>
      services.readCodexModels(binary, signal),
    );
    const matches = matchingModels(models, requestedModel);
    const visible = models.filter((m) => !m.hidden);
    if (provider !== requested && visible[0]) {
      // Substituting for Claude Code: the requested model is not a Codex model, so
      // the catalog's current model runs it, at the requested effort when supported.
      // Disclosed on screen and recorded in the submission (actual provider/model).
      const chosen = matches.length === 1 ? matches[0] : visible[0];
      const efforts = chosen.supportedReasoningEfforts.map(
        (e) => e.reasoningEffort,
      );
      const useEffort = efforts.includes(effort)
        ? effort
        : chosen.defaultReasoningEffort || efforts[0] || effort;
      ui.say(
        `Substituting ${localAiTools[requested].name} ${requestedModel} / ${effort} with Codex ${chosen.model} / ${useEffort} (the request's model is not in the Codex catalog).`,
      );
      return {
        provider,
        binary,
        tool,
        model: chosen.model,
        effort: useEffort,
        requestedModel,
        availability: "substituted tool; current Codex catalog model",
      };
    }
    if (
      matches.length !== 1 ||
      !matches[0].supportedReasoningEfforts.some(
        (e) => e.reasoningEffort === effort,
      )
    )
      throw new Error(
        `The requested model/reasoning cannot be matched unambiguously: ${requestedModel} / ${effort}. No AI call was made. Available: ${models.map((m) => m.model + " (" + m.supportedReasoningEfforts.map((e) => e.reasoningEffort).join(", ") + ")").join("; ")}`,
      );
    model = matches[0].model;
    availability = "matched in the Codex model catalog";
  } else if (provider !== requested) {
    // Substituting for Codex: a Codex model name means nothing to Claude Code, so
    // Claude Code's default model ("opus") runs it, at the requested effort when
    // that is a Claude effort level, else medium. Disclosed on screen and recorded.
    const claudeName = /^(opus|sonnet|haiku|claude-)/i.test(requestedModel);
    const useModel = claudeName ? requestedModel : "opus";
    const useEffort = claudeEffortLevels.includes(
      effort as (typeof claudeEffortLevels)[number],
    )
      ? effort
      : "medium";
    ui.say(
      `Substituting Codex ${requestedModel} / ${effort} with Claude Code ${useModel} / ${useEffort}.`,
    );
    return {
      provider,
      binary,
      tool,
      model: useModel,
      effort: useEffort,
      requestedModel,
      availability: claudeName
        ? "substituted tool; not verified by TIG; Claude Code resolves the model name"
        : "substituted tool; Claude Code default model",
    };
  } else {
    if (
      !claudeEffortLevels.includes(
        effort as (typeof claudeEffortLevels)[number],
      )
    )
      throw new Error(
        `The requested reasoning level "${effort}" is not a Claude Code effort level (${claudeEffortLevels.join(", ")}). No AI call was made.`,
      );
    model = requestedModel;
    availability = "not verified by TIG; Claude Code resolves the model name";
  }
  return {
    provider,
    binary,
    tool,
    model,
    effort,
    requestedModel,
    availability,
  };
}
const mutation = (body: unknown) => ({ body, key: randomUUID() });
export const HEARTBEAT_MS = 5 * 60000;
type TaskView = z.infer<typeof taskView>;
type SelectedAi = Awaited<ReturnType<typeof selectWorkerAi>>;
// Keep the claim alive while the long steps run (clone, AI, diff): heartbeats renew
// the 30-minute phase and keep our version current for the submit that follows.
function startHeartbeat(
  id: string,
  services: WorkServices,
  task: { current: TaskView },
) {
  const timer = setInterval(() => {
    void services
      .api(
        `/v1/tasks/${id}/heartbeat`,
        mutation({
          expectedVersion: task.current.version,
          generation: task.current.generation,
        }),
      )
      .then((t) => {
        task.current = taskView.parse(t);
      })
      .catch(() => {
        /* the submit step reports the real state */
      });
  }, HEARTBEAT_MS);
  return () => clearInterval(timer);
}
// The tool hit its usage limit mid-job: remember that on this computer and offer
// the other installed tool once (disclosed here and in the submission).
async function generateWithLimitFallback<T>(
  ai: SelectedAi,
  generate: (with_: SelectedAi) => Promise<T>,
  o: {
    id: string;
    ui: Terminal;
    services: WorkServices;
    requirement: TaskView["aiRequirement"];
    signal?: AbortSignal;
  },
): Promise<{ output: T; ai: SelectedAi }> {
  try {
    return { output: await generate(ai), ai };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (!isLimitMessage(message)) throw e;
    const hit = await recordLimitHit(ai.provider, message);
    const other: LocalAiProvider = ai.provider === "codex" ? "claude" : "codex";
    const otherUsable =
      (await o.services.findExecutable(other)) && !(await activeLimit(other));
    if (
      !otherUsable ||
      !(await o.ui.confirm(
        `${ai.tool.name} hit its limit (resets ${resetClock(hit)}). Run this request with ${localAiTools[other].name} instead? The requester sees the actual tool in your result.`,
      ))
    )
      throw new Error(
        `${ai.tool.name} hit its limit (resets ${resetClock(hit)}). Your accepted request stays yours for 30 minutes; run tig work ${o.id} to continue after the reset.`,
      );
    const next = await selectWorkerAi(
      o.requirement,
      o.ui,
      o.services,
      o.signal,
      other,
    );
    return { output: await generate(next), ai: next };
  }
}
// A finished agentic run: the report plus the local result commit. Reused on a
// retry after a failed push/submit; a missing commit (workspace removed) discards it.
const workspaceCandidateSchema = z
  .object({
    kind: z.literal("workspace"),
    provider: z.enum(["codex", "claude"]),
    model: z.string(),
    effort: z.string(),
    mode: z.literal("agentic"),
    elapsedMs: z.number().nonnegative(),
    completedAt: z.iso.datetime(),
    report: workerReport,
    commit: z.string().regex(/^[a-f0-9]{40}$/),
    dropped: z.array(z.object({ path: z.string(), reason: z.string() })),
    restored: z.array(z.string()),
    // Saved before this field existed: an older candidate has no ignored paths.
    ignoredIncluded: z.array(z.string()).default([]),
  })
  .strict();
type WorkspaceCandidate = z.infer<typeof workspaceCandidateSchema>;
const WORKSPACE_CANDIDATE = "workspace-candidate.json";
async function readWorkspaceCandidate(folder: string) {
  let candidate: WorkspaceCandidate;
  try {
    candidate = workspaceCandidateSchema.parse(
      JSON.parse(await readFile(join(folder, WORKSPACE_CANDIDATE), "utf8")),
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(
      "Saved worker output needs inspection; it will not be overwritten.",
    );
  }
  return (await hasCommit(folder, candidate.commit)) ? candidate : undefined;
}
// Clone → agentic run → staged diff → local commit, or the D4 outcome when the tool
// changed nothing. The caller decides what happens after the commit.
async function runWorkspace(o: {
  id: string;
  title: string;
  input: WorkerPackage;
  folder: string;
  ai: SelectedAi;
  ui: Terminal;
  services: WorkServices;
  requirement: TaskView["aiRequirement"];
  signal?: AbortSignal;
}): Promise<
  | { candidate: WorkspaceCandidate }
  | {
      candidate: undefined;
      tool: string;
      dropped: { path: string; reason: string }[];
      restored: string[];
    }
> {
  const branch = o.input.branch;
  const started = Date.now();
  await o.ui.busy(`Cloning ${branch} into a private workspace…`, () =>
    o.services.prepareWorkspace({
      trial: o.folder,
      source: `https://github.com/${o.input.envelope.repository}.git`,
      branch,
      baseCommit: o.input.commit,
    }),
  );
  const { output: report, ai } = await generateWithLimitFallback(
    o.ai,
    (with_) =>
      o.ui.busy(
        `${with_.tool.name} is implementing the request in the workspace…`,
        () =>
          o.services.runWorkerAgent({
            provider: with_.provider,
            binary: with_.binary,
            model: with_.model,
            effort: with_.effort,
            trial: o.folder,
            title: o.title,
            signal: o.signal,
          }),
      ),
    o,
  );
  const changes = await collectWorkspaceChanges(o.folder);
  if (!changes.files.length)
    return {
      candidate: undefined,
      tool: ai.tool.name,
      dropped: changes.dropped,
      restored: changes.restored,
    };
  const commit = await commitWorkspace(o.folder, o.id);
  const candidate: WorkspaceCandidate = {
    kind: "workspace",
    provider: ai.provider,
    model: ai.model,
    effort: ai.effort,
    mode: "agentic",
    elapsedMs: Date.now() - started,
    completedAt: new Date().toISOString(),
    report,
    commit,
    dropped: changes.dropped,
    restored: changes.restored,
    ignoredIncluded: changes.ignoredIncluded,
  };
  await atomicJson(join(o.folder, WORKSPACE_CANDIDATE), candidate);
  return { candidate };
}
// Nothing was committed. P-052: that is only "no change" when the tool really
// wrote nothing — work that was left out (a .gitignore'd path, a protected file)
// or undone (the request documents) is said plainly instead.
const noChangeNotice = (
  tool: string,
  id: string,
  dropped: { path: string; reason: string }[],
  restored: string[] = [],
) => {
  const retry = `Run tig work ${id} to try again.`;
  if (dropped.length)
    return `${tool} wrote files, but none of them could be committed, so nothing was submitted: ${dropped
      .map((d) => `${d.path} (${d.reason})`)
      .join(", ")}. ${retry}`;
  if (restored.length)
    return `${tool} changed only the request documents (${restored.join(", ")}), which tig restored; nothing else was written, so nothing was submitted. ${retry}`;
  return `${tool} made no change; nothing submitted. ${retry}`;
};
// What the shared report renderer cannot know: which blobs of the pushed commit
// the secret gate could not examine, and which paths the requester's .gitignore
// excludes are in the commit anyway. P-052 — the result states both, by name,
// and the count is the gate's own (worker-agent.ts scanResultCommit), never a
// guess from the collection scan.
const NAMED_UNEXAMINED = 20;
export function resultDisclosures(changes: {
  files: ChangedFile[];
  unexamined: UnexaminedBlob[];
  ignoredIncluded: string[];
}) {
  const lines: string[] = [];
  if (changes.unexamined.length)
    lines.push(
      "",
      `## Not examined by the secret gate (${changes.unexamined.length} file(s))`,
      ...changes.unexamined
        .slice(0, NAMED_UNEXAMINED)
        .map((u) => `- ${u.path} (${formatBytes(u.bytes)}, ${u.reason})`),
      ...(changes.unexamined.length > NAMED_UNEXAMINED
        ? [`- … and ${changes.unexamined.length - NAMED_UNEXAMINED} more`]
        : []),
      "Their first bytes are a known binary container, where a key does not survive as ASCII, so the patterns cannot be matched in them. Every other blob in the pushed commit was read byte for byte, whatever its encoding.",
    );
  if (changes.ignoredIncluded.length)
    lines.push(
      "",
      "## Committed although the requester's .gitignore excludes them",
      ...changes.ignoredIncluded.map((p) => `- ${p}`),
      "The tool wrote these into ignored paths; they passed the same protected-path, size and secret checks as every other file.",
    );
  return lines.length ? lines.join("\n") + "\n" : "";
}
// The same two facts as one line each for the screen.
export function disclosureNotes(changes: {
  files: ChangedFile[];
  unexamined: UnexaminedBlob[];
  ignoredIncluded: string[];
}) {
  const named = changes.unexamined.slice(0, 5);
  return [
    ...(changes.unexamined.length
      ? [
          `${changes.unexamined.length} file(s) in the pushed commit were not examined by the secret gate (binary format): ${named.map((u) => `${u.path} (${formatBytes(u.bytes)})`).join(", ")}${changes.unexamined.length > named.length ? `, and ${changes.unexamined.length - named.length} more` : ""}.`,
        ]
      : []),
    ...(changes.ignoredIncluded.length
      ? [
          `Committed although the requester's .gitignore excludes them: ${changes.ignoredIncluded.join(", ")}.`,
        ]
      : []),
  ];
}
// Marketplace work on a tree-layout request: workspace → PR against the request
// branch → platform submission (mirrored files when they fit, else report.md only).
async function workspaceMarketWork(o: {
  id: string;
  task: { current: TaskView };
  input: WorkerPackage;
  folder: string;
  ai: SelectedAi;
  ui: Terminal;
  services: WorkServices;
  signal?: AbortSignal;
}) {
  const { id, ui, services, input, folder } = o;
  const branch = input.branch;
  let candidate = await readWorkspaceCandidate(folder);
  if (candidate)
    ui.say("Reusing the saved AI result for this request; no new AI call.");
  else {
    const stop = startHeartbeat(id, services, o.task);
    try {
      const run = await runWorkspace({
        id,
        title: o.task.current.title,
        input,
        folder,
        ai: o.ai,
        ui,
        services,
        requirement: o.task.current.aiRequirement,
        signal: o.signal,
      });
      if (!run.candidate) {
        ui.section("marketplace", "Nothing to submit");
        ui.say(noChangeNotice(run.tool, id, run.dropped, run.restored));
        return {
          taskId: id,
          state: o.task.current.state,
          submitted: false as const,
          provider: o.ai.provider,
          files: 0,
          git: null,
          submittedAt: null,
        };
      }
      candidate = run.candidate;
    } finally {
      stop();
    }
  }
  if (o.signal?.aborted) throw new Cancelled();
  const task = o.task.current;
  const changes = {
    ...(await readCommittedChanges(folder, input.commit, candidate.commit)),
    dropped: candidate.dropped,
    restored: candidate.restored,
    ignoredIncluded: candidate.ignoredIncluded,
  };
  const mirrored = mirrorFits(changes.files);
  const reportText =
    renderWorkspaceReport({
      taskId: id,
      requestUrl: task.requestUrl!,
      title: task.title,
      provider: candidate.provider,
      model: candidate.model,
      effort: candidate.effort,
      elapsedMs: candidate.elapsedMs,
      report: candidate.report,
      changes,
      mirrored,
    }) + resultDisclosures(changes);
  // The scan covers every changed text file (readCommittedChanges), the report and
  // the summary. Anything that looks like a secret stops before push and submit.
  if (containsSecret(reportText))
    throw new ResultSecretDetected(
      ["report.md"],
      workspacePaths(folder).workTree,
    );
  const files = [
    ...(mirrored
      ? changes.files
          .filter((f) => f.status !== "deleted")
          .map((f) => ({
            path: `code/${f.path}`,
            content: f.content!,
            sha256: digest(f.content!),
            source: "tracked" as const,
          }))
      : []),
    {
      path: "report.md",
      content: reportText,
      sha256: digest(reportText),
      source: "tracked" as const,
    },
  ];
  const deletedPaths = mirrored
    ? changes.files
        .filter((f) => f.status === "deleted")
        .map((f) => `code/${f.path}`)
    : [];
  validateFiles(files);
  const changed = changes.files.length;
  const prBody = `${reportText.length > 60000 ? reportText.slice(0, 60000) + "\n\n[report truncated; the full report.md is in the Tokenisgold submission]" : reportText}\n\n---\nTokenisgold task ${id}. This pull request is the review surface for the changed files${mirrored ? "" : " (they are not mirrored on the platform)"}; runtime tests were not run by Tokenisgold.`;
  // Publish to Git first so the requester can see the commit in their repository;
  // then register the same result with the platform for review and settlement.
  const publication = await ui.busy(
    "Publishing the result branch and pull request to the requester's repository…",
    () =>
      services.publishResult({
        taskId: id,
        title: task.title,
        baseRepository: input.envelope.repository,
        baseBranch: branch,
        baseCommit: input.commit,
        workspace: {
          gitDir: workspacePaths(folder).gitDir,
          commit: candidate.commit,
          workTree: workspacePaths(folder).workTree,
        },
        prBody,
      }),
  );
  const submitted = taskView.parse(
    await ui.busy("Submitting your result for the requester's review…", () =>
      services.api(
        `/v1/tasks/${id}/submit`,
        mutation({
          expectedVersion: task.version,
          generation: task.generation,
          report: candidate.report.summary,
          artifact: {
            baseCommit: input.commit,
            summary: `Worker result for: ${task.title}`,
            files,
            deletedPaths,
            manifestHash: packageManifest(files, deletedPaths),
          },
          execution: {
            provider: candidate.provider,
            model: candidate.model,
            effort: candidate.effort,
          },
          gitResult: publication,
        }),
      ),
    ),
  );
  const receipt = {
    taskId: id,
    state: submitted.state,
    reviewDueAt: submitted.reviewDueAt,
    files: files.length,
    changedFiles: changed,
    mirrored,
    mode: candidate.mode,
    provider: candidate.provider,
    git: publication,
    submitted: true as const,
    submittedAt: new Date().toISOString(),
  };
  await atomicJson(join(folder, "submission.json"), receipt);
  ui.section("marketplace", "Submitted for review");
  // A deletion-only result mirrors deletedPaths and no file content: saying
  // "the 0 changed file(s)" alone would report nothing where something went
  // (P-052), so the deletions are counted in the same sentence.
  const mirrorNote = `The platform mirrors the ${files.length - 1} changed file(s)${deletedPaths.length ? `, ${deletedPaths.length} deleted file(s)` : ""} and report.md.`;
  ui.say(
    `${changed} changed file(s) were committed to ${publication.repository}@${publication.branch} (${publication.commit.slice(0, 7)})${publication.pullRequestUrl ? `\nPull request: ${publication.pullRequestUrl}` : ""}\n${mirrored ? mirrorNote : "The platform holds report.md only; the pull request is where the requester reviews the changed files."}${candidate.dropped.length ? `\nDropped from the result: ${candidate.dropped.map((d) => `${d.path} (${d.reason})`).join(", ")}.` : ""}${disclosureNotes(
      changes,
    )
      .map((n) => `\n${n}`)
      .join(
        "",
      )}\nPlatform state: ${submitted.state}. The requester can approve (pays ${task.rewardTig} TIG), report an issue (refund), or let the 48-hour window pass (automatic payment)${submitted.reviewDueAt ? ` — review due ${submitted.reviewDueAt}` : ""}.\nRuntime tests were not run by TIG; that is stated in the submission and in report.md.`,
  );
  return receipt;
}
// Marketplace work on another user's Git request: accept → start → local AI →
// submit for the requester's review. Runtime tests are not run; the server records
// the result as an unverified local trial and the requester decides.
export async function marketWork(
  id: string | undefined,
  ui: Terminal,
  signal?: AbortSignal,
  services: WorkServices = workServices,
  // From a proposal the user already said yes to: the tool is fixed and the
  // accept question is not repeated (P-024/P-025: one yes covers the job).
  preset?: { provider: LocalAiProvider; assumeYes: boolean },
) {
  const connection = await services.loadConnection();
  const user = z.object({ id: z.uuid() }).parse(await services.api("/v1/me"));
  const open = z
    .object({ tasks: z.array(taskView) })
    .parse(await services.api("/v1/tasks"))
    .tasks.filter(
      (t) =>
        t.requesterId !== user.id &&
        !!t.requestUrl &&
        !t.developmentFixture &&
        t.state === "OPEN",
    );
  if (!id) {
    if (!open.length)
      throw new Error(
        "No open Git requests from other users right now. Check back later, or run tig work to try your own request.",
      );
    ui.section("marketplace", "Open requests you can work on");
    id =
      open[
        await ui.choose(
          "Which request do you want to work on? Accepting reserves it for you; you must start within 10 minutes.",
          open.map(
            (t) =>
              `${t.title} · ${t.rewardTig} TIG · asks for ${localAiTools[t.aiRequirement.provider].name}`,
          ),
          null,
        )
      ].id;
  }
  z.uuid().parse(id);
  let task = taskView.parse(await services.api(`/v1/tasks/${id}`));
  if (task.requesterId === user.id)
    throw new Error(
      "This is your own request. Run tig work <id> to try it as a personal trial.",
    );
  if (!task.requestUrl || task.developmentFixture)
    throw new Error("Choose a Git request posted with tig.");
  const mine = task.workerId === user.id;
  if (!mine && task.state !== "OPEN")
    throw new Error(
      `This request is ${task.state.toLowerCase()} and cannot be accepted.`,
    );
  let ai = await selectWorkerAi(
    task.aiRequirement,
    ui,
    services,
    signal,
    preset?.provider,
  );
  if (!mine) {
    ui.section("marketplace", task.title);
    ui.say(
      `Requested: ${ai.requestedModel} / ${ai.effort}\nCLI will request: ${ai.model} / ${ai.effort} (${ai.availability})\nReward: ${task.rewardTig} TIG, paid only if the requester approves (or does not respond within 48 hours after your submission).\n${ai.tool.name} will implement the request with your own plan allowance. Runtime tests are NOT run by TIG; the requester reviews your files and report. Accepting reserves this request for you; start happens immediately.`,
    );
    if (
      !preset?.assumeYes &&
      !(await ui.confirm(
        "Accept this request and submit your result for review?",
      ))
    )
      throw new Cancelled();
    task = taskView.parse(
      await services.api(
        `/v1/tasks/${id}/claim`,
        mutation({
          expectedVersion: task.version,
          consent: "accept_this_task",
        }),
      ),
    );
  }
  if (task.state === "CLAIMED")
    task = taskView.parse(
      await services.api(
        `/v1/tasks/${id}/start`,
        mutation({
          expectedVersion: task.version,
          generation: task.generation,
        }),
      ),
    );
  if (task.state !== "EXECUTING")
    throw new Error(
      `This request is ${task.state.toLowerCase()}; nothing to submit.`,
    );
  const input = readWorkerPackage(
    await services.api(`/v1/tasks/${id}`),
    user.id,
    "market",
  );
  const root = join(stateDir(), "worker-trials");
  const folder = join(
    root,
    digest(
      `${validateOrigin(connection.origin)}:${user.id}:${id}:${input.manifestHash}:market`,
    ),
  );
  const unlock = await trialLock(root);
  try {
    await mkdir(folder, { recursive: true, mode: 0o700 });
    if (input.layout === "tree")
      return await workspaceMarketWork({
        id,
        task: { current: task },
        input,
        folder,
        ai,
        ui,
        services,
        signal,
      });
    let candidate: Candidate | undefined;
    try {
      candidate = candidateSchema.parse(
        JSON.parse(await readFile(join(folder, "candidate.json"), "utf8")),
      );
      validateWorkerOutput(candidate.output);
      ui.say("Reusing the saved AI result for this request; no new AI call.");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error(
          "Saved worker output needs inspection; it will not be overwritten.",
        );
    }
    if (!candidate) {
      const started = Date.now();
      const ref = { current: task };
      const stop = startHeartbeat(id, services, ref);
      let output;
      try {
        const generate = (with_: typeof ai) =>
          ui.busy(`${with_.tool.name} is implementing the request…`, () =>
            services.generateWorkerCode({
              provider: with_.provider,
              binary: with_.binary,
              model: with_.model,
              effort: with_.effort,
              data: {
                request: input.envelope.request,
                files: input.code.map(({ path, content }) => ({
                  path,
                  content,
                })),
              },
              signal,
            }),
          );
        ({ output, ai } = await generateWithLimitFallback(ai, generate, {
          id,
          ui,
          services,
          requirement: task.aiRequirement,
          signal,
        }));
      } finally {
        stop();
        task = ref.current;
      }
      applyWorkerChanges(input.code, output);
      candidate = {
        provider: ai.provider,
        model: ai.model,
        effort: ai.effort,
        elapsedMs: Date.now() - started,
        completedAt: new Date().toISOString(),
        output,
      };
      await atomicJson(join(folder, "candidate.json"), candidate);
    }
    if (signal?.aborted) throw new Cancelled();
    const output = validateWorkerOutput(candidate.output);
    const codeFiles = applyWorkerChanges(input.code, output).map((f) => ({
      ...f,
      path: `code/${f.path}`,
    }));
    const reportText = renderWorkerReport({
      taskId: id,
      requestUrl: task.requestUrl!,
      title: task.title,
      provider: candidate.provider,
      model: candidate.model,
      effort: candidate.effort,
      elapsedMs: candidate.elapsedMs,
      output,
    });
    const files = [
      ...codeFiles,
      {
        path: "report.md",
        content: reportText,
        sha256: digest(reportText),
        source: "tracked" as const,
      },
    ];
    // Publish to Git first so the requester can see the commit in their repository;
    // then register the same result with the platform for review and settlement.
    const publication = await ui.busy(
      "Publishing the result branch and pull request to the requester's repository…",
      () =>
        services.publishResult({
          taskId: id,
          title: task.title,
          baseRepository: input.envelope.repository,
          baseBranch: input.branch,
          baseCommit: input.commit,
          files: files.map(({ path, content }) => ({ path, content })),
          prBody: `${output.summary}\n\n---\nTokenisgold task ${id}. Runtime tests were not run by Tokenisgold; review report.md and the changed files before approving.`,
        }),
    );
    const submitted = taskView.parse(
      await ui.busy("Submitting your result for the requester's review…", () =>
        services.api(
          `/v1/tasks/${id}/submit`,
          mutation({
            expectedVersion: task.version,
            generation: task.generation,
            report: output.summary,
            artifact: {
              baseCommit: input.commit,
              summary: `Worker result for: ${task.title}`,
              files,
              deletedPaths: [],
              manifestHash: packageManifest(files),
            },
            execution: {
              provider: candidate!.provider,
              model: candidate!.model,
              effort: candidate!.effort,
            },
            gitResult: publication,
          }),
        ),
      ),
    );
    const receipt = {
      taskId: id,
      state: submitted.state,
      reviewDueAt: submitted.reviewDueAt,
      files: files.length,
      provider: candidate.provider,
      git: publication,
      submitted: true as const,
      submittedAt: new Date().toISOString(),
    };
    await atomicJson(join(folder, "submission.json"), receipt);
    ui.section("marketplace", "Submitted for review");
    ui.say(
      `${codeFiles.length} code files and report.md were committed to ${publication.repository}@${publication.branch} (${publication.commit.slice(0, 7)})${publication.pullRequestUrl ? `\nPull request: ${publication.pullRequestUrl}` : ""}\nPlatform state: ${submitted.state}. The requester can approve (pays ${task.rewardTig} TIG), report an issue (refund), or let the 48-hour window pass (automatic payment)${submitted.reviewDueAt ? ` — review due ${submitted.reviewDueAt}` : ""}.\nRuntime tests were not run by TIG; that is stated in the submission and in report.md.`,
    );
    return receipt;
  } finally {
    await unlock();
  }
}
// Personal trial on a tree-layout request: the same workspace run, but the result
// stays in the local workspace (no push, no pull request, no submission).
async function workspacePersonalWork(o: {
  id: string;
  input: WorkerPackage;
  folder: string;
  ui: Terminal;
  services: WorkServices;
  signal?: AbortSignal;
}) {
  const { id, ui, services, input, folder } = o;
  const receiptPath = join(folder, "local-receipt.json");
  // The disclosures are saved with the receipt, so reopening the trial repeats
  // exactly what the first run said about the result.
  const show = (r: {
    workspace: string;
    report: string;
    commit: string;
    disclosures?: string[];
  }) => {
    ui.section("personal trial", "Workspace and work report saved");
    ui.say(
      `Workspace: ${r.workspace}\nReport: ${r.report}\nLocal Git commit: ${r.commit} (on top of the request commit; git --git-dir ${workspacePaths(folder).gitDir} --work-tree ${r.workspace} diff HEAD~1 shows it)${(r.disclosures ?? []).map((n) => `\n${n}`).join("")}\nRuntime tests: not run by TIG. Submission: not sent. Your task and TIG balance are unchanged.\nRun tig work again to reopen this result without another AI call.`,
    );
  };
  try {
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    show(receipt);
    return receipt;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const ai = await selectWorkerAi(
    input.task.aiRequirement,
    ui,
    services,
    o.signal,
  );
  ui.section("personal trial", input.task.title);
  ui.say(
    `Use your own published request as the worker.\nRequested: ${ai.requestedModel} / ${ai.effort}\nCLI will request: ${ai.model} / ${ai.effort} (${ai.availability})\n${input.task.rewardTig} TIG stays reserved on the posted task.\n${ai.tool.name} will clone the request branch into a private workspace and implement it there with your ${ai.provider === "codex" ? "ChatGPT" : "Claude subscription"} allowance (${ai.provider === "codex" ? "Codex workspace-write sandbox, no network" : "Claude Code restricted file tools, no command execution"}). The result stays in that local workspace; this trial does not push, submit work or earn TIG.`,
  );
  if (!(await ui.confirm("Start this personal worker trial?")))
    throw new Cancelled();
  const run = await runWorkspace({
    id,
    title: input.task.title,
    input,
    folder,
    ai,
    ui,
    services,
    requirement: input.task.aiRequirement,
    signal: o.signal,
  });
  if (!run.candidate) {
    ui.say(noChangeNotice(run.tool, id, run.dropped, run.restored));
    return {
      taskId: id,
      submitted: false,
      paymentEligible: false,
      commit: null,
    };
  }
  const { candidate } = run;
  const changes = {
    ...(await readCommittedChanges(folder, input.commit, candidate.commit)),
    dropped: candidate.dropped,
    restored: candidate.restored,
    ignoredIncluded: candidate.ignoredIncluded,
  };
  const report =
    renderWorkspaceReport({
      taskId: id,
      requestUrl: input.task.requestUrl!,
      title: input.task.title,
      provider: candidate.provider,
      model: candidate.model,
      effort: candidate.effort,
      elapsedMs: candidate.elapsedMs,
      report: candidate.report,
      changes,
      mirrored: false,
      submitted: false,
    }) + resultDisclosures(changes);
  const reportPath = join(folder, "report.md");
  await writeFile(reportPath, report, { mode: 0o600 });
  const receipt = {
    kind: "personal_trial",
    taskId: id,
    workspace: workspacePaths(folder).workTree,
    gitDir: workspacePaths(folder).gitDir,
    report: reportPath,
    baseline: input.commit,
    commit: candidate.commit,
    provider: candidate.provider,
    mode: candidate.mode,
    changedFiles: changes.files.length,
    disclosures: [
      ...disclosureNotes(changes),
      ...(changes.dropped.length
        ? [
            `Dropped from the result: ${changes.dropped.map((d) => `${d.path} (${d.reason})`).join(", ")}.`,
          ]
        : []),
    ],
    submitted: false,
    paymentEligible: false,
  };
  await atomicJson(receiptPath, receipt);
  show(receipt);
  return receipt;
}
export async function personalWork(
  id: string | undefined,
  ui: Terminal,
  signal?: AbortSignal,
  services: WorkServices = workServices,
) {
  const connection = await services.loadConnection();
  const user = z.object({ id: z.uuid() }).parse(await services.api("/v1/me"));
  if (!id) {
    const list = z
      .object({ tasks: z.array(taskView) })
      .parse(await services.api("/v1/tasks?mine=true"));
    id = list.tasks.find(
      (t) => t.requesterId === user.id && t.requestUrl && !t.developmentFixture,
    )?.id;
    if (!id)
      throw new Error(
        "Post a Git request with tig first, then run tig work to try it yourself.",
      );
  }
  z.uuid().parse(id);
  const input = readWorkerPackage(
    await services.api(`/v1/tasks/${id}`),
    user.id,
  );
  const root = join(stateDir(), "worker-trials");
  const folder = join(
    root,
    digest(
      `${validateOrigin(connection.origin)}:${user.id}:${id}:${input.manifestHash}`,
    ),
  );
  const unlock = await trialLock(root);
  try {
    await mkdir(folder, { recursive: true, mode: 0o700 });
    if (input.layout === "tree")
      return await workspacePersonalWork({
        id,
        input,
        folder,
        ui,
        services,
        signal,
      });
    const show = (receipt: { folder: string; commit: string }) => {
      ui.section("personal trial", "Code and work report saved");
      ui.say(
        `Result: ${receipt.folder}\nReport: ${join(receipt.folder, "report.md")}\nLocal Git commit: ${receipt.commit}\nRuntime tests: not run. Submission: not sent. Your task and TIG balance are unchanged.\nRun tig work again to reopen this result without another AI call.`,
      );
    };
    try {
      const receipt = JSON.parse(
        await readFile(join(folder, "result", "local-receipt.json"), "utf8"),
      );
      show(receipt);
      return receipt;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    let candidate: Candidate | undefined;
    try {
      candidate = candidateSchema.parse(
        JSON.parse(await readFile(join(folder, "candidate.json"), "utf8")),
      );
      validateWorkerOutput(candidate.output);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error(
          "Saved worker output needs inspection; it will not be overwritten.",
        );
    }
    if (!candidate) {
      const {
        provider,
        binary,
        tool,
        model,
        effort,
        requestedModel,
        availability,
      } = await selectWorkerAi(input.task.aiRequirement, ui, services, signal);
      ui.section("personal trial", input.task.title);
      ui.say(
        `Use your own published request as the worker.\nRequested: ${requestedModel} / ${effort}\nCLI will request: ${model} / ${effort} (${availability})\n${input.code.length} code files · ${input.task.rewardTig} TIG stays reserved on the posted task.\n${tool.name} will generate changes and a work report using your ${provider === "codex" ? "ChatGPT" : "Claude subscription"} allowance. Code stays in a separate local Git workspace. Project commands will not run; this trial does not submit work or earn TIG.`,
      );
      if (!(await ui.confirm("Start this personal worker trial?")))
        throw new Cancelled();
      const started = Date.now();
      const output = await ui.busy(
        `${tool.name} is implementing the request…`,
        () =>
          services.generateWorkerCode({
            provider,
            binary,
            model,
            effort,
            data: {
              request: input.envelope.request,
              files: input.code.map(({ path, content }) => ({
                path,
                content,
              })),
            },
            signal,
          }),
      );
      applyWorkerChanges(input.code, output);
      candidate = {
        provider,
        model,
        effort,
        elapsedMs: Date.now() - started,
        completedAt: new Date().toISOString(),
        output,
      };
      await atomicJson(join(folder, "candidate.json"), candidate);
    }
    if (signal?.aborted) throw new Cancelled();
    const receipt = await ui.busy(
      "Saving code, report and local Git history…",
      () => saveWorkerResult(folder, input, candidate!),
    );
    show(receipt);
    return receipt;
  } finally {
    await unlock();
  }
}

// Everything `tig work` reaches outside this process, so the wizard can be driven
// with fixtures; the default is the real terminal and website.
export interface WorkerWizardEnv {
  // null when tig is not running in an interactive terminal.
  terminal: () => (Terminal & { signal: AbortSignal; close(): void }) | null;
  api: typeof api;
  findExecutable: typeof findExecutable;
  connect: typeof ensureConnection;
  services: WorkServices;
}
export const workerWizardEnv: WorkerWizardEnv = {
  terminal: () =>
    process.stdin.isTTY && process.stdout.isTTY ? new RequestTerminal() : null,
  api,
  findExecutable,
  connect: ensureConnection,
  services: workServices,
};
export async function runWorkerWizard(
  id?: string,
  options: { market?: boolean; watch?: boolean; everyMinutes?: number } = {},
  env: WorkerWizardEnv = workerWizardEnv,
) {
  const ui = env.terminal();
  if (!ui)
    throw new Error(
      "Run tig work in an interactive terminal to select and authorize work.",
    );
  const { api, services } = env;
  try {
    await env.connect(ui, false, ui.signal);
    // What happened to this user's transactions since last time, before anything
    // else; the same board keeps --watch from repeating these lines.
    const board = new NoticeBoard({ api });
    await board.show(ui);
    // An explicit id that belongs to someone else is marketplace work.
    let market = !!options.market || !!options.watch;
    if (id && !market) {
      const me = z.object({ id: z.uuid() }).parse(await api("/v1/me"));
      market =
        taskView.parse(await api(`/v1/tasks/${id}`)).requesterId !== me.id;
    }
    if (!market) return await personalWork(id, ui, ui.signal, services);
    if (id) return await marketWork(id, ui, ui.signal, services);
    // No id: tig reads this computer's usage, proposes one fitting request, and
    // runs it to submission after a single yes.
    const deps = await proposalDeps(ui, env, board);
    if (options.watch) {
      const everyMs = Math.max(1, options.everyMinutes ?? 10) * 60000;
      ui.section("watch", "Watching your usage");
      ui.say(
        `Every ${everyMs / 60000} minutes tig checks Codex/Claude usage. When a tool has usage to spare (P-053: every window at or under 30% used) and an open request fits, tig proposes it here; nothing runs without your yes. Updates to your own requests and jobs (submitted, approved, paid…) are shown here as they arrive. Press Ctrl+C to stop.`,
      );
      await watchAndWork(ui, deps, { everyMs, signal: ui.signal });
      return;
    }
    const result = await proposeOnce(ui, deps, new Set());
    if (result.outcome === "none")
      ui.say(
        `Nothing to propose: ${result.note}. Run tig work --watch to be told when that changes.`,
      );
    else if (result.outcome === "declined") ui.say("Okay, nothing accepted.");
  } finally {
    ui.close();
  }
}
// Live dependencies for the proposal/watch loop.
async function proposalDeps(
  ui: Terminal & { signal: AbortSignal },
  env: WorkerWizardEnv,
  board: NoticeBoard,
): Promise<WatchDeps> {
  const { api } = env;
  const found: Record<LocalAiProvider, string | null> = {
    codex: await env.findExecutable("codex"),
    claude: await env.findExecutable("claude"),
  };
  const me = z.object({ id: z.uuid() }).parse(await api("/v1/me"));
  return {
    notices: (terminal) => board.show(terminal),
    installed: async () =>
      (["codex", "claude"] as const).filter((p) => found[p]),
    signals: () => ui.busy("Checking your usage…", () => toolSignals(found)),
    openTasks: async () =>
      z
        .object({ tasks: z.array(taskView) })
        .parse(await api("/v1/tasks"))
        .tasks.filter(
          (t) =>
            t.requesterId !== me.id &&
            !!t.requestUrl &&
            !t.developmentFixture &&
            t.state === "OPEN",
        ),
    activeJob: async () =>
      z
        .object({ tasks: z.array(taskView) })
        .parse(await api("/v1/tasks?mine=true"))
        .tasks.find(
          (t) =>
            t.workerId === me.id &&
            ["CLAIMED", "EXECUTING", "INTERRUPTED"].includes(t.state),
        ) ?? null,
    run: async (rec) => {
      await marketWork(rec.task.id, ui, ui.signal, env.services, {
        provider: rec.provider,
        assumeYes: true,
      });
    },
    sleep: sleepUnlessAborted,
    now: () => Date.now(),
  };
}
