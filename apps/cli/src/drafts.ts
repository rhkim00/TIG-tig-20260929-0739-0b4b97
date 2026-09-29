import {
  mkdir,
  readFile,
  writeFile,
  rename,
  realpath,
  open,
  lstat,
} from "node:fs/promises";
import { constants } from "node:fs";
import { resolve, relative, join, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isUtf8 } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import {
  safePath,
  containsSecret,
} from "../../../packages/contracts/src/files.js";
import { artifactSchema } from "../../../packages/contracts/src/index.js";
const exec = promisify(execFile);
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const stateDir = () =>
  process.env.TIG_STATE_DIR ??
  join(homedir(), ".local", "share", "tokenisgold");
export async function atomicJson(path: string, body: unknown) {
  const dir = resolve(path, "..");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(body, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  await rename(temp, path);
}
export async function git(root: string, args: string[]) {
  return (await exec("git", ["-C", root, ...args], { maxBuffer: 64_000_000 }))
    .stdout;
}
export async function projectRoot(path: string) {
  return realpath(
    (await git(resolve(path), ["rev-parse", "--show-toplevel"])).trim(),
  );
}
export interface Draft {
  version: 1;
  root: string;
  baseCommit: string;
  summary: string;
  updatedAt: string;
  lastSummaryAt: string | null;
  fallbackEnabled: boolean;
  artifact: ReturnType<typeof artifactSchema.parse>;
  excluded: { path: string; reason: string }[];
  approvedUntracked: string[];
}
export const draftPath = (root: string) =>
  join(stateDir(), "drafts", `${digest(root)}.json`);
export async function loadDraft(root: string): Promise<Draft | null> {
  try {
    return JSON.parse(await readFile(draftPath(root), "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export async function capture(
  path: string,
  options: {
    summary?: string;
    approvedUntracked?: string[];
    selectedPaths?: string[];
    fallbackEnabled?: boolean;
    now?: Date;
  } = {},
): Promise<Draft> {
  const root = await projectRoot(path),
    old = await loadDraft(root),
    now = options.now ?? new Date();
  const summary =
    options.summary ??
    old?.summary ??
    "Local project snapshot. Add the next task and acceptance checks before posting.";
  if (containsSecret(summary))
    throw new Error("Remove sensitive content from the summary.");
  const tracked = (await git(root, ["ls-files", "-z"]))
    .split("\0")
    .filter(Boolean);
  const untracked = (
    await git(root, ["ls-files", "--others", "--exclude-standard", "-z"])
  )
    .split("\0")
    .filter(Boolean);
  const deletedPaths = (await git(root, ["ls-files", "--deleted", "-z"]))
    .split("\0")
    .filter((p) => p && safePath(p));
  const approved = options.approvedUntracked ?? old?.approvedUntracked ?? [];
  // Sets: a large project can have tens of thousands of untracked paths.
  const trackedSet = new Set(tracked),
    untrackedSet = new Set(untracked),
    approvedSet = new Set(approved);
  for (const path of approved)
    if (!untrackedSet.has(path) && !trackedSet.has(path))
      throw new Error(`Approved file is no longer available: ${path}`);
  const selected = options.selectedPaths
    ? new Set(options.selectedPaths)
    : null;
  if (
    selected &&
    [...selected].some((p) => !trackedSet.has(p) && !approvedSet.has(p))
  )
    throw new Error(
      "Selected file is unavailable or has not been approved for sharing.",
    );
  const files: Draft["artifact"]["files"] = [],
    excluded: Draft["excluded"] = [];
  let size = 0;
  const deletedSet = new Set(deletedPaths);
  for (const path of [...new Set([...tracked, ...approved])].sort()) {
    if (deletedSet.has(path)) continue;
    if (selected && !selected.has(path)) {
      excluded.push({ path, reason: "not selected" });
      continue;
    }
    if (!safePath(path)) {
      excluded.push({ path, reason: "protected path" });
      continue;
    }
    const full = resolve(root, path);
    try {
      if ((await lstat(full)).isSymbolicLink()) {
        excluded.push({ path, reason: "symbolic link" });
        continue;
      }
      const actual = await realpath(full),
        rel = relative(root, actual);
      if (rel.startsWith("..") || isAbsolute(rel)) {
        excluded.push({ path, reason: "outside project" });
        continue;
      }
      const file = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
      let data: Buffer;
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > 200000) {
          excluded.push({ path, reason: "not a small text file" });
          continue;
        }
        data = await file.readFile();
      } finally {
        await file.close();
      }
      if (!isUtf8(data!) || data!.includes(0)) {
        excluded.push({ path, reason: "binary file" });
        continue;
      }
      const content = data!.toString("utf8");
      if (containsSecret(content)) {
        excluded.push({ path, reason: "possible secret" });
        continue;
      }
      if (files.length >= 100 || size + data!.length > 1_000_000) {
        excluded.push({ path, reason: "development package size limit" });
        continue;
      }
      size += data!.length;
      files.push({
        path,
        content,
        sha256: digest(content),
        source: tracked.includes(path) ? "tracked" : "untracked-approved",
      });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        excluded.push({ path, reason: "deleted file" });
        continue;
      }
      throw e;
    }
  }
  const baseCommit = (await git(root, ["rev-parse", "HEAD"])).trim();
  const entries = files
    .map(({ path, sha256, source }) => ({ path, sha256, source }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const manifestHash = digest(
    canonical(
      deletedPaths.length
        ? { files: entries, deletedPaths: [...deletedPaths].sort() }
        : entries,
    ),
  );
  const changed =
    !old ||
    old.artifact.manifestHash !== manifestHash ||
    old.summary !== summary ||
    old.baseCommit !== baseCommit;
  if (!changed && options.fallbackEnabled === undefined) return old!;
  const draft: Draft = {
    version: 1,
    root,
    baseCommit,
    summary,
    updatedAt: now.toISOString(),
    lastSummaryAt: options.summary
      ? now.toISOString()
      : (old?.lastSummaryAt ?? null),
    fallbackEnabled: options.fallbackEnabled ?? old?.fallbackEnabled ?? false,
    artifact: artifactSchema.parse({
      baseCommit,
      summary,
      files,
      deletedPaths,
      manifestHash,
    }),
    excluded,
    approvedUntracked: approved,
  };
  await atomicJson(draftPath(root), draft);
  return draft;
}
export function canRequestSummary(
  draft: Draft,
  changed: boolean,
  now = new Date(),
): boolean {
  return (
    changed &&
    (!draft.lastSummaryAt ||
      now.getTime() - Date.parse(draft.lastSummaryAt) >= 600000)
  );
}
export async function listUntracked(path: string) {
  const root = await projectRoot(path);
  return (await git(root, ["ls-files", "--others", "--exclude-standard", "-z"]))
    .split("\0")
    .filter(Boolean);
}
