import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { findExecutable } from "./executables.js";
import {
  claudeReadiness,
  codexReadiness,
  localAiTools,
  subscriptionEnvironment,
  workerAgentReadiness,
  type LocalAiProvider,
} from "./local-ai.js";
import { ApiError, api, loadConnection } from "./client.js";
import { sandboxDoctor } from "./sandbox.js";

const exec = promisify(execFile);

// `gh repo create --add-readme` (request repositories) needs 2.21; fork/pr flags are older.
export const GH_MIN_VERSION = "2.21.0";
export const NODE_MAJOR = 24;

export type CheckStatus =
  "ok" | "missing" | "outdated" | "signed_out" | "unreachable" | "unknown";
export interface Check {
  id: string;
  name: string;
  status: CheckStatus;
  // True when this item alone does not block tig (one local AI tool is enough).
  optional: boolean;
  detail: string;
  fix: string | null;
}
export interface DoctorReport {
  checks: Check[];
  ready: boolean;
  isolation: Awaited<ReturnType<typeof sandboxDoctor>>;
}
export interface DoctorServices {
  nodeVersion: string;
  findExecutable(name: string): Promise<string | null>;
  version(binary: string): Promise<string | null>;
  ghAuth(binary: string): Promise<{ login: string | null } | null>;
  claudeReadiness(binary: string): Promise<void>;
  codexReadiness(binary: string): Promise<void>;
  // Flags an agentic worker run needs (tig work on a tree-layout request); optional
  // so that a drafting-only check stays possible.
  workerReadiness?(provider: LocalAiProvider, binary: string): Promise<void>;
  loadConnection(): Promise<{ origin: string }>;
  me(): Promise<{ login?: string }>;
  isolation(): Promise<DoctorReport["isolation"]>;
}

async function output(binary: string, args: string[], env: NodeJS.ProcessEnv) {
  try {
    const { stdout, stderr } = await exec(binary, args, {
      timeout: 10000,
      env,
      maxBuffer: 200000,
      windowsHide: true,
    });
    return `${stdout}\n${stderr}`.trim();
  } catch {
    return null;
  }
}
export const doctorServices: DoctorServices = {
  nodeVersion: process.version,
  findExecutable: (name) => findExecutable(name),
  version: (binary) => output(binary, ["--version"], subscriptionEnvironment()),
  ghAuth: async (binary) => {
    // Exit status is the signed-in signal; the account name is informational only.
    // Token values are never printed by `gh auth status` without --show-token.
    try {
      const { stdout, stderr } = await exec(
        binary,
        ["auth", "status", "--hostname", "github.com"],
        {
          timeout: 15000,
          maxBuffer: 200000,
          windowsHide: true,
          env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" },
        },
      );
      const text = `${stdout}\n${stderr}`;
      return {
        login:
          text.match(/account ([A-Za-z0-9-]+)/)?.[1] ??
          text.match(/ as ([A-Za-z0-9-]+)/)?.[1] ??
          null,
      };
    } catch {
      return null;
    }
  },
  claudeReadiness: (binary) => claudeReadiness(binary),
  codexReadiness: (binary) => codexReadiness(binary),
  workerReadiness: (provider, binary) => workerAgentReadiness(provider, binary),
  loadConnection,
  me: () => api("/v1/me"),
  isolation: sandboxDoctor,
};

export function semver(text: string | null) {
  return text?.match(/(\d+)\.(\d+)\.(\d+)/)?.[0] ?? null;
}
export function olderThan(version: string, minimum: string) {
  const a = version.split(".").map(Number),
    b = minimum.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}
