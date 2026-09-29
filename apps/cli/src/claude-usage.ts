// Claude Code usage without a paid API: Claude Code feeds its status line command JSON
// that includes `rate_limits` (5-hour / 7-day used percentage and reset time) for
// claude.ai subscribers. tig registers itself as that command (opt-in), keeps only the
// rate-limit numbers on disk, and shows them plus a Tokenisgold hint at the bottom of
// the Claude Code window. Existing status lines keep working: tig runs them first.
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { atomicJson, stateDir } from "./drafts.js";
import { subscriptionEnvironment } from "./local-ai.js";
import {
  observationSchema,
  usageSignal,
  type Observation,
} from "../../../packages/contracts/src/index.js";

const exec = promisify(execFile);
export const STATUS_LINE_SUBCOMMAND = "claude-statusline";

export function claudeSettingsPath(env: NodeJS.ProcessEnv = process.env) {
  return join(
    env.CLAUDE_CONFIG_DIR ?? join(env.HOME ?? homedir(), ".claude"),
    "settings.json",
  );
}
export const rateLimitsPath = () => join(stateDir(), "claude-rate-limits.json");
const statusLineStatePath = () => join(stateDir(), "claude-statusline.json");

export interface RateWindow {
  used_percentage?: number;
  resets_at?: number;
}
export interface RateLimits {
  five_hour?: RateWindow;
  seven_day?: RateWindow;
  spend_limit?: RateWindow;
}
export interface CapturedRateLimits {
  capturedAt: string;
  rateLimits: RateLimits;
}
export interface StatusLineSetting {
  type?: string;
  command?: string;
  [key: string]: unknown;
}

const number = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;
// Keep only the documented numeric fields; session details (cwd, model, cost) are not stored.
export function pickRateLimits(value: unknown): RateLimits | null {
  if (!value || typeof value !== "object") return null;
  const out: RateLimits = {};
  for (const name of ["five_hour", "seven_day", "spend_limit"] as const) {
    const w = (value as Record<string, unknown>)[name];
    if (!w || typeof w !== "object") continue;
    const window: RateWindow = {};
    const used = number((w as Record<string, unknown>).used_percentage);
    const resets = number((w as Record<string, unknown>).resets_at);
    if (used !== undefined) window.used_percentage = used;
    if (resets !== undefined) window.resets_at = resets;
    out[name] = window;
  }
  return out;
}

export function projectClaudeMetadata(
  captured: CapturedRateLimits | null,
  version: string,
  now = Date.now(),
): Observation {
  const windows = (["five_hour", "seven_day"] as const).map((name) => {
    const w = captured?.rateLimits?.[name];
    const resets = number(w?.resets_at);
    // A window past its reset time is stale (Claude Code drops it too): report unknown,
    // never the old value. A percentage above 100 means the limit was exceeded.
    const fresh = !!w && (resets === undefined || resets * 1000 > now);
    const used = fresh ? number(w?.used_percentage) : undefined;
    return {
      name: `claude:${name}`,
      required: true,
      usedPercent: used === undefined || used < 0 ? null : Math.min(100, used),
      resetsAt:
        fresh && resets !== undefined
          ? new Date(resets * 1000).toISOString()
          : null,
    };
  });
  return observationSchema.parse({
    provider: "claude",
    planId: null,
    source: "client_observed",
    toolVersion: version,
    windows,
  });
}

export async function loadCapturedRateLimits(): Promise<CapturedRateLimits | null> {
  try {
    const parsed = JSON.parse(await readFile(rateLimitsPath(), "utf8"));
    const rateLimits = pickRateLimits(parsed?.rateLimits);
    if (!rateLimits || typeof parsed?.capturedAt !== "string") return null;
    return { capturedAt: parsed.capturedAt, rateLimits };
  } catch {
    return null;
  }
}
export async function claudeVersion(binary: string) {
  try {
    const { stdout } = await exec(binary, ["--version"], {
      timeout: 10000,
      env: subscriptionEnvironment(),
      windowsHide: true,
    });
    const v = stdout.match(/\d+\.\d+\.\d+/)?.[0];
    return v ? `claude-code ${v}` : "unknown";
  } catch {
    return "unknown";
  }
}
export async function readClaudeObservation(binary: string, now = Date.now()) {
  const captured = await loadCapturedRateLimits();
  return {
    observation: projectClaudeMetadata(
      captured,
      await claudeVersion(binary),
      now,
    ),
    capturedAt: captured?.capturedAt ?? null,
  };
}

// --- status line runtime -----------------------------------------------------------

