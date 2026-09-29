#!/usr/bin/env node
import { Command } from "commander";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hostname } from "node:os";
import { watch } from "chokidar";
import {
  taskSpec,
  observationSchema,
} from "../../../packages/contracts/src/index.js";
import { recordUsageAlert } from "./usage.js";
import { environmentReport, renderDoctor } from "./doctor.js";
import {
  installStatusLine,
  readClaudeObservation,
  runStatusLine,
  uninstallStatusLine,
  claudeSettingsPath,
  STATUS_LINE_SUBCOMMAND,
} from "./claude-usage.js";
import { RequestTerminal } from "./terminal.js";
import {
  installClaudeNotes,
  recordAiNote,
  uninstallClaudeNotes,
  NOTES_SUBCOMMAND,
} from "./evidence.js";
import {
  capture,
  listUntracked,
  loadDraft,
  projectRoot,
  atomicJson,
  stateDir,
  digest,
} from "./drafts.js";
import { connect, api } from "./client.js";
import { readCodexObservation } from "./codex.js";
import { fixtureContent } from "../../../packages/contracts/src/lifecycle.js";
import {
  initRequester,
  prepareRequest,
  showRequest,
  publishRequest,
} from "./requester.js";
import { requesterInstructions } from "./request-instructions.js";
import { runRequesterWizard } from "./wizard.js";
import { runWorkerWizard } from "./work.js";
import { findExecutable } from "./executables.js";
import { NoticeBoard, consoleNotices, startWithNotices } from "./notices.js";
import { configureTigHelp } from "./help.js";
const program = new Command()
  .name("tig")
  .description("Tokenisgold local handoff and task CLI")
  .version("0.5.0")
  .argument(
    "[description...]",
    "What to hand off; the tool, model, reasoning level and TIG reward can be named in the same sentence. Without it, tig asks. Unread updates to your requests (accepted, submitted, paid…) are shown first",
  )
  .action((description: string[]) => {
    const wizard = () =>
      runRequesterWizard({
        request: description.join(" ").trim() || undefined,
      });
    // Scripts (no TTY) get the wizard's hint only; nothing is marked read for them.
    return process.stdin.isTTY && process.stdout.isTTY
      ? startWithNotices(new NoticeBoard({ api }), consoleNotices, wizard)
      : wizard();
  });
program
  .command("setup")
  .description("Revisit website and project connection settings")
  .action(() => runRequesterWizard({ setup: true }));
const output = (value: unknown) => console.log(JSON.stringify(value, null, 2));
program
  .command("work [taskId]")
  .description(
    "Work with your local Codex or Claude Code. Your own request: personal trial (no submission). Another user's request (or --market): accept, implement and submit for review. Unread updates to your requests and jobs are shown first",
  )
  .option(
    "--market",
    "도구·사용량에 맞는 타인 작업 한 건 제안. yes로 수행·제출",
  )
  .option(
    "--watch",
    "터미널에서 사용량·작업 제안·결과 알림을 주기적으로 확인. 종료 Ctrl+C",
  )
  .option("--every <minutes>", "--watch 확인 간격(분), 기본 10")
  .action((id, o) =>
    runWorkerWizard(id, {
      market: !!o.market,
      watch: !!o.watch,
      everyMinutes: o.every ? Number(o.every) : undefined,
    }),
  );
program
  .command("connect")
  .description(
    "Pair this computer with your Tokenisgold account; confirm the code in the browser within 10 minutes",
  )
  .requiredOption("--origin <url>")
  .option("--name <name>", "Device name", hostname())
  .action((o) => connect(o.origin, o.name));
program.command("status").action(async () =>
  output({
    user: await api("/v1/me"),
    wallet: await api("/v1/wallet"),
    connections: await api("/v1/connections"),
  }),
);
program
  .command("tasks")
  .option("--mine")
  .action(async (o) =>
    output(await api(`/v1/tasks${o.mine ? "?mine=true" : ""}`)),
  );
program
  .command("project")
  .requiredOption("--repository <owner/repo>")
  .option("--type <type>", "Project type", "software")
  .option("--stack <tags>", "Comma separated tags", "")
  .action(async (o) =>
    output(
      await api("/v1/projects", {
        body: {
          repository: o.repository,
          projectType: o.type,
          stack: o.stack.split(",").filter(Boolean),
        },
        key: `project:${digest(o.repository)}`,
      }),
    ),
  );