function readinessStatus(message: string): CheckStatus {
  if (/^Update /.test(message)) return "outdated";
  if (/sign in|signed in/i.test(message)) return "signed_out";
  return "unknown";
}
async function aiCheck(
  provider: LocalAiProvider,
  s: DoctorServices,
): Promise<Check> {
  const tool = localAiTools[provider];
  const base = { id: provider, name: tool.name, optional: false };
  const binary = await s.findExecutable(tool.binary);
  if (!binary)
    return {
      ...base,
      status: "missing",
      detail: "not installed",
      fix: `Install ${tool.name}: ${tool.installUrl}`,
    };
  const version = semver(await s.version(binary)) ?? "unknown version";
  try {
    await (provider === "claude" ? s.claudeReadiness : s.codexReadiness)(
      binary,
    );
    // Drafting works; workspace execution (tig work on a tree request) needs the
    // sandbox/permission flags too, so an old tool is reported before a job starts.
    if (s.workerReadiness)
      try {
        await s.workerReadiness(provider, binary);
      } catch {
        return {
          ...base,
          status: "outdated",
          detail: `${version}, signed in, but too old to run work in a sandboxed workspace`,
          fix:
            provider === "claude"
              ? "claude update"
              : `Update ${tool.name}: ${tool.installUrl}`,
        };
      }
    return {
      ...base,
      status: "ok",
      detail: `${version}, signed in with your subscription`,
      fix: null,
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const status = readinessStatus(message);
    return {
      ...base,
      status,
      detail: `${version}, ${status === "outdated" ? "too old for tig" : status === "signed_out" ? "not signed in with a subscription" : "could not be checked"}`,
      fix:
        status === "outdated"
          ? provider === "claude"
            ? "claude update"
            : `Update ${tool.name}: ${tool.installUrl}`
          : status === "signed_out"
            ? `${tool.binary} ${tool.loginArgs.join(" ")}`
            : message,
    };
  }
}

export async function environmentReport(
  s: DoctorServices = doctorServices,
): Promise<DoctorReport> {
  const checks: Check[] = [];
  const major = Number(s.nodeVersion.match(/^v?(\d+)/)?.[1]);
  checks.push({
    id: "node",
    name: "Node.js",
    optional: false,
    status: major === NODE_MAJOR ? "ok" : "outdated",
    detail: s.nodeVersion,
    fix:
      major === NODE_MAJOR
        ? null
        : `Install Node.js ${NODE_MAJOR}: https://nodejs.org (or: nvm install ${NODE_MAJOR})`,
  });

  const git = await s.findExecutable("git");
  checks.push({
    id: "git",
    name: "Git",
    optional: false,
    status: git ? "ok" : "missing",
    detail: git
      ? (semver(await s.version(git)) ?? "installed")
      : "not installed",
    fix: git ? null : "Install Git: https://git-scm.com/downloads",
  });

  const gh = await s.findExecutable("gh");
  if (!gh)
    checks.push({
      id: "gh",
      name: "GitHub CLI",
      optional: false,
      status: "missing",
      detail: "not installed (needed to publish requests and results)",
      fix: "Install GitHub CLI: https://cli.github.com",
    });
  else {
    const version = semver(await s.version(gh));
    if (!version || olderThan(version, GH_MIN_VERSION))
      checks.push({
        id: "gh",
        name: "GitHub CLI",
        optional: false,
        status: "outdated",
        detail: `${version ?? "unknown version"}, tig needs ${GH_MIN_VERSION} or newer`,
        fix: "Update GitHub CLI: https://cli.github.com",
      });
    else {
      const auth = await s.ghAuth(gh);
      checks.push({
        id: "gh",
        name: "GitHub CLI",
        optional: false,
        status: auth ? "ok" : "signed_out",
        detail: auth
          ? `${version}, signed in${auth.login ? ` as ${auth.login}` : ""}`
          : `${version}, not signed in`,
        fix: auth ? null : "gh auth login",
      });
    }
  }

  const claude = await aiCheck("claude", s);
  const codex = await aiCheck("codex", s);
  // One signed-in local AI tool is enough; the other one is then informational.
  claude.optional = codex.status === "ok";
  codex.optional = claude.status === "ok";
  checks.push(claude, codex);

  let connection: Check;
  try {
    const { origin } = await s.loadConnection();
    try {
      const me = await s.me();
      connection = {
        id: "tokenisgold",
        name: "Tokenisgold",
        optional: false,
        status: "ok",
        detail: `${origin}${me.login ? ` as ${me.login}` : ""}`,
        fix: null,
      };
    } catch (e) {
      const expired = e instanceof ApiError && e.status === 401;
      connection = {
        id: "tokenisgold",
        name: "Tokenisgold",
        optional: false,
        status: expired ? "signed_out" : "unreachable",
        detail: expired
          ? `${origin}, device session expired`
          : `${origin}, cannot reach the website`,
        fix: expired
          ? `tig connect --origin ${origin}`
          : "Check the address and your network, then retry",
      };
    }
  } catch {
    connection = {
      id: "tokenisgold",
      name: "Tokenisgold",
      optional: false,
      status: "missing",
      detail: "this computer is not connected yet",
      fix: "tig connect --origin <website>",
    };
  }
  checks.push(connection);

  const isolation = await s.isolation();
  const ready = checks.every((c) => c.status === "ok" || c.optional);
  return { checks, ready, isolation };
}

export function renderDoctor(report: DoctorReport) {
  const lines = report.checks.map((c) => {
    const glyph = c.status === "ok" ? "✓" : c.optional ? "·" : "✗";
    return (
      `  ${glyph} ${c.name.padEnd(12)} ${c.detail}` +
      (c.fix && c.status !== "ok" ? `\n      → ${c.fix}` : "")
    );
  });
  // What actually contains a worker run today: each tool's own sandbox inside the
  // task workspace. bwrap is probed but tig does not wrap the tools in it yet.
  lines.push(
    "  · Execution    inside the task workspace: Codex --sandbox workspace-write (no network) · Claude Code --restricted (file tools only, no commands)",
    `  · Isolation    bwrap ${report.isolation.available ? "available" : "unavailable"} (${report.isolation.reason})`,
  );
  lines.push(
    "",
    report.ready
      ? "  Ready. Run tig to post a request, or tig work --market to earn TIG."
      : "  Fix the items marked ✗, then run tig doctor again.",
  );
  return lines.join("\n");
}