export async function captureStatusLine(input: string, now = new Date()) {
  let json: unknown;
  try {
    json = JSON.parse(input);
  } catch {
    return null;
  }
  const rateLimits = pickRateLimits(
    (json as Record<string, unknown> | null)?.rate_limits,
  );
  // rate_limits is absent before the first response and for non-subscription logins;
  // keep the last capture in that case instead of overwriting it with nothing.
  if (!rateLimits || !Object.keys(rateLimits).length) return null;
  const captured = { capturedAt: now.toISOString(), rateLimits };
  await atomicJson(rateLimitsPath(), captured);
  return captured;
}

export function tigStatusText(
  captured: CapturedRateLimits | null,
  now = Date.now(),
) {
  if (!captured) return "Tig · usage not reported yet";
  const { windows } = projectClaudeMetadata(captured, "statusline", now);
  const parts = windows.map(
    (w) =>
      `${w.name.endsWith("five_hour") ? "5h" : "7d"} ${
        w.usedPercent === null ? "?" : `${Math.round(w.usedPercent)}%`
      }`,
  );
  const signal = usageSignal(windows);
  const hint =
    signal === "low"
      ? " · 80%+ used — run tig to hand off the rest"
      : signal === "spare"
        ? " · spare usage — tig work --market earns TIG"
        : "";
  return `Tig · ${parts.join(" · ")}${hint}`;
}

export function runShell(
  command: string,
  input: string,
  timeout = 3000,
): Promise<string> {
  return new Promise((resolve) => {
    const child =
      process.platform === "win32"
        ? spawn("cmd.exe", ["/d", "/s", "/c", command], { windowsHide: true })
        : spawn("/bin/sh", ["-c", command]);
    let out = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.stdout.on("data", (b) => (out += b.toString()));
    child.stderr.on("data", () => {});
    child.on("error", () => {
      clearTimeout(timer);
      resolve("");
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(out);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

async function loadStatusLineState(): Promise<{
  previous: StatusLineSetting | null;
} | null> {
  try {
    return JSON.parse(await readFile(statusLineStatePath(), "utf8"));
  } catch {
    return null;
  }
}

export async function runStatusLine(
  input: string,
  options: {
    now?: Date;
    previous?: StatusLineSetting | null;
    run?: typeof runShell;
  } = {},
) {
  const now = options.now ?? new Date();
  const previous =
    options.previous === undefined
      ? ((await loadStatusLineState())?.previous ?? null)
      : options.previous;
  const captured =
    (await captureStatusLine(input, now)) ?? (await loadCapturedRateLimits());
  const lines: string[] = [];
  if (previous?.type === "command" && typeof previous.command === "string") {
    const out = (
      await (options.run ?? runShell)(previous.command, input)
    ).trimEnd();
    if (out) lines.push(out);
  }
  lines.push(tigStatusText(captured, now.getTime()));
  return lines.join("\n");
}

// --- install / uninstall -----------------------------------------------------------

export async function statusLineLauncher(home = homedir()) {
  // The managed launcher has an absolute path, so the status line works even when
  // Claude Code's shell does not have ~/.local/bin on PATH.
  const managed = join(home, ".local", "bin", "tig");
  try {
    await access(managed);
    return `${managed} ${STATUS_LINE_SUBCOMMAND}`;
  } catch {
    return `tig ${STATUS_LINE_SUBCOMMAND}`;
  }
}
export const isTigStatusLine = (setting: unknown) =>
  !!setting &&
  typeof setting === "object" &&
  typeof (setting as StatusLineSetting).command === "string" &&
  (setting as StatusLineSetting).command!.endsWith(STATUS_LINE_SUBCOMMAND);

async function readSettings(path: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return {};
  }
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(`${path} is not a JSON object. Fix it before continuing.`);
  return parsed;
}
async function writeSettings(path: string, settings: Record<string, unknown>) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(settings, null, 2) + "\n");
}

export async function installStatusLine(
  settingsPath = claudeSettingsPath(),
  launcher?: string,
) {
  const command = launcher ?? (await statusLineLauncher());
  const settings = await readSettings(settingsPath);
  const current = settings.statusLine as StatusLineSetting | undefined;
  if (isTigStatusLine(current))
    return {
      changed: false,
      previous: (await loadStatusLineState())?.previous ?? null,
    };
  // Remember the user's own status line so uninstall restores it and tig keeps showing it.
  await atomicJson(statusLineStatePath(), {
    previous: current ?? null,
    settingsPath,
    installedAt: new Date().toISOString(),
  });
  settings.statusLine = { type: "command", command };
  await writeSettings(settingsPath, settings);
  return { changed: true, previous: current ?? null };
}

export async function uninstallStatusLine(settingsPath = claudeSettingsPath()) {
  const settings = await readSettings(settingsPath);
  if (!isTigStatusLine(settings.statusLine)) return { changed: false };
  const previous = (await loadStatusLineState())?.previous ?? null;
  if (previous) settings.statusLine = previous;
  else delete settings.statusLine;
  await writeSettings(settingsPath, settings);
  await rm(statusLineStatePath(), { force: true });
  return { changed: true };
}
