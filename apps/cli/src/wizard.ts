import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { hostname, homedir } from "node:os";
import { z } from "zod";
import {
  api,
  ApiError,
  connect,
  loadConnection,
  validateOrigin,
} from "./client.js";
import {
  atomicJson,
  capture,
  digest,
  git,
  listUntracked,
  projectRoot,
  stateDir,
} from "./drafts.js";
import {
  ghPath,
  initRequester,
  prepareRequest,
  publishRequest,
  requesterConfig,
  requesterServices,
  showRequest,
  type RequesterServices,
} from "./requester.js";
import { parseGithubRemote } from "./request-tree.js";
import type { SecretAcceptance } from "./secret-gate.js";
import {
  claudeEffortLevels,
  findExecutable,
  localAiTools,
  subscriptionEnvironment,
  type LocalAiProvider,
} from "./local-ai.js";
import { Cancelled, RequestTerminal, type Terminal } from "./terminal.js";
import { taskSpec } from "../../../packages/contracts/src/index.js";
import {
  requestInput,
  type RequestInput,
} from "../../../packages/contracts/src/request.js";
import { containsSecret } from "../../../packages/contracts/src/files.js";
import { defaultOrigin } from "./deployment.js";
import { listRecentSessions, minutesAgo, type AiSession } from "./evidence.js";
import {
  collectReward,
  confirmationAnswer,
  statedReward,
} from "./request-answers.js";
import {
  CLAUDE_MODELS,
  effortAllowed,
  parseRequestTerms,
  parseWorkerAi,
  type WorkerAi,
} from "./request-terms.js";
import { readCodexModels, type CodexModel } from "./models.js";
import {
  acceptanceFromText,
  inferCategory,
  projectFacts,
  titleFromText,
  type ProjectFacts,
} from "./request-facts.js";
export {
  EFFORT_ALIASES,
  normalizeEffort,
  parseWorkerAi,
} from "./request-terms.js";
export type { WorkerAi } from "./request-terms.js";
const exec = promisify(execFile);
const preferencesPath = () => join(stateDir(), "requester-preferences.json");
const preferencesSchema = z.object({
  lastRoot: z.string().optional(),
  // The requester's own last reward, offered as the Enter default next time.
  lastReward: taskSpec.shape.rewardTig.optional(),
});
// What one run of tig holds between its questions and the publish: the
// requester's own answers and the request they were turned into. Every run is
// a new request — nothing here is written to disk for a later run, and nothing
// an earlier run prepared is shown or reused.
interface RequestState {
  // The work, in the requester's words (the terms cut out).
  request: string;
  // The acceptance checks the requester wrote; the settlement reads the
  // worker's result against exactly these.
  acceptance?: string[];
  // What the requester said should change on a review screen ("no"), one line
  // per answer; appended to the requested work.
  revision?: string;
  pending?: string;
  // Files the requester named out of the secret gate's held-back list, with the
  // classes they were shown. Lives only in this run, so it can never become a
  // standing permission.
  publishSecret?: SecretAcceptance[];
  reward?: string;
  workerAi?: WorkerAi;
}
const SET_BY_YOU = "set by you";
// Both commands work as printed: `tig` reviews the saved request; `tig request show`
// prints the digest-bearing publish command, which the review screen never shows.
const notPublished = (id: string) =>
  `Not published. The next tig starts a new request; tig request show ${id} prints this one for scripts.`;