program
  .command("untracked")
  .option("--project <path>", "Selected project", ".")
  .action(async (o) => output(await listUntracked(o.project)));
program
  .command("checkpoint")
  .option("--project <path>", "Selected project", ".")
  .option("--summary <text>")
  .option("--include <paths...>", "Explicitly approve listed untracked files")
  .action(async (o) => {
    const draft = await capture(o.project, {
      summary: o.summary,
      approvedUntracked: o.include,
    });
    output({
      savedLocally: true,
      updatedAt: draft.updatedAt,
      files: draft.artifact.files.length,
      excluded: draft.excluded,
      uploaded: false,
    });
  });
program
  .command("watch")
  .option("--project <path>", "Selected project", ".")
  .action(async (o) => {
    const root = await projectRoot(o.project);
    await capture(root);
    let busy = false,
      pending = false;
    const watcher = watch(root, {
      ignoreInitial: true,
      followSymlinks: false,
      ignored: (path) =>
        /(^|[/\\])(\.[^/\\]+|node_modules)([/\\]|$)/.test(
          path.slice(root.length),
        ),
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
    });
    async function update() {
      if (busy) {
        pending = true;
        return;
      }
      busy = true;
      do {
        pending = false;
        try {
          const before = await loadDraft(root),
            after = await capture(root);
          if (before?.updatedAt !== after.updatedAt)
            console.log(`Local draft saved: ${after.updatedAt}`);
        } catch {
          console.error(
            "Local checkpoint failed. Previous draft remains available.",
          );
        }
      } while (pending);
      busy = false;
    }
    watcher.on("all", () => void update());
    console.log(
      "Watching the selected project. Drafts stay local; no AI inference is requested.",
    );
    process.once("SIGINT", () => void watcher.close());
    process.once("SIGTERM", () => void watcher.close());
  });
program
  .command("export")
  .requiredOption("--output <file>")
  .option("--project <path>", "Selected project", ".")
  .action(async (o) => {
    const root = await projectRoot(o.project),
      draft = await loadDraft(root);
    if (!draft) throw new Error("Save a checkpoint first.");
    await atomicJson(o.output, draft.artifact);
    console.log(
      "Handoff exported locally. Review its contents before sharing.",
    );
  });
program
  .command("post")
  .requiredOption("--spec <file>", "Task JSON prepared by your existing AI")
  .option("--project <path>", "Selected project", ".")
  .action(async (o) => {
    const root = await projectRoot(o.project),
      draft = await loadDraft(root);
    if (!draft) throw new Error("No local draft. Run tig checkpoint first.");
    const input = JSON.parse(await readFile(o.spec, "utf8"));
    taskSpec.parse({
      ...input,
      baseCommit: draft.baseCommit,
      handoffArtifactId: "00000000-0000-4000-8000-000000000000",
      packageManifestHash: draft.artifact.manifestHash,
    });
    // Stable keys and the saved draft make a lost-response retry safe. No new AI call is needed.
    const artifact = await api("/v1/artifacts", {
      body: draft.artifact,
      key: `artifact:${digest(JSON.stringify(draft.artifact))}`,
    });
    const spec = taskSpec.parse({
      ...input,
      baseCommit: draft.baseCommit,
      handoffArtifactId: artifact.id,
      packageManifestHash: draft.artifact.manifestHash,
    });
    const result = await api("/v1/tasks", {
      body: spec,
      key: `post:${digest(JSON.stringify(spec))}`,
    });
    output({ message: "Your task is live.", task: result });
  });
program
  .command("cancel")
  .argument("<taskId>")
  .requiredOption("--version <number>")
  .action(async (id, o) =>
    output(
      await api(`/v1/tasks/${id}/cancel`, {
        body: { expectedVersion: Number(o.version) },
        key: `cancel:${id}:${o.version}`,
      }),
    ),
  );
