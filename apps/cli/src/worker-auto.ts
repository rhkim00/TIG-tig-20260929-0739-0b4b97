// Worker side of "tig decides, the user says yes" (P-015, P-024, P-025, P-053):
// read the worker's own usage, pick ONE open request that fits the tools installed
// here, propose it in a line, and — only after an explicit yes — run it to submission.
// `tig work --watch` keeps doing that in the background of a terminal: it proposes only
// while a tool has usage to spare and stays quiet otherwise.
import { localAiTools, type LocalAiProvider } from "./local-ai.js";
import type { taskView } from "../../../packages/contracts/src/index.js";
import { usageSignal } from "../../../packages/contracts/src/index.js";
import type { z } from "zod";
import { readCodexObservation } from "./codex.js";
import {
  loadCapturedRateLimits,
  projectClaudeMetadata,
} from "./claude-usage.js";
import { Cancelled, type Terminal } from "./terminal.js";
import { activeLimit, resetClock } from "./limits.js";

export type Task = z.infer<typeof taskView>;
export type Signal = "low" | "spare" | "normal" | "unknown";
export interface ToolSignal {
  signal: Signal;
  detail: string;
}
export type ToolSignals = Partial<Record<LocalAiProvider, ToolSignal>>;

export const CLAUDE_CAPTURE_MAX_AGE_MS = 6 * 3600000;
export const DECLINE_SUPPRESSION_MS = 6 * 3600000; // P-053: same alert at most every 6 hours

const percent = (windows: { usedPercent: number | null }[]) =>
  windows
    .filter((w) => w.usedPercent !== null)
    .map((w) => `${Math.round(w.usedPercent!)}%`)
    .join("/");

// What each installed tool's own official usage data says right now.
export async function toolSignals(
  found: Partial<Record<LocalAiProvider, string | null>>,
  deps = {
    codexUsage: (binary: string) => readCodexObservation(binary),
    claudeUsage: loadCapturedRateLimits,
    limit: (provider: LocalAiProvider, now: number) =>
      activeLimit(provider, now),
    now: () => Date.now(),
  },
): Promise<ToolSignals> {
  const out: ToolSignals = {};
  // A tool that refused with a limit message stays unusable until its window resets.
  for (const provider of ["codex", "claude"] as const)
    if (found[provider]) {
      const hit = await deps.limit(provider, deps.now());
      if (hit)
        out[provider] = {
          signal: "low",
          detail: `${localAiTools[provider].name} hit its limit (resets ${resetClock(hit)})`,
        };
    }
  if (found.codex && !out.codex) {
    try {
      const o = await deps.codexUsage(found.codex);
      const signal = usageSignal(o.windows);
      out.codex = {
        signal,
        detail:
          signal === "unknown"
            ? "Codex usage unknown"
            : `Codex ${percent(o.windows)} used`,
      };
    } catch {
      out.codex = { signal: "unknown", detail: "Codex usage unknown" };
    }
  }
  if (found.claude && !out.claude) {
    const captured = await deps.claudeUsage();
    if (
      captured &&
      deps.now() - Date.parse(captured.capturedAt) < CLAUDE_CAPTURE_MAX_AGE_MS
    ) {
      const o = projectClaudeMetadata(captured, "statusline", deps.now());
      const signal = usageSignal(o.windows);
      out.claude = {
        signal,
        detail:
          signal === "unknown"
            ? "Claude usage unknown"
            : `Claude ${percent(o.windows)} used`,
      };
    } else
      out.claude = {
        signal: "unknown",
        detail:
          "Claude usage unknown (tig claude-statusline install shows it after a Claude Code session)",
      };
  }
  return out;
}