async function saved<T>(
  path: string,
  schema: z.ZodType<T>,
  fallback: T,
): Promise<T> {
  try {
    return schema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw new Error(
      "Saved TIG settings could not be read. Preserve them and check the file before retrying.",
    );
  }
}
async function inherited(
  binary: string,
  args: string[],
  cwd: string,
  env = process.env,
) {
  // Only the official sign-in process should consume input while it owns the terminal.
  const raw = process.stdin.isRaw;
  process.stdin.pause();
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(binary, args, { cwd, env, stdio: "inherit" });
      child.on("error", () =>
        reject(
          new Error(
            "Could not start the sign-in tool. Check its installation.",
          ),
        ),
      );
      child.on("exit", (code) =>
        code === 0
          ? resolve()
          : reject(
              new Error(
                "Sign-in was not completed. Run tig to continue setup.",
              ),
            ),
      );
    });
  } finally {
    if (process.stdin.isTTY) process.stdin.setRawMode(raw);
    process.stdin.resume();
  }
}
export async function openBrowser(address: string) {
  const url = new URL(address);
  if (!["https:", "http:"].includes(url.protocol)) return false;
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "rundll32.exe"
        : "xdg-open";
  const args =
    process.platform === "win32"
      ? ["url.dll,FileProtocolHandler", url.href]
      : [url.href];
  try {
    await exec(command, args, { timeout: 5000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}
const connectionServices = { loadConnection, api, connect, openBrowser };
export async function ensureConnection(
  ui: Terminal,
  setup: boolean,
  signal?: AbortSignal,
  services = connectionServices,
) {
  let origin: string | undefined;
  try {
    origin = (await services.loadConnection()).origin;
  } catch {
    /* first use */
  }
  const target = configuredOrigin(origin);
  if (origin === target && !setup) {
    try {
      return { origin, user: await services.api("/v1/me") };
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 401) throw e;
      ui.say("Your device session expired. Let's reconnect.");
    }
  }
  ui.section("first-use setup", "Connect your Tokenisgold account");
  origin = target;
  ui.say(
    `Using ${origin}. Sign in on the website and approve this device once.` +
      (setup
        ? ""
        : `\nNot the website you use? Stop with Ctrl-C and run: tig connect --origin <website>`),
  );
  while (setup) {
    const input = await ui.ask("Tokenisgold website", origin);
    try {
      origin = validateOrigin(input);
      break;
    } catch {
      ui.say(
        "Enter an HTTPS website, or http://localhost:4173 for the local app.",
      );
    }
  }
  await services.connect(origin!, hostname(), {
    signal,
    onAuthorization: async (auth) => {
      ui.say(
        `Open ${auth.verificationUri}\nConfirm device code: ${auth.userCode}\nWaiting for your approval in the browser (the code expires in ${Math.max(1, Math.round((auth.expiresIn ?? 600) / 60))} minutes; keep this terminal open)…`,
      );
      await services.openBrowser(auth.verificationUri);
    },
    onConnected: () =>
      ui.say("✓ Device connected. I'll remember this connection."),
  });
  return { origin: origin!, user: await services.api("/v1/me") };
}
export function configuredOrigin(
  savedOrigin?: string,
  override = process.env.TIG_ORIGIN,
  releaseOrigin = defaultOrigin,
) {
  return validateOrigin(override ?? savedOrigin ?? releaseOrigin);
}
export async function ensureProject(folder: string, ui: Terminal) {
  const expanded =
    folder === "~"
      ? homedir()
      : folder.startsWith("~/")
        ? join(homedir(), folder.slice(2))
        : resolve(folder);
  if (!(await stat(expanded)).isDirectory())
    throw new Error("Choose an existing project folder.");
  let root: string;
  try {
    root = await projectRoot(expanded);
  } catch {
    if (!(await findExecutable("git")))
      throw new Error(
        "Install Git from https://git-scm.com/downloads, then run tig again.",
      );
    if (
      !(await ui.confirm(
        "This folder has no Git repository. Initialize Git here?",
      ))
    )
      throw new Cancelled();
    await git(expanded, ["init", "--template="]);
    root = await projectRoot(expanded);
  }
  for (const [key, question] of [
    ["user.name", "Your name on shared code (Git author; e.g. 유찬)"],
    [
      "user.email",
      "Email for request commits (visible in the public delivery commit)",
    ],
  ]) {
    let configured = "";
    try {
      configured = (await git(root, ["config", "--get", key])).trim();
    } catch {
      /* missing */
    }
    if (!configured) {
      const value = await required(
        ui,
        question,
        (v) =>
          v.length >= (key === "user.name" ? 1 : 3) && !/[\r\n\x00]/.test(v),
      );
      await git(root, ["config", "--local", key, value]);
    }
  }
  try {
    await git(root, ["rev-parse", "--verify", "HEAD"]);
  } catch {
    // A request needs a base commit; an empty one changes nothing in the files
    // (staged and working files stay local), so it is made without a notice.
    await git(root, [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "--only",
      "-m",
      "Initialize project for Tokenisgold",
    ]);
  }
  return root;
}
async function required(
  ui: Terminal,
  question: string,
  valid: (v: string) => boolean,
  fallback?: string,
) {
  while (true) {
    const v = await ui.ask(question, fallback);
    if (valid(v)) return v;
    ui.say("Please enter a valid value to continue.");
  }
}
// The GitHub account is what every request repository is created under, so
// it is named and confirmed on every run: a terminal signed in as someone else
// would otherwise publish the requester's project under that account. "no"
// opens the official sign-in flow (GitHub CLI keeps the login; tig never sees
// a password or token) and asks again with the account it produced.
export const GH_LOGIN_ARGS = [
  "auth",
  "login",
  "--hostname",
  "github.com",
  "--git-protocol",
  "https",
  "--web",
];
export interface GithubSignIn {
  signedIn(): Promise<boolean>;
  identity(): Promise<string>;
  login(): Promise<void>;
}
export async function githubSignIn(root: string): Promise<GithubSignIn> {
  const binary = await ghPath();
  if (!(await findExecutable("gh")))
    throw new Error(
      "Install GitHub CLI from https://cli.github.com, then run tig again. TIG will guide sign-in.",
    );
  return {
    signedIn: () =>
      exec(binary, ["auth", "status", "--hostname", "github.com"], {
        timeout: 10000,
      }).then(
        () => true,
        () => false,
      ),
    identity: () => requesterServices.githubIdentity(),
    login: () => inherited(binary, GH_LOGIN_ARGS, root),
  };
}
export async function confirmGithubAccount(
  ui: Terminal,
  gh: GithubSignIn,
): Promise<string> {
  let signedIn = await gh.signedIn();
  while (true) {
    if (!signedIn) {
      ui.say(
        "GitHub CLI is not signed in. GitHub CLI keeps your login; TIG does not ask for your password or token.",
      );
      if (!(await ui.confirm("Open the official GitHub sign-in flow?", "yes")))
        throw new Cancelled();
      await gh.login();
      signedIn = true;
      continue;
    }
    const login = await gh.identity();
    if (
      await ui.confirm(
        `GitHub: signed in as ${login}. Publish requests under github.com/${login}?`,
        "yes",
      )
    )
      return login;
    ui.say(
      "Sign in with the GitHub account that should own the request repositories. GitHub CLI can hold several accounts; the one you sign in with becomes the active one.",
    );
    await gh.login();
  }
}
// Codex and Claude Code: which are installed and signed in. An installed tool
// that is not signed in gets its official sign-in flow offered; a missing tool
// is noted with its install link. Nothing here is required to hand off.
export interface LocalAiSignIn {
  findExecutable: typeof findExecutable;
  tools: typeof localAiTools;
  login(binary: string, args: string[]): Promise<void>;
}
export const localAiSignIn: LocalAiSignIn = {
  findExecutable,
  tools: localAiTools,
  login: (binary, args) =>
    inherited(binary, args, homedir(), subscriptionEnvironment()),
};
export async function checkLocalAiSignIns(
  ui: Terminal,
  s: LocalAiSignIn = localAiSignIn,
): Promise<{ signedIn: LocalAiProvider[]; notes: string[] }> {
  const signedIn: LocalAiProvider[] = [];
  const notes: string[] = [];
  for (const provider of ["codex", "claude"] as const) {
    const tool = s.tools[provider];
    const binary = await s.findExecutable(provider);
    if (!binary) {
      notes.push(`${tool.name} not installed (${tool.installUrl})`);
      continue;
    }
    const ready = () =>
      ui.busy(`Checking ${tool.name} sign-in…`, () => tool.readiness(binary));
    try {
      await ready();
      signedIn.push(provider);
      continue;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message.startsWith("Update ")) {
        notes.push(message);
        continue;
      }
      ui.say(`${tool.name} is installed but not signed in.`);
      if (
        !(await ui.confirm(
          `Open the official ${tool.name} sign-in now?`,
          "yes",
        ))
      ) {
        notes.push(`${tool.name} not signed in`);
        continue;
      }
      await s.login(binary, tool.loginArgs);
      try {
        await ready();
        signedIn.push(provider);
      } catch {
        notes.push(`${tool.name} still not signed in`);
      }
    }
  }
  return { signedIn, notes };
}
// Every run starts by saying who is signed in where, and fixing what is not.
async function ensureSignIns(ui: Terminal, root: string) {
  const login = await confirmGithubAccount(ui, await githubSignIn(root));
  const ai = await checkLocalAiSignIns(ui);
  ui.say(
    `Signed in: GitHub ${login}${ai.signedIn.map((p) => ` · ${localAiTools[p].name}`).join("")}${ai.notes.length ? ` — ${ai.notes.join("; ")}` : ""}`,
  );
  return { login };
}
export const destinationLabel = (destination: "origin" | "delivery" | "new") =>
  destination === "origin"
    ? "your repository"
    : destination === "new"
      ? "a new public repository, created when you answer yes"
      : "request repository";
// The project's connection for requests: GitHub sign-in (the repository each
// request is published to is created under that account at publish time) and
// the account/server the project was connected to. Nothing is chosen here.
async function ensureRequester(
  root: string,
  account: { origin: string; user: { id: string } },
  ui: Terminal,
  setup: boolean,
  login: string,
) {
  const old = await requesterConfig(root).catch((error) => {
    if (!setup) throw error;
    ui.say(
      "Replacing the unreadable project connection after you complete setup.",
    );
    return null;
  });
  if (
    !setup &&
    old?.origin === account.origin &&
    old.userId === account.user.id
  )
    return { login };
  await initRequester({ project: root });
  return { login };
}
// ---------------------------------------------------------------------------
// Which folder
// ---------------------------------------------------------------------------
// tig names its best guess — this folder when it is a Git project, else where
// the requester's latest local AI session was working, else the last tig
// project, else this folder — and asks before using it. Enter keeps the guess;
// no asks for the folder in the requester's own words.
export interface FolderCandidate {
  folder: string;
  why: string;
}
export function folderCandidate(o: {
  cwd: string;
  cwdIsProject: boolean;
  sessions: AiSession[];
  lastRoot: string | null;
}): FolderCandidate {
  if (o.cwdIsProject)
    return { folder: o.cwd, why: "the folder tig was started in" };
  const recent = o.sessions.find((s) => s.project);
  if (recent)
    return {
      folder: recent.project!,
      why: `where your ${localAiTools[recent.provider].name} session ${minutesAgo(recent.at)} min ago was working`,
    };
  if (o.lastRoot) return { folder: o.lastRoot, why: "your last tig project" };
  return { folder: o.cwd, why: "the folder tig was started in" };
}
// Read a folder out of an answer. A path is taken as a path (~, relative to
// where tig runs, absolute); anything else is matched by name against the
// folders tig already knows — its basename first, then any word of the answer
// found in the path. The caller checks that a path exists; a name that matches
// several folders is offered as a choice, and one that matches none is asked
// again. Nothing is searched beyond the known list.
export function resolveFolderAnswer(
  answer: string,
  known: string[],
  cwd: string,
): { path: string | null; matches: string[] } {
  const text = answer.trim();
  if (!text) return { path: null, matches: [] };
  const expanded =
    text === "~"
      ? homedir()
      : text.startsWith("~/")
        ? join(homedir(), text.slice(2))
        : text;
  const looksLikePath =
    isAbsolute(expanded) ||
    /^\.\.?(?:[\\/]|$)/.test(expanded) ||
    /[\\/]/.test(expanded);
  if (looksLikePath) return { path: resolve(cwd, expanded), matches: [] };
  const words = text
    .toLowerCase()
    .split(/[\s,]+/)
    .map((w) =>
      w.replace(
        /(?:폴더|디렉터리|디렉토리|프로젝트|에서|으로|로|의|은|는|이|가|를|을)$/u,
        "",
      ),
    )
    .filter((w) => w.length >= 2);
  const unique = [...new Set(known)];
  const exact = unique.filter((k) => words.includes(basename(k).toLowerCase()));
  if (exact.length) return { path: null, matches: exact };
  const partial = unique.filter((k) => {
    const lower = k.toLowerCase();
    return words.some((w) => lower.includes(w));
  });
  return { path: null, matches: partial };
}
async function directories(parent: string) {
  try {
    const entries = await readdir(parent, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => join(parent, e.name))
      .slice(0, 200);
  } catch {
    return [];
  }
}
async function chooseProjectFolder(
  ui: Terminal,
  o: {
    cwd: string;
    sessions: AiSession[];
    lastRoot: string | null;
  },
) {
  const cwdProject =
    o.cwd === homedir() ? null : await projectRoot(o.cwd).catch(() => null);
  const lastRoot =
    o.lastRoot && (await projectRoot(o.lastRoot).catch(() => null))
      ? o.lastRoot
      : null;
  const candidate = folderCandidate({
    cwd: o.cwd,
    cwdIsProject: !!cwdProject,
    sessions: o.sessions,
    lastRoot,
  });
  ui.say(`Project: ${candidate.folder} — ${candidate.why}.`);
  if (await ui.confirm("Is this the folder to hand off?", "yes"))
    return candidate.folder;
  while (true) {
    const answer = await ui.ask(
      "Which folder? (a path, or the name of a project you worked on)",
    );
    // The folders tig knows by name: every recent local AI session's project,
    // the last tig project, and the folders next to and inside this one — read
    // again for every answer, so a folder made while tig was asking is found.
    const known = [
      ...o.sessions.map((s) => s.project).filter((p): p is string => !!p),
      ...(lastRoot ? [lastRoot] : []),
      ...(await directories(dirname(o.cwd))),
      ...(await directories(o.cwd)),
    ];
    const read = resolveFolderAnswer(answer, known, o.cwd);
    if (read.path) {
      if (
        await stat(read.path).then(
          (s) => s.isDirectory(),
          () => false,
        )
      )
        return read.path;
      ui.say(`No folder at ${read.path}.`);
      continue;
    }
    if (read.matches.length === 1) return read.matches[0];
    if (read.matches.length > 1) {
      const shown = read.matches.slice(0, 9);
      const picked = await ui.choose(
        "Several folders match; which one?",
        [...shown, "None of these"],
        null,
      );
      if (picked < shown.length) return shown[picked];
      continue;
    }
    ui.say(
      "I do not know a folder by that name. Type its path (for example ~/work/app or ../app), or the name of a project a recent Codex or Claude Code session worked in.",
    );
  }
}
// ---------------------------------------------------------------------------
// The terms, asked only where the answer did not name them
// ---------------------------------------------------------------------------
const PROVIDER_CHOICES: [string, LocalAiProvider][] = [
  ["Codex", "codex"],
  ["Claude Code", "claude"],
];
const CODEX_EFFORT_FALLBACK = ["low", "medium", "high", "xhigh"];
const OTHER = "Other (type a name)";
async function askModelName(ui: Terminal, fallbackList: string[]) {
  if (fallbackList.length) {
    const picked = await ui.choose(
      "Which model should the worker use? (availability is not verified)",
      [...fallbackList, OTHER],
      null,
    );
    if (picked < fallbackList.length) return fallbackList[picked];
  }
  return required(
    ui,
    "Model name (as the worker's tool spells it)",
    (v) => v.length >= 1 && v.length <= 100 && !/[\r\n\x00]/.test(v),
  );
}
async function askEffort(ui: Terminal, levels: string[]) {
  const picked = await ui.choose("Which reasoning level?", [...levels], null);
  return levels[picked];
}
// The worker AI, completed from what the answer named. Each missing part is one
// question with the tool's own vocabulary; nothing is proposed as a default.
export async function askWorkerAi(
  ui: Terminal,
  named: { provider?: LocalAiProvider; model?: string; effort?: string },
  services: {
    findExecutable: typeof findExecutable;
    codexModels: (
      binary: string,
      signal?: AbortSignal,
    ) => Promise<CodexModel[]>;
    signal?: AbortSignal;
  },
): Promise<WorkerAi> {
  let provider = named.provider;
  if (!provider) {
    const picked = await ui.choose(
      "Which AI should the worker use?",
      PROVIDER_CHOICES.map(([label]) => label),
      null,
    );
    provider = PROVIDER_CHOICES[picked][1];
  }
  let catalog: CodexModel[] = [];
  if (provider === "codex" && (!named.model || !named.effort)) {
    const binary = await services.findExecutable("codex");
    if (binary)
      catalog = await ui
        .busy("Reading your Codex model catalog…", () =>
          services.codexModels(binary, services.signal),
        )
        .catch(() => []);
  }
  let model = named.model;
  if (!model)
    model = await askModelName(
      ui,
      provider === "claude"
        ? [...CLAUDE_MODELS]
        : [...new Set(catalog.map((m) => m.model))],
    );
  let effort = named.effort;
  if (effort && !effortAllowed(provider, effort)) {
    ui.say(
      `${localAiTools[provider].name} does not have a "${effort}" level; choose one of its own.`,
    );
    effort = undefined;
  }
  if (!effort) {
    const fromCatalog = catalog
      .find(
        (m) => m.model === model || m.displayName === model || m.id === model,
      )
      ?.supportedReasoningEfforts.map((e) => e.reasoningEffort);
    effort = await askEffort(
      ui,
      provider === "claude"
        ? [...claudeEffortLevels]
        : fromCatalog?.length
          ? fromCatalog
          : CODEX_EFFORT_FALLBACK,
    );
  }
  const parsed = parseWorkerAi(`${provider} / ${model} / ${effort}`);
  if (!parsed)
    throw new Error("The worker AI could not be read; run tig again.");
  return parsed;
}
// The acceptance checks decide the settlement, so they are the requester's
// words: one per line or ";"; Enter takes the sentences of the request itself.
export async function askAcceptance(ui: Terminal, request: string) {
  ui.say(
    "Acceptance checks decide the settlement: the worker's result is read against each one. Give one per line or separated by ; — Enter uses the sentences of your request as the checks.",
  );
  while (true) {
    const answer = await ui.ask("When is this done?");
    const checks = acceptanceFromText(answer.trim() || request);
    if (containsSecret(answer)) {
      ui.say("Remove sensitive content from the acceptance checks.");
      continue;
    }
    if (checks.length) return checks;
    ui.say("Give at least one check of 3 characters or more.");
  }
}
// request.md's structured input from the requester's answers and the project's
// facts. Pure: the same answers and facts always give the same request.
export function buildRequestInput(o: {
  request: string;
  revision?: string;
  acceptance: string[];
  facts: ProjectFacts;
  ai: WorkerAi;
  reward: string;
  deadline?: string;
}): RequestInput {
  let scope = [o.request, o.revision].filter(Boolean).join("\n\n");
  if (scope.length < 10)
    scope = `${scope}\n(Requested as written; no further detail was given.)`;
  if (scope.length > 12000) scope = `${scope.slice(0, 11999)}…`;
  return requestInput.parse({
    title: titleFromText(o.request),
    requestCategory: inferCategory(o.request),
    scope,
    acceptanceChecks: o.acceptance,
    aiRequirement: { ...o.ai, source: "declared" },
    rewardTig: o.reward,
    executionDeadlineAt:
      o.deadline ?? new Date(Date.now() + 86400000).toISOString(),
    originalRequest: o.request.slice(0, 2000),
    context: o.facts.context,
    completedWork: o.facts.completedWork,
    constraints: [],
    setupSteps: o.facts.setupSteps,
    testSteps: o.facts.testSteps,
  });
}
export interface ReviewNotes {
  rewardReason?: string;
  workerAiReason?: string;
  newFiles?: string[];
  // Revision instructions the draft was rewritten with (one per line).
  revision?: string;
}
const DETAIL_LINES = 200;
const CHANGE_MARK = { modified: "M", added: "A", untracked: "?", deleted: "D" };
const count = (n: number, noun: string) =>
  `${n.toLocaleString("en-US")} ${noun}${n === 1 ? "" : "s"}`;
const formatBytes = (n: number) =>
  n >= 1024 * 1024
    ? `${Math.round(n / 1024 / 1024)} MB`
    : n >= 1024
      ? `${Math.round(n / 1024)} KB`
      : `${n} B`;
// Gate findings the way the requester reads them: the path, then the classes
// that matched in it, and nothing else. `total` is the real count, so a capped
// list can never read as the whole of it.
export const SECRET_NAME_CAP = 5;
export function namedSecrets(
  entries: readonly { path: string; reasons: string[] }[],
  total: number,
) {
  const named = entries
    .slice(0, SECRET_NAME_CAP)
    .map((e) => `${e.path} (${e.reasons.join(", ")})`);
  const more = total - named.length;
  return `${named.join(", ")}${more > 0 ? `, and ${more} more (details names every one)` : ""}`;
}
// The tree summary the requester approves (P-052): destination, what the branch
// holds beyond HEAD (new files by name and folder), what stays tracked though
// ignored, what is left out and why, and how the result comes back. Every new
// file travels, so there is no "not in git" headline: what stays behind is a
// protected path, a secret, or a file that could not be read, each named with
// its reason.
export function treeSummaryLines(
  preview: {
    repository: string;
    branch: string;
    destination: "origin" | "delivery" | "new";
    excluded: { path: string; reason: string }[];
  },
  tree: NonNullable<Awaited<ReturnType<typeof showRequest>>["tree"]>,
): string[] {
  const lines: string[] = [];
  const unexamined = (tree.unscannedPaths ?? []).slice(0, 3).map((u) => u.path);
  // The secret gate reads the commit's own bytes before the push; the few
  // blobs it stops short of (a compressed or entropy-coded container, where
  // the ASCII of a key does not survive as ASCII) are counted and named here,
  // so the tree never passes for one the gate cleared whole.
  if (tree.unscannedCount)
    lines.push(
      `Not examined by the secret gate (binary format): ${count(tree.unscannedCount, "file")}${unexamined.length ? ` — ${unexamined.join(", ")}${tree.unscannedCount > unexamined.length ? ", …" : ""}` : ""}.`,
    );
  // The secret gate's two sentences, and they are deliberately different
  // sentences. "Held back" is what happens on its own: the requester who reads
  // nothing and types yes publishes no credential, because a matched file is
  // already out of the branch. "Going public" is what happens only after they
  // named the file, and it is printed again here — on the screen where yes is
  // typed — because the acceptance was given on an earlier screen and consent
  // that is not in front of you at the moment of the push is not consent.
  //
  // Both name the path and the pattern class and nothing else. The matched text
  // is never here, never in the plan on disk and never on the wire.
  if (tree.secretHeldCount) {
    const n = tree.secretHeldCount;
    lines.push(
      `Held back, matched a credential pattern: ${count(n, "file")} ${n === 1 ? "is" : "are"} NOT in the branch — ${namedSecrets(tree.secretHeld ?? [], n)}. tig cannot tell a test fixture from a live key, so it publishes neither kind, and the worker gets the request without ${n === 1 ? "it" : "them"}. To send ${n === 1 ? "it" : "some"} anyway, answer include with the paths or folders (include ${(tree.secretHeld ?? [])[0]?.path ?? "path/to/file"}); the next screen names exactly what that puts on the public branch.`,
    );
  }
  if (tree.secretPublishedCount) {
    const n = tree.secretPublishedCount;
    lines.push(
      `Going public because you named ${n === 1 ? "it" : "them"}: ${count(n, "file")} ${n === 1 ? "matches" : "match"} a credential pattern and WILL be on the public branch — ${namedSecrets(tree.secretPublished ?? [], n)}. A push cannot be taken back; if ${n === 1 ? "it is" : "any of these is"} a live credential, rotate it now. Answer no to change the request instead.`,
    );
  }
  // The requester's own "no" (manual path) is not one of the rules, so it gets
  // its own sentence, and the files are named.
  if (tree.refusedCount) {
    const kept = (tree.refusedPaths ?? []).slice(0, 5);
    lines.push(
      `Kept private at your request: ${count(tree.refusedCount, "new file")} you did not include${kept.length ? ` — ${kept.join(", ")}${tree.refusedCount > kept.length ? ", …" : ""}` : ""}. ${tree.refusedCount === 1 ? "It is" : "They are"} not in the branch.`,
    );
  }
  // Which tracked files did not travel, by name: protected, secret-bearing,
  // LFS, symlink, nested repository, unreadable, deleted or over GitHub's
  // limit. The counts alone cannot answer the only question the requester has
  // here ("where is the file I edited?"), and no git add brings any of these back.
  if (tree.trackedExcludedCount) {
    const named = (tree.trackedExcluded ?? []).slice(0, 5);
    const listed = named.map((f) => `${f.path} (${f.reason})`).join(", ");
    const more = tree.trackedExcludedCount > named.length;
    lines.push(
      `Tracked but left out: ${listed || count(tree.trackedExcludedCount, "file")}${
        more
          ? `${listed ? ", " : ""}… (${tree.trackedExcludedCount.toLocaleString("en-US")} total; see details)`
          : ""
      } — git tracks ${tree.trackedExcludedCount === 1 ? "this file" : "these files"} and ${tree.trackedExcludedCount === 1 ? "it is" : "they are"} still not in the branch.`,
    );
  }
  if (tree.excludedCount)
    lines.push(
      `Excluded: ${preview.excluded
        .slice(0, 5)
        .map((f) => `${f.path} (${f.reason})`)
        .join(
          ", ",
        )}${tree.excludedCount > 5 ? `, … (${tree.excludedCount} total; see details)` : ""}`,
    );
  return lines;
}
// What the details answer prints about the tree beyond request.md: where it
// goes, how big it is, which folders the new files come from, and how the
// result comes back.
export function treeDetailLines(
  preview: {
    repository: string;
    branch: string;
    destination: "origin" | "delivery" | "new";
  },
  tree: NonNullable<Awaited<ReturnType<typeof showRequest>>["tree"]>,
): string[] {
  const changed =
    tree.changed.modified + tree.changed.added + tree.changed.deleted;
  const lines = [
    preview.destination === "new"
      ? `Destination: github.com/${preview.repository} — a new PUBLIC repository under your account, created when you answer yes · branch ${preview.branch}`
      : `Destination: github.com/${preview.repository} (${destinationLabel(preview.destination)}) · branch ${preview.branch}`,
    `Tree: ${tree.fileCount.toLocaleString("en-US")} files (${formatBytes(tree.bytes)}) = HEAD + ${changed} changed + ${tree.changed.untracked} new${tree.binaryCount ? ` · ${tree.binaryCount} binary` : ""}`,
  ];
  if (tree.untrackedDirs.length)
    lines.push(
      `New (untracked) by folder: ${tree.untrackedDirs
        .slice(0, 6)
        .map(
          (d) =>
            `${d.dir} ${d.count} file${d.count === 1 ? "" : "s"} ${formatBytes(d.bytes)}`,
        )
        .join(
          " · ",
        )}${tree.untrackedDirs.length > 6 ? " · …" : ""} (every new file travels except protected paths and files holding a secret; ignored files never do)`,
    );
  if (tree.trackedIgnoredCount)
    lines.push(
      `Ignored-but-tracked, included: ${tree.trackedIgnored.slice(0, 5).join(", ")}${tree.trackedIgnoredCount > 5 ? `, … (${tree.trackedIgnoredCount} total)` : ""}`,
    );
  lines.push(
    preview.destination === "new"
      ? `After approval: the worker's PR targets that repository's ${preview.branch}. Bring the result into your project with git fetch https://github.com/${preview.repository}.git and git cherry-pick — the request repository is a copy of your tree, not your history.`
      : "After approval: the worker's PR targets this branch; apply it with git fetch and git cherry-pick. Never merge tig/requests/* into main.",
  );
  return lines;
}
// true: published; false: start over; else the change asked for on the screen —
// terms (reward / worker AI, re-prepared from the same draft) or a revision (a
// new draft with that instruction).
export type ReviewOutcome =
  | true
  | false
  | {
      reward?: string;
      workerAi?: WorkerAi;
      revision?: string;
      // Files the requester named out of the held-back list. Like a terms
      // change: the same draft is prepared again, and the new review screen is
      // where the publish is actually authorized.
      secretInclude?: SecretAcceptance[];
    };
// The summary the requester judges: what tig thinks the work is, then the terms. One
// answer publishes; an amount or provider / model / effort changes the terms instead;
// "no" asks what should change and returns that instruction for a new draft.
export async function reviewAndPublish(
  id: string,
  ui: Terminal,
  services = { showRequest, publishRequest },
  notes: ReviewNotes = {},
): Promise<ReviewOutcome> {
  while (true) {
    const preview = await services.showRequest(id);
    if (preview.receipt) {
      ui.section("complete", "Your request is live");
      ui.say(
        `Repository: https://github.com/${preview.repository}\nRequest: ${preview.receipt.requestUrl}\nTask: ${preview.receipt.taskUrl}`,
      );
      return true;
    }
    ui.section("review", "Is this the work you want to hand off?");
    const tree = preview.layout === "tree" ? preview.tree : null;
    // Bundle layout only: new files that are really in the package (approved
    // untracked paths can number in the tens of thousands).
    const packaged = new Set(
      preview.files.map((f) => f.path.replace(/^code\//, "")),
    );
    const sharedNew = (notes.newFiles ?? []).filter((p) => packaged.has(p));
    const trim = (text: string, max: number) =>
      `${text.replace(/\s+/g, " ").slice(0, max)}${text.length > max ? "…" : ""}`;
    const lines = [preview.title];
    if (notes.revision)
      lines.push(`Revised with: ${notes.revision.split("\n").join(" · ")}`);
    lines.push(
      `Work: ${trim(preview.scope, 320)}`,
      `Done so far: ${trim(preview.completedWork, 200)}`,
      `Done when: ${preview.acceptanceChecks
        .slice(0, 3)
        .map((c) => trim(c, 120))
        .join(
          " · ",
        )}${preview.acceptanceChecks.length > 3 ? ` (+${preview.acceptanceChecks.length - 3} more)` : ""}`,
      `Worker AI: ${preview.aiRequirement.provider} / ${preview.aiRequirement.model} / ${preview.aiRequirement.effort}${notes.workerAiReason ? ` — ${notes.workerAiReason}` : ""} (availability not verified)`,
      `Reward: ${preview.rewardTig} TIG${notes.rewardReason ? ` — ${notes.rewardReason}` : ""} · deadline ${preview.executionDeadlineAt}`,
    );
    if (tree) lines.push(...treeSummaryLines(preview, tree));
    else
      lines.push(
        `Public destination: github.com/${preview.repository} · ${preview.files.length} files incl. request.md and request.json${sharedNew.length ? ` · new files included: ${sharedNew.slice(0, 5).join(", ")}${sharedNew.length > 5 ? ", …" : ""}` : ""} · ${preview.excluded.length} excluded · ${preview.untrackedNotShared.length} new files kept private`,
      );
    ui.say(lines.join("\n"));
    if (preview.gitPublished)
      ui.say(
        "This request's Git snapshot is already public. Continue to finish platform registration with the same request.",
      );
    const choice = await publicationChoice(
      ui,
      preview.rewardTig,
      tree?.secretHeld ?? [],
    );
    if (choice.action === 0) {
      ui.say(await readFile(preview.requestFile, "utf8"));
      if (tree) {
        ui.say(treeDetailLines(preview, tree).join("\n"));
        // Changes against HEAD (the rest of the tree is the committed project).
        const shown = tree.changedSinceHead.slice(0, DETAIL_LINES);
        if (shown.length)
          ui.say(
            shown.map((c) => `${CHANGE_MARK[c.kind]} ${c.path}`).join("\n") +
              (tree.changedSinceHead.length > shown.length
                ? `\n… ${tree.changedSinceHead.length - shown.length} more changed or new files`
                : ""),
          );
        else ui.say("No changes since the last commit; the tree is HEAD.");
        // Every held-back file by name, because "include tests/" is typed
        // against this list and a capped list cannot be typed against.
        (tree.secretHeld ?? [])
          .slice(0, DETAIL_LINES)
          .forEach((h) =>
            ui.say(`Held back: ${h.path} — ${h.reasons.join(", ")}`),
          );
        (tree.secretPublished ?? []).forEach((h) =>
          ui.say(
            `Going public at your word: ${h.path} — ${h.reasons.join(", ")}`,
          ),
        );
        preview.excluded.forEach((f) =>
          ui.say(`Excluded: ${f.path} — ${f.reason}`),
        );
        if (tree.excludedCount > preview.excluded.length)
          ui.say(
            `… ${tree.excludedCount - preview.excluded.length} more excluded files`,
          );
      } else {
        preview.files.forEach((f) => ui.say(`${f.path} · ${f.bytes} bytes`));
        preview.excluded.forEach((f) =>
          ui.say(`Excluded: ${f.path} — ${f.reason}`),
        );
        preview.untrackedNotShared.forEach((f) =>
          ui.say(`Private new file: ${f}`),
        );
      }
      continue;
    }
    if (choice.action === 2) {
      ui.say(notPublished(id));
      throw new Cancelled();
    }
    if (choice.action === 3) {
      if (preview.gitPublished) {
        ui.say(
          "Finish this published snapshot first. It cannot be withdrawn by discarding a local draft.",
        );
        continue;
      }
      return false;
    }
    if (choice.action === 4) {
      if (preview.gitPublished) {
        ui.say(
          "This snapshot is already public; its terms cannot change. Publish it, or start a new request.",
        );
        continue;
      }
      return { reward: choice.reward, workerAi: choice.workerAi };
    }
    if (choice.action === 5) {
      // Enter on the question keeps the request: back to the summary.
      if (!choice.revision) continue;
      if (preview.gitPublished) {
        ui.say(
          "This snapshot is already public; its request cannot change. Publish it, or start a new request.",
        );
        continue;
      }
      return { revision: choice.revision };
    }
    if (choice.action === 6) {
      if (preview.gitPublished) {
        ui.say(
          "This snapshot is already public; what it carries cannot change. Publish it, or start a new request.",
        );
        continue;
      }
      return { secretInclude: choice.secretInclude };
    }
    try {
      const receipt = await ui.busy(
        tree
          ? preview.destination === "new"
            ? "Creating the request repository and uploading your project, then registering your task…"
            : "Uploading the request branch, then registering your task…"
          : "Uploading request + code, then registering your task…",
        () => services.publishRequest(id, preview.previewDigest, true),
      );
      ui.section("complete", "Your request is live");
      ui.say(
        `${tree ? (preview.destination === "new" ? `✓ New public repository github.com/${preview.repository} created; your project and request.md are on its ${preview.branch} branch` : `✓ Branch ${preview.branch} uploaded to github.com/${preview.repository}`) : "✓ Code and request.md uploaded"}\n✓ ${preview.rewardTig} TIG reserved\n\nRepository: https://github.com/${preview.repository}\nRequest: ${receipt.requestUrl}\nTask: ${receipt.taskUrl}\nYou can follow this task on the website.`,
      );
      return true;
    } catch (e) {
      ui.say((e as Error).message);
      ui.say(
        "Your request is saved. Git upload or task registration may already have succeeded; retry uses the same request and prevents a second reservation.",
      );
      if (
        (await ui.choose("Next step", [
          "Save and exit",
          "Retry this request",
        ])) === 0
      )
        throw new Cancelled();
    }
  }
}

// "include a/b.ts src/" read against the files the gate held back. Every token
// has to name a held-back file — exactly, or as a folder holding one — and there
// is no wildcard, no "all" and no "." that stands for the list: the requester
// types what they are publishing, so the act carries the information that typing
// yes past a list does not. Unknown tokens come back unmatched rather than
// silently doing nothing. Returns null when this is not an include answer.
export function parseSecretInclude(
  answer: string,
  held: readonly SecretAcceptance[],
): { accept: SecretAcceptance[]; unmatched: string[] } | null {
  const said = /^(?:include|포함)(?:\s+([\s\S]*))?$/i.exec(answer.trim());
  if (!said) return null;
  const accept = new Map<string, string[]>();
  const unmatched: string[] = [];
  for (const token of (said[1] ?? "").split(/[\s,]+/).filter(Boolean)) {
    const folder = token.endsWith("/") ? token : `${token}/`;
    const matched = held.filter(
      (h) => h.path === token || h.path.startsWith(folder),
    );
    if (!matched.length) unmatched.push(token);
    // The classes come from the list that was printed, not from the answer: the
    // requester accepts what they were shown, and a class that turns up later is
    // a finding nobody has read (partitionHits holds it back again).
    for (const h of matched) accept.set(h.path, h.reasons);
  }
  return {
    accept: [...accept].map(([path, reasons]) => ({ path, reasons })),
    unmatched,
  };
}
// yes → 1 (publish), details → 0, later → 2, new → 3, an amount or
// provider / model / effort → 4 (change the terms), no → 5 with what should change
// (no `revision` when the requester pressed Enter and keeps the request),
// include <paths> → 6 (publish those held-back files, reviewed again first).
export async function publicationChoice(
  ui: Terminal,
  reward: string,
  // What the gate held back, so an include answer can be read against it. Empty
  // when there is nothing held back, and then `include` is not an answer at all.
  held: readonly SecretAcceptance[] = [],
): Promise<{
  action: number;
  reward?: string;
  workerAi?: WorkerAi;
  revision?: string;
  secretInclude?: SecretAcceptance[];
}> {
  while (true) {
    // Paths are case-sensitive, so the include answer is read before anything
    // lowercases it.
    const raw = (
      await ui.ask(
        `Publish publicly and reserve ${reward} TIG? (yes / no / details / later)`,
        "later",
      )
    ).trim();
    const answer = raw.toLowerCase();
    if (held.length) {
      const include = parseSecretInclude(raw, held);
      if (include) {
        if (include.accept.length)
          return { action: 6, secretInclude: include.accept };
        ui.say(
          include.unmatched.length
            ? `Not on the held-back list: ${include.unmatched.slice(0, 5).join(", ")}. Name a file or a folder exactly as it is listed; details names all ${held.length}. Nothing changed.`
            : `Name what to include: include <path or folder>, for example include ${held[0].path}. Nothing changed.`,
        );
        continue;
      }
    }
    if (["details", "자세히", "보기"].includes(answer)) return { action: 0 };
    if (["later", "나중에", "저장", ""].includes(answer)) return { action: 2 };
    if (["new", "새 요청"].includes(answer)) return { action: 3 };
    if (
      ["publish", "upload", "올려줘", "업로드", "게시", "올려주세요"].includes(
        answer,
      )
    )
      return { action: 1 };
    const workerAi = parseWorkerAi(answer);
    if (workerAi) return { action: 4, workerAi };
    const amount = statedReward(answer, true);
    if (amount) return { action: 4, reward: amount };
    const choice = confirmationAnswer(answer);
    if (choice === true) return { action: 1 };
    if (choice === false) {
      // "no" means "change it": one open question, answered in the user's words.
      const revision = (
        await ui.ask(
          "What should change? (describe it; Enter keeps the request)",
        )
      ).trim();
      if (!revision) return { action: 5 };
      if (revision.length > 2000 || containsSecret(revision)) {
        ui.say(
          "Describe the change in up to 2000 characters without sensitive content. The request is kept as it is.",
        );
        return { action: 5 };
      }
      return { action: 5, revision };
    }
    ui.say(
      `Reply yes to publish, no to change the request, details to inspect, later to save, an amount to change the reward, or provider / model / effort to change the worker AI.${held.length ? " To publish a file the secret gate held back, reply include followed by its path or folder." : ""} 한글로 네 / 아니요 / 자세히 / 나중에도 가능합니다.`,
    );
  }
}

// Everything the wizard reaches outside the project folder and tig's state directory,
// so the whole flow can be driven with fixtures; the default is the real environment.
export interface WizardServices {
  // null when tig is not running in an interactive terminal.
  terminal: () => (Terminal & { signal: AbortSignal; close(): void }) | null;
  cwd: () => string;
  listRecentSessions: () => Promise<AiSession[]>;
  connect: typeof ensureConnection;
  signIns: typeof ensureSignIns;
  requester: typeof ensureRequester;
  api: typeof api;
  findExecutable: typeof findExecutable;
  codexModels: (binary: string, signal?: AbortSignal) => Promise<CodexModel[]>;
  facts: (root: string) => Promise<ProjectFacts>;
  prepareRequest: typeof prepareRequest;
  showRequest: typeof showRequest;
  publishRequest: typeof publishRequest;
}
export const wizardServices: WizardServices = {
  terminal: () =>
    process.stdin.isTTY && process.stdout.isTTY ? new RequestTerminal() : null,
  cwd: () => process.cwd(),
  listRecentSessions: () => listRecentSessions(),
  connect: ensureConnection,
  signIns: ensureSignIns,
  requester: ensureRequester,
  api,
  findExecutable,
  codexModels: readCodexModels,
  facts: projectFacts,
  prepareRequest,
  showRequest,
  publishRequest,
};
const REQUEST_MIN = 3;
const REQUEST_MAX = 2000;
const validRequest = (v: string) =>
  v.length >= REQUEST_MIN && v.length <= REQUEST_MAX && !containsSecret(v);
export async function runRequesterWizard(
  options: { setup?: boolean; request?: string } = {},
  s: WizardServices = wizardServices,
) {
  const ui = s.terminal();
  if (!ui) {
    console.log(
      "Tokenisgold · Run tig in an interactive terminal to hand off a task.\nFor scripts: tig --help",
    );
    return;
  }
  const review = {
    showRequest: s.showRequest,
    publishRequest: s.publishRequest,
  };
  // Every run is a new request.
  const session: RequestState = { request: "" };
  try {
    ui.section("TOKENISGOLD", "Your next task starts here");
    ui.say(
      "I'll confirm the project folder, ask what to hand off and on what terms, and show you a summary to approve. request.md is written from your answers; no AI drafts it.\nAnswers can be in English or Korean (한국어로 답해도 됩니다). Type /cancel or press Ctrl+C to stop.",
    );
    const prefs = await saved(preferencesPath(), preferencesSchema, {});
    // 1. The folder: named, then confirmed; no asks for another one.
    const sessions = options.setup
      ? []
      : await ui.busy("Looking for your recent work…", () =>
          s.listRecentSessions(),
        );
    const folder = await chooseProjectFolder(ui, {
      cwd: s.cwd(),
      sessions,
      lastRoot: prefs.lastRoot ?? null,
    });
    const root = await ensureProject(folder, ui);
    prefs.lastRoot = root;
    await atomicJson(preferencesPath(), prefs);
    // 2. Who is signed in where: the GitHub account the request repositories
    // will be created under is confirmed; Codex / Claude Code sign-in is
    // checked and offered.
    const { login } = await s.signIns(ui, root);
    const account = await s.connect(ui, !!options.setup, ui.signal);
    await s.requester(root, account, ui, !!options.setup, login);
    const wallet = await s.api("/v1/wallet");
    ui.say(
      `✓ ${basename(root)} · ${wallet.available} TIG available · github.com/${login}`,
    );
    // The prepared input, written for prepareRequest; overwritten by every run.
    const specPath = join(
      stateDir(),
      "requester-inputs",
      `${digest(`${account.origin}:${account.user.id}:${root}`)}.json`,
    );
    // A review-screen answer that keeps the request but changes it: terms are
    // replaced, held-back files are added (a union, never a replacement: two
    // include answers in a row are two decisions), a "no" is appended to the
    // requested work. The request is prepared again afterwards; no AI is called.
    const applyOutcome = (outcome: {
      reward?: string;
      workerAi?: WorkerAi;
      revision?: string;
      secretInclude?: SecretAcceptance[];
    }) => {
      if (outcome.secretInclude?.length) {
        const named = new Map(
          (session.publishSecret ?? []).map((a) => [a.path, a]),
        );
        for (const entry of outcome.secretInclude) named.set(entry.path, entry);
        session.publishSecret = [...named.values()];
      }
      if (outcome.reward) session.reward = outcome.reward;
      if (outcome.workerAi) session.workerAi = outcome.workerAi;
      if (outcome.revision)
        session.revision = [session.revision, outcome.revision]
          .filter(Boolean)
          .join("\n");
      delete session.pending;
    };
    const notes = () => ({
      rewardReason: SET_BY_YOU,
      workerAiReason: SET_BY_YOU,
      revision: session.revision,
    });
    // 2. The work, in the requester's words: from the command line or one
    // question. The terms named in it are read out of it here.
    let named: { provider?: LocalAiProvider; model?: string; effort?: string } =
      {};
    const take = (text: string) => {
      const terms = parseRequestTerms(text);
      session.request = terms.work;
      session.reward = terms.reward;
      named = {
        provider: terms.provider,
        model: terms.model,
        effort: terms.effort,
      };
    };
    if (options.request) {
      if (!validRequest(options.request))
        throw new Error(
          `Describe the work in ${REQUEST_MIN} to ${REQUEST_MAX} characters without sensitive content.`,
        );
      take(options.request);
    } else {
      ui.say(
        "Describe the work for the worker. You can name the tool, model, reasoning level and reward in the same answer (for example: refactor the auth middleware, claude / opus / high, 300 TIG).",
      );
      take(await required(ui, "What should the worker do?", validRequest));
    }
    // 3. The worker AI, 4. the reward, 5. the acceptance checks — each asked
    // only when the answer did not name it. Never proposed.
    session.workerAi = await askWorkerAi(ui, named, {
      findExecutable: s.findExecutable,
      codexModels: s.codexModels,
      signal: ui.signal,
    });
    if (!session.reward) session.reward = await collectReward("", ui);
    else
      ui.say(`Reward: ${session.reward} TIG · reserved only when you publish`);
    session.acceptance = await askAcceptance(ui, session.request);
    const ai = session.workerAi;
    ui.say(
      `Worker AI: ${ai.provider} / ${ai.model} / ${ai.effort} · Done when: ${session.acceptance
        .slice(0, 3)
        .join(
          " · ",
        )}${session.acceptance.length > 3 ? ` (+${session.acceptance.length - 3} more)` : ""}`,
    );
    // 6. The project's facts, the tree, the summary. Repeats when the review
    // screen changes the terms or appends to the request; nothing is drafted.
    const facts = await ui.busy("Reading the project…", () => s.facts(root));
    while (true) {
      const untracked = await listUntracked(root);
      const snapshot = await capture(root, { approvedUntracked: untracked });
      const input = buildRequestInput({
        request: session.request,
        revision: session.revision,
        acceptance: session.acceptance,
        facts,
        ai: session.workerAi,
        reward: session.reward,
      });
      await atomicJson(specPath, input);
      const preview = await ui.busy(
        "Checking the request and preparing its Git snapshot…",
        () =>
          s.prepareRequest({
            project: root,
            spec: specPath,
            include: untracked,
            publishSecret: session.publishSecret,
            expectedManifestHash: snapshot.artifact.manifestHash,
          }),
      );
      session.pending = preview.requestId;
      const outcome = await reviewAndPublish(
        preview.requestId,
        ui,
        review,
        notes(),
      );
      if (outcome === true) return;
      if (outcome === false) {
        ui.say(notPublished(preview.requestId));
        return;
      }
      applyOutcome(outcome);
    }
  } catch (e) {
    if (e instanceof Cancelled || ui.signal.aborted)
      ui.say(
        "Stopped. Nothing was published; the next tig starts a new request.",
      );
    else {
      ui.say(e instanceof Error ? e.message : "Something went wrong.");
      ui.say("Nothing was published. Run tig to start a new request.");
      process.exitCode = 1;
    }
  } finally {
    ui.close();
  }
}