program
  .command("observe")
  .requiredOption(
    "--file <file>",
    "Allowlisted metadata JSON; never provider credentials",
  )
  .action(async (o) => {
    const observation = observationSchema.parse(
      JSON.parse(await readFile(o.file, "utf8")),
    );
    output(await api("/v1/subscription-observations", { body: observation }));
    const alert = await recordUsageAlert(observation);
    if (alert) console.log(alert);
  });
program
  .command("sync-codex")
  .option(
    "--bucket <id>",
    "Official quota bucket; model-to-bucket mapping is not inferred",
    "codex",
  )
  .action(async (o) => {
    const binary = await findExecutable("codex");
    if (!binary) throw new Error("Codex was not found on this computer.");
    const observation = await readCodexObservation(binary, o.bucket);
    output(await api("/v1/subscription-observations", { body: observation }));
    console.log(
      "Allowlisted usage metadata synced. This is a client observation, not verified TIG eligibility.",
    );
    const alert = await recordUsageAlert(observation);
    if (alert) console.log(alert);
  });
program
  .command("sync-claude")
  .description(
    "Sync the Claude Code usage captured by tig's status line (allowlisted metadata only)",
  )
  .action(async () => {
    const binary = await findExecutable("claude");
    if (!binary) throw new Error("Claude Code was not found on this computer.");
    const { observation, capturedAt } = await readClaudeObservation(binary);
    if (!capturedAt) {
      console.log(
        `No Claude Code usage has been captured yet. Run: tig ${STATUS_LINE_SUBCOMMAND} install, then use Claude Code once (usage appears after its first response).`,
      );
      return;
    }
    output(await api("/v1/subscription-observations", { body: observation }));
    console.log(
      `Allowlisted usage metadata synced (captured ${capturedAt}). This is a client observation, not verified TIG eligibility.`,
    );
    const alert = await recordUsageAlert(observation);
    if (alert) console.log(alert);
  });
const statusLine = program
  .command(STATUS_LINE_SUBCOMMAND)
  .description(
    "Show your Claude usage and Tokenisgold hints in Claude Code's status line (opt-in)",
  )
  .action(async () => {
    if (process.stdin.isTTY) {
      console.log(
        `Claude Code runs this command with session JSON on stdin. Set it up with: tig ${STATUS_LINE_SUBCOMMAND} install`,
      );
      return;
    }
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    process.stdout.write(await runStatusLine(input));
  });
statusLine
  .command("install")
  .description(
    "Register tig as the Claude Code status line; your current one keeps running",
  )
  .option("--yes", "Confirm without asking")
  .action(async (o) => {
    const path = claudeSettingsPath();
    const explanation = `tig will set "statusLine" in ${path} so Claude Code shows "Tig · 5h 24% · 7d 41%" with a hint when usage is low or spare. Only the rate-limit percentages and reset times are kept, in ${stateDir()}. Your existing status line (if any) keeps running above tig's line and is restored by: tig ${STATUS_LINE_SUBCOMMAND} uninstall.`;
    if (!o.yes) {
      if (!process.stdin.isTTY)
        throw new Error(`${explanation}\nRe-run with --yes to confirm.`);
      const ui = new RequestTerminal();
      try {
        ui.say(explanation);
        if (!(await ui.confirm("Set up the status line now?"))) return;
      } finally {
        ui.close();
      }
    }
    const result = await installStatusLine(path);
    console.log(
      result.changed
        ? `Status line installed in ${path}. Open Claude Code; usage appears after its first response.`
        : "The tig status line is already installed.",
    );
  });
statusLine
  .command("uninstall")
  .description("Remove tig's status line and restore the previous one")
  .action(async () => {
    const path = claudeSettingsPath();
    const result = await uninstallStatusLine(path);
    console.log(
      result.changed
        ? `Removed tig's status line from ${path}.`
        : "tig's status line is not installed.",
    );
  });
const notes = program
  .command(NOTES_SUBCOMMAND)
  .description(
    "Keep the last answer of each Claude Code session on this computer so `tig` can draft a request from it (opt-in)",
  )
  .action(async () => {
    if (process.stdin.isTTY) {
      console.log(
        `Claude Code runs this command as a Stop hook. Set it up with: tig ${NOTES_SUBCOMMAND} install`,
      );
      return;
    }
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    try {
      await recordAiNote(input);
    } catch {
      /* a hook must never block Claude Code */
    }
  });