export interface Recommendation {
  task: Task;
  provider: LocalAiProvider;
  substituted: boolean;
  reason: string;
}
// One request that fits: its requested tool must be installed here and not low on
// usage (else the other installed tool, shown as a substitution). Prefer the tool
// with usage to spare, then an exact tool match, then reward, then the newest.
export function recommendTask(
  open: Task[],
  ctx: {
    installed: LocalAiProvider[];
    signals: ToolSignals;
    skipped?: Set<string>;
  },
): Recommendation | null {
  const usable = ctx.installed.filter(
    (p) => (ctx.signals[p]?.signal ?? "unknown") !== "low",
  );
  if (!usable.length) return null;
  const scored: { rec: Recommendation; score: number }[] = [];
  for (const task of open) {
    if (ctx.skipped?.has(task.id)) continue;
    const wanted = task.aiRequirement.provider;
    const provider = usable.includes(wanted) ? wanted : usable[0];
    const substituted = provider !== wanted;
    const spare = ctx.signals[provider]?.signal === "spare";
    const reason = [
      spare
        ? `${ctx.signals[provider]!.detail}: usage to spare`
        : (ctx.signals[provider]?.detail ??
          `${localAiTools[provider].name} installed`),
      substituted
        ? `the request asks for ${localAiTools[wanted].name}, which is not usable here, so ${localAiTools[provider].name} would run it`
        : `the request asks for ${localAiTools[provider].name}`,
    ].join("; ");
    scored.push({
      rec: { task, provider, substituted, reason },
      score:
        (spare ? 100 : 0) +
        (substituted ? 0 : 10) +
        Math.min(9, Number.parseFloat(task.rewardTig) / 100),
    });
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      Date.parse(b.rec.task.createdAt) - Date.parse(a.rec.task.createdAt),
  );
  return scored[0]?.rec ?? null;
}
export function proposalLine(rec: Recommendation) {
  const ai = rec.task.aiRequirement;
  return `Take "${rec.task.title}" for ${rec.task.rewardTig} TIG with ${localAiTools[rec.provider].name} (${ai.model} / ${ai.effort})? — ${rec.reason}.`;
}
// yes → run, next → another request, no → not now, stop → leave (watch mode).
export function proposalAnswer(
  text: string,
): "yes" | "next" | "no" | "stop" | null {
  const t = text.trim().toLowerCase();
  if (["yes", "y", "네", "예", "응", "좋아", "해줘", "go"].includes(t))
    return "yes";
  if (["next", "skip", "다음", "다른", "other", "another"].includes(t))
    return "next";
  if (["no", "n", "아니요", "아니", "나중에", "later", ""].includes(t))
    return "no";
  if (["stop", "quit", "exit", "그만", "종료"].includes(t)) return "stop";
  return null;
}
export const hasSpare = (signals: ToolSignals) =>
  Object.values(signals).some((s) => s?.signal === "spare");

export interface WatchDeps {
  signals: () => Promise<ToolSignals>;
  openTasks: () => Promise<Task[]>;
  installed: () => Promise<LocalAiProvider[]>;
  // The job this worker already holds (one at a time, P-048), if any.
  activeJob?: () => Promise<Task | null>;
  run: (rec: Recommendation) => Promise<void>;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  now: () => number;
  // Prints what happened to this user's transactions since the last cycle (both
  // roles sit in --watch: a requester sees "submitted", a worker sees "paid").
  notices?: (ui: Terminal) => Promise<unknown>;
}
export const sleepUnlessAborted = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    if (signal?.aborted) done();
    else signal?.addEventListener("abort", done, { once: true });
  });

export interface ProposeResult {
  outcome: "ran" | "failed" | "declined" | "stopped" | "none" | "quiet";
  // Why nothing was proposed or finished, in the user's terms (shown so a waiting
  // terminal is never silent about its reasons).
  note: string;
}
const signalsText = (signals: ToolSignals, installed: LocalAiProvider[]) =>
  installed
    .map((p) => signals[p]?.detail ?? `${localAiTools[p].name} usage unknown`)
    .join(", ");
// The exact command that finishes a job this worker already holds: tig work runs
// it to submission; an interrupted job must be resumed first.
export const continueCommand = (job: Pick<Task, "id" | "state">) =>
  job.state === "INTERRUPTED"
    ? `tig resume ${job.id} and then tig work ${job.id}`
    : `tig work ${job.id}`;

// What to say when the job the user said yes to did not finish: the error, and
// how to go on. A job already accepted for this worker is finished with
// `tig work <id>`; one that never got accepted is set aside (P-053: nothing is
// retried without a new yes).
async function failureNote(
  rec: Recommendation,
  error: unknown,
  deps: Pick<WatchDeps, "activeJob">,
) {
  const message = (error instanceof Error ? error.message : String(error))
    .trim()
    .replace(/(?<![.!?])$/, ".");
  let held: Task | null | undefined;
  try {
    held = deps.activeJob ? await deps.activeJob() : null;
  } catch {
    /* unknown: still name the command */
  }
  const how =
    held?.id === rec.task.id
      ? `It is accepted for you; run ${continueCommand(held)} to continue and submit it`
      : held === undefined
        ? `If it was accepted for you, run tig work ${rec.task.id} to continue it`
        : "It is set aside; I'll keep watching for other requests";
  return `"${rec.task.title}" was not finished: ${message} ${how}`;
}

// Propose one fitting request now (used by `tig work --market`). Returns what happened.
export async function proposeOnce(
  ui: Terminal,
  deps: Pick<
    WatchDeps,
    "signals" | "openTasks" | "installed" | "run" | "activeJob"
  >,
  skipped: Set<string>,
  options: {
    requireSpare?: boolean;
    // Watch mode: a job that fails after the yes is reported and set aside instead
    // of ending the process (a claim lost while the prompt waited is routine).
    keepGoing?: boolean;
    signal?: AbortSignal;
  } = {},
): Promise<ProposeResult> {
  const active = deps.activeJob ? await deps.activeJob() : null;
  if (active)
    return {
      outcome: "none",
      note: `you are already working on "${active.title}" (${active.state.toLowerCase()}); run ${continueCommand(active)} to continue and submit it, then tig proposes the next request`,
    };
  const [signals, installed] = await Promise.all([
    deps.signals(),
    deps.installed(),
  ]);
  if (options.requireSpare && !hasSpare(signals))
    return {
      outcome: "quiet",
      note: `no usage to spare yet (${signalsText(signals, installed)}); tig proposes work when every window of a tool is at or under 30% used`,
    };
  const open = await deps.openTasks();
  while (true) {
    const rec = recommendTask(open, { installed, signals, skipped });
    if (!rec)
      return {
        outcome: "none",
        note: open.length
          ? `${open.length} open request${open.length > 1 ? "s" : ""} from other users, but none fits the tools usable here (${signalsText(signals, installed)})`
          : "no open requests from other users right now (your own requests are never proposed to you)",
      };
    ui.say(proposalLine(rec));
    let answer = proposalAnswer(
      await ui.ask("Run it now? (yes / next / no)", "no"),
    );
    while (!answer) {
      ui.say("Reply yes, next or no (네 / 다음 / 아니요).");
      answer = proposalAnswer(
        await ui.ask("Run it now? (yes / next / no)", "no"),
      );
    }
    if (answer === "yes") {
      if (!options.keepGoing) {
        await deps.run(rec);
        return { outcome: "ran", note: "" };
      }
      try {
        await deps.run(rec);
        return { outcome: "ran", note: "" };
      } catch (e) {
        // The user's own stop (Ctrl+C) is not a failed job.
        if (e instanceof Cancelled || options.signal?.aborted) throw e;
        skipped.add(rec.task.id);
        return { outcome: "failed", note: await failureNote(rec, e, deps) };
      }
    }
    if (answer === "next") {
      skipped.add(rec.task.id);
      continue;
    }
    if (answer === "stop") return { outcome: "stopped", note: "" };
    return { outcome: "declined", note: "" };
  }
}

// `tig work --watch`: check every `everyMs`; propose only when a tool has usage to
// spare; after "no", stay quiet for six hours; keep going after a finished job and
// after a failed one (its note says how to continue; it is not proposed again until
// another job ran). When nothing is proposed, say why once (and again whenever the
// reason changes). The loop never ends on its own: a requester with no local AI
// keeps it open just to be told when a result arrives.
export async function watchAndWork(
  ui: Terminal,
  deps: WatchDeps,
  options: { everyMs: number; signal?: AbortSignal },
) {
  const skipped = new Set<string>();
  let quietUntil = 0;
  let cycles = 0;
  let lastNote = "";
  const clock = (ms: number) => new Date(ms).toTimeString().slice(0, 5);
  while (!options.signal?.aborted) {
    // Even a quiet cycle (after "no", or a requester with nothing to work on)
    // reports the transactions that moved; an inbox failure never ends the watch.
    if (deps.notices)
      try {
        await deps.notices(ui);
      } catch (e) {
        if (e instanceof Cancelled || options.signal?.aborted) throw e;
      }
    if (deps.now() >= quietUntil) {
      const result = await proposeOnce(ui, deps, skipped, {
        requireSpare: true,
        keepGoing: true,
        signal: options.signal,
      });
      if (result.outcome === "stopped") return cycles;
      if (result.outcome === "declined") {
        quietUntil = deps.now() + DECLINE_SUPPRESSION_MS;
        ui.say(
          "Okay. I'll stay quiet for six hours unless you stop me (Ctrl+C).",
        );
      }
      if (result.outcome === "ran") {
        skipped.clear();
        lastNote = "";
      }
      if (result.note && result.note !== lastNote) {
        ui.say(
          `${clock(deps.now())} · ${result.note}. Next check in ${Math.round(options.everyMs / 60000)} min; I'll speak up when that changes.`,
        );
        lastNote = result.note;
      }
    }
    cycles++;
    await deps.sleep(options.everyMs, options.signal);
  }
  return cycles;
}