notes
  .command("install")
  .description(
    "Add tig as a Claude Code Stop hook; existing hooks keep running",
  )
  .option("--yes", "Confirm without asking")
  .action(async (o) => {
    const path = claudeSettingsPath();
    const explanation = `tig will add a Stop hook to ${path}. After each Claude Code answer, only the final answer text (up to 4000 characters) is saved in ${stateDir()} for that project, for 7 days, and used only when you type "auto" in tig to draft a request. Nothing is uploaded by the hook. Remove with: tig ${NOTES_SUBCOMMAND} uninstall.`;
    if (!o.yes) {
      if (!process.stdin.isTTY)
        throw new Error(`${explanation}\nRe-run with --yes to confirm.`);
      const ui = new RequestTerminal();
      try {
        ui.say(explanation);
        if (!(await ui.confirm("Set up the Claude Code note hook now?")))
          return;
      } finally {
        ui.close();
      }
    }
    const result = await installClaudeNotes(path);
    console.log(
      result.changed
        ? `Hook installed in ${path}. Restart Claude Code sessions to activate it.`
        : "The tig note hook is already installed.",
    );
  });
notes
  .command("uninstall")
  .description("Remove tig's Claude Code Stop hook")
  .action(async () => {
    const path = claudeSettingsPath();
    const result = await uninstallClaudeNotes(path);
    console.log(
      result.changed
        ? `Removed tig's hook from ${path}.`
        : "tig's note hook is not installed.",
    );
  });
program
  .command("doctor")
  .description(
    "Check Node, Git, GitHub CLI, Codex/Claude Code sign-in and your Tokenisgold connection",
  )
  .option("--json", "Machine-readable report")
  .action(async (o) => {
    const report = await environmentReport();
    if (o.json) output(report);
    else console.log(renderDoctor(report));
    if (!report.ready) process.exitCode = 1;
  });
program
  .command("instructions")
  .action(() => console.log(requesterInstructions));
program
  .command("init")
  .description(
    "Connect this project for requests (tig does this itself); each published request becomes a new PUBLIC repository under your GitHub account",
  )
  .option("--project <path>", "Source Git project", ".")
  .option(
    "--install-instructions",
    "Add TOKENISGOLD.md and references for existing AI tools",
  )
  .action(async (o) => output(await initRequester(o)));
const requester = program
  .command("request")
  .description("Prepare, review and publish an immutable Git request");
requester
  .command("prepare")
  .requiredOption(
    "--spec <file>",
    "Structured request written by your existing AI",
  )
  .option("--project <path>", "Source Git project", ".")
  // P-052: the flag must not read like an allowlist where it is not one. Under
  // layout bundle these are the only untracked files published; under layout
  // tree (the default) the published tree is decided by the new-file rule and
  // this list only feeds the drafting snapshot. `tig request show <id>` reports
  // exactly which untracked paths the branch carries, before anything is pushed.
  .option(
    "--include <paths...>",
    "Untracked files for the drafting snapshot (layout bundle: also the only untracked files published; layout tree applies its own new-file rule)",
  )
  .action(async (o) => output(await prepareRequest(o)));
requester
  .command("show <id>")
  .action(async (id) => output(await showRequest(id)));
requester
  .command("publish <id>")
  .requiredOption(
    "--approve <digest>",
    "Digest of the reviewed PUBLIC snapshot",
  )
  .option(
    "--yes",
    "Authorize publishing this snapshot and reserving its TIG reward",
  )
  .action(async (id, o) =>
    output(await publishRequest(id, o.approve, !!o.yes)),
  );

program
  .command("task <id>")
  .description("Read a task, result and review deadline")
  .action(async (id) => output(await api(`/v1/tasks/${id}`)));
program
  .command("demo-post")
  .description("Post a local exercise; reserves sample TIG")
  .option("--reward <tig>", "Sample reward", "100")
  .action(async (o) =>
    output(await api("/v1/dev/tasks", { body: { rewardTig: o.reward } })),
  );
program
  .command("accept <id>")
  .requiredOption("--yes", "Authorize this task only")
  .action(async (id) => {
    const task = await api(`/v1/tasks/${id}`);
    output(
      await api(`/v1/tasks/${id}/claim`, {
        body: { expectedVersion: task.version, consent: "accept_this_task" },
      }),
    );
  });
for (const action of ["start", "heartbeat", "interrupt", "resume"])
  program.command(`${action} <id>`).action(async (id) => {
    const task = await api(`/v1/tasks/${id}`);
    output(
      await api(`/v1/tasks/${id}/${action}`, {
        body: { expectedVersion: task.version, generation: task.generation },
      }),
    );
  });
program
  .command("demo-run <id>")
  .description("Run the fixed JSON exercise and submit; no AI inference")
  .requiredOption("--yes", "Authorize this local test and submission")
  .action(async (id) => {
    let task = await api(`/v1/tasks/${id}`);
    if (!task.developmentFixture)
      throw new Error(
        "This is not a development exercise. Real AI execution is not enabled.",
      );
    const original = task.artifacts.find((a: any) => a.base_commit);
    if (!original)
      throw new Error("Accept this task first: tig accept <id> --yes");
    if (task.state === "CLAIMED")
      task = await api(`/v1/tasks/${id}/start`, {
        body: { expectedVersion: task.version, generation: task.generation },
      });
    const files = [
      {
        path: "wallet-labels.json",
        content: fixtureContent,
        sha256: digest(fixtureContent),
        source: "tracked",
      },
    ];
    const manifestHash = digest(
      JSON.stringify(
        files.map(({ path, sha256, source }) => ({ path, sha256, source })),
      ),
    );
    output(
      await api(`/v1/tasks/${id}/submit`, {
        body: {
          expectedVersion: task.version,
          generation: task.generation,
          report:
            "Updated wallet labels in the local exercise. No AI provider was called.",
          artifact: {
            baseCommit: original.base_commit,
            summary: "Local exercise result with requested wallet labels.",
            files,
            deletedPaths: [],
            manifestHash,
          },
        },
      }),
    );
  });
program
  .command("submit <id>")
  .description(
    "Submit a structured result JSON; development fixture validation only",
  )
  .requiredOption("--file <path>")
  .action(async (id, o) => {
    const task = await api(`/v1/tasks/${id}`),
      result = JSON.parse(await readFile(o.file, "utf8"));
    output(
      await api(`/v1/tasks/${id}/submit`, {
        body: {
          ...result,
          expectedVersion: task.version,
          generation: task.generation,
        },
      }),
    );
  });
for (const action of ["approve", "issue"])
  program
    .command(`${action} <id>`)
    .description(
      action === "approve"
        ? "Pay the worker"
        : "Close the task and restore the full reward",
    )
    .requiredOption("--yes", "Authorize this settlement")
    .action(async (id) => {
      const task = await api(`/v1/tasks/${id}`);
      output(
        await api(`/v1/tasks/${id}/${action}`, {
          body: { expectedVersion: task.version },
        }),
      );
    });

program
  .command("inbox")
  .description(
    "List all your task updates and unread count (tig and tig work already show and mark read the unread ones)",
  )
  .action(async () => output(await api("/v1/notifications")));
program
  .command("read <notificationId>")
  .description("Mark your notification as read")
  .action(async (id) =>
    output(await api(`/v1/notifications/${id}/read`, { body: {} })),
  );
program
  .command("insights")
  .description("Read your daily 30-day project report")
  .option("--sample", "Live development sample preview")
  .action(async (o) =>
    output(
      await api(
        o.sample
          ? "/v1/insights?segment=development&preview=true"
          : "/v1/insights",
      ),
    ),
  );
program
  .command("result <id>")
  .description(
    "Download a submitted result package; does not apply or execute files",
  )
  .option("--output <file>", "Save JSON to a new file without overwriting")
  .action(async (id, o) => {
    const result = await api(`/v1/tasks/${id}/result`);
    if (!o.output) {
      output(result);
      return;
    }
    await writeFile(o.output, JSON.stringify(result, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    output({ saved: o.output, applied: false, executed: false });
  });
configureTigHelp(program);
try {
  await program.parseAsync();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Command failed.");
  process.exitCode = 1;
}
