// Builds the request branch commit for layout "tree": the requester's whole working
// state (HEAD tree + uncommitted changes + every untracked file, .gitignore honoured)
// minus protected paths, secret files, deleted files, symlinks, nested repositories
// and LFS pointers, with request.md/request.json at the root. A new file travels
// whatever it is called, wherever it sits and however big it is (up to GitHub's own
// limit): the worker gets the project as the requester has it. Everything happens in
// a temporary index and object directory under the request directory, so the source
// repository's index, HEAD, worktree, objects and refs stay byte-identical.
import { spawn } from "node:child_process";
import { open, lstat, mkdir, writeFile, access } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { isUtf8 } from "node:buffer";
import { z } from "zod";
import {
  protectedPathReason,
  secretReasonsInBytes,
} from "../../../packages/contracts/src/files.js";
import {
  binaryFormat,
  groupHitsByPath,
  namedHits,
  partitionHits,
  scanCommit,
  type CommitScan,
  type SecretAcceptance,
  type SecretHit,
} from "./secret-gate.js";

// GitHub rejects blobs over 100 MB; a whole tree over 1 GB is not a request.
export const GITHUB_FILE_LIMIT = 100 * 1024 * 1024;
export const TREE_BYTE_LIMIT = 1024 * 1024 * 1024;
// A new file the requester was shown and did not include (the manual `tig request
// prepare --include` path). Their answer decides alone: no rule may put it back,
// and the publish step checks the tree for it.
export const REFUSED_REASON = "you chose not to share this new file";
// How much of a working-tree file the COLLECTION scan reads. This scan is not
// the guarantee any more — the gate (secret-gate.ts) reads the bytes of the
// commit itself before the push, and this one only decides what the review
// screen may say about a file it left out, which is why it can stop at a size
// that costs ~85 ms to read, decode and match (~15 ms for 1 MB). A file past it
// still reaches the gate, so nothing goes out on the strength of this limit.
export const SECRET_SCAN_LIMIT = 10 * 1024 * 1024;
// A file too large to scan still has its first bytes read, so "binary" on the
// review screen stays a fact about the file rather than a guess from its size.
const BINARY_SNIFF_BYTES = 8192;
// The platform null device; Windows has no /dev/null (worker-agent.ts, work.ts).
export const NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";
// `excluded` is the stored list; `notable` is the room kept inside it for the
// exclusions a requester can act on. A real checkout can hold thousands of
// protected paths (node_modules/, .venv/) in alphabetical order, so without a
// reserved slot the one tracked source file that stayed behind (secret, LFS,
// symlink, unreadable, nested repository, over GitHub's limit) falls off the list
// while the counts still add up, and the requester cannot find out why their
// edit did not travel.
const LIST_CAP = {
  changed: 2000,
  excluded: 500,
  notable: 200,
  dirs: 50,
  ignored: 200,
};

export class RequestTreeError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export const changeKind = z.enum(["modified", "added", "untracked", "deleted"]);
export const treeSummarySchema = z
  .object({
    fileCount: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
    binaryCount: z.number().int().nonnegative(),
    changed: z.object({
      modified: z.number().int().nonnegative(),
      added: z.number().int().nonnegative(),
      untracked: z.number().int().nonnegative(),
      deleted: z.number().int().nonnegative(),
    }),
    // Capped lists; the counts above are complete.
    changedSinceHead: z.array(z.object({ path: z.string(), kind: changeKind })),
    untrackedDirs: z.array(
      z.object({
        dir: z.string(),
        count: z.number().int().nonnegative(),
        bytes: z.number().int().nonnegative(),
      }),
    ),
    trackedIgnored: z.array(z.string()),
    trackedIgnoredCount: z.number().int().nonnegative(),
    // Untracked paths left out for not being in git. Every new file travels
    // now, so a fresh summary carries 0 and []; the fields stay so a request
    // prepared under the earlier new-file rule still renders.
    skippedDirs: z.array(
      z.object({
        dir: z.string(),
        count: z.number().int().nonnegative(),
        reason: z.string(),
      }),
    ),
    skippedCount: z.number().int().nonnegative(),
    // The earlier rule's per-reason split; no longer produced.
    skippedData: z.number().int().nonnegative().optional(),
    skippedFolder: z.number().int().nonnegative().optional(),
    skippedLarge: z.number().int().nonnegative().optional(),
    skippedBudget: z.number().int().nonnegative().optional(),
    // Untracked paths the protected-path rule keeps out (.env, *.log, keys,
    // node_modules, .venv…). `git add` does not change their fate, so they are
    // never counted as "not in git".
    protectedCount: z.number().int().nonnegative().optional(),
    protectedDirs: z
      .array(
        z.object({
          dir: z.string(),
          count: z.number().int().nonnegative(),
          reason: z.string(),
        }),
      )
      .optional(),
    // What the gate could not examine in the commit it is about to publish: a
    // blob whose first bytes are a known binary container (its payload is
    // compressed or entropy-coded, so ASCII does not survive as ASCII in it).
    // These three come from the gate's own report, so the number on the review
    // screen is the number of blobs the gate really stopped short of — never a
    // count the collection scan guessed. Everything else in the commit was read
    // byte for byte.
    unscannedCount: z.number().int().nonnegative().optional(),
    unscannedBytes: z.number().int().nonnegative().optional(),
    unscannedPaths: z
      .array(
        z.object({
          path: z.string(),
          reason: z.string(),
          bytes: z.number().int().nonnegative(),
        }),
      )
      .optional(),
    // Files git tracks that still did not travel (protected, secret-bearing,
    // LFS, symlink, nested repository, unreadable, deleted, over GitHub's
    // limit). Named, because "git add it" cannot fix any of these and the
    // requester would otherwise look for an edited file that is not there.
    trackedExcluded: z
      .array(z.object({ path: z.string(), reason: z.string() }))
      .optional(),
    trackedExcludedCount: z.number().int().nonnegative().optional(),
    // New files the requester answered "no" to (or did not select). Their own
    // decision, so it is reported as such and never folded into a rule.
    refusedPaths: z.array(z.string()).optional(),
    refusedCount: z.number().int().nonnegative().optional(),
    // Files whose bytes match a credential pattern. They are NOT in the commit:
    // the default answer to a hit is that the file does not travel, so a
    // requester who reads nothing publishes no credential. Each entry carries
    // the classes that matched, never the text — that pair is what the requester
    // reads on the review screen and what they name to put a file back.
    secretHeld: z
      .array(z.object({ path: z.string(), reasons: z.array(z.string()) }))
      .optional(),
    secretHeldCount: z.number().int().nonnegative().optional(),
    // Files that DO travel although they match, because the requester named them
    // and the classes below are the ones they were shown. This list is the
    // reviewed record: the gate in front of the push honours exactly it and
    // refuses everything else (requester.ts verifyLocalSnapshot), so what the
    // screen said and what the branch carries cannot drift apart.
    secretPublished: z
      .array(z.object({ path: z.string(), reasons: z.array(z.string()) }))
      .optional(),
    secretPublishedCount: z.number().int().nonnegative().optional(),
    excludedCount: z.number().int().nonnegative(),
  })
  .strict();
export type TreeSummary = z.infer<typeof treeSummarySchema>;
export interface Excluded {
  path: string;
  reason: string;
}
export interface Documents {
  path: string;
  content: string;
}
export interface BuiltTree {
  commit: string;
  pushDir: string;
  tree: TreeSummary;
  excluded: Excluded[];
  // The new files the requester did not include; none of them is in `commit`.
  refusedPaths: string[];
}

async function run(
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; input?: Buffer | string },
): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    let errText = "";
    child.stdout.on("data", (b: Buffer) => out.push(b));
    child.stderr.on("data", (b: Buffer) => {
      errText += b.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise(Buffer.concat(out));
      else
        reject(
          new Error(
            `git ${args[0]} failed (${code}): ${errText.trim().slice(0, 400)}`,
          ),
        );
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}
const nul = (buffer: Buffer) =>
  buffer.toString("utf8").split("\0").filter(Boolean);
async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
// Parses https://github.com/O/R(.git), git@github.com:O/R(.git), ssh://git@github.com/O/R.
export function parseGithubRemote(url: string): string | null {
  const m = url
    .trim()
    .match(
      /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|(?:ssh:\/\/)?git@github\.com[:/])([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i,
    );
  return m ? `${m[1]}/${m[2]}` : null;
}
export interface GitContext {
  root: string;
  gitDir: string;
  objects: string;
  // Read-only queries against the source index and config.
  read: NodeJS.ProcessEnv;
}
export async function gitContext(root: string): Promise<GitContext> {
  const base = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
  };
  const gitDir = (
    await run(["rev-parse", "--absolute-git-dir"], { cwd: root, env: base })
  )
    .toString("utf8")
    .trim();
  const objects = (
    await run(
      ["rev-parse", "--path-format=absolute", "--git-path", "objects"],
      {
        cwd: root,
        env: base,
      },
    )
  )
    .toString("utf8")
    .trim();
  return {
    root,
    gitDir,
    objects,
    read: { ...base, GIT_DIR: gitDir, GIT_WORK_TREE: root },
  };
}
// Refuses states whose worktree cannot be published as one plain tree.
export async function preflight(ctx: GitContext) {
  for (const marker of [
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "rebase-merge",
    "rebase-apply",
  ])
    if (await exists(join(ctx.gitDir, marker)))
      throw new RequestTreeError(
        "MERGE_IN_PROGRESS",
        "A merge, rebase, cherry-pick or revert is in progress. Finish or abort it, then run tig again.",
      );
  const unmerged = await run(["ls-files", "-u", "-z"], {
    cwd: ctx.root,
    env: ctx.read,
  });
  if (unmerged.length)
    throw new RequestTreeError(
      "MERGE_IN_PROGRESS",
      "The project has unmerged paths. Resolve the conflicts, then run tig again.",
    );
  const config = async (args: string[]) =>
    (
      await run(["config", ...args], { cwd: ctx.root, env: ctx.read }).catch(
        () => Buffer.alloc(0),
      )
    )
      .toString("utf8")
      .trim();
  if (
    (await config(["--get", "--type=bool", "core.sparseCheckout"])) === "true"
  )
    throw new RequestTreeError(
      "SPARSE_CHECKOUT_UNSUPPORTED",
      "Sparse checkouts cannot be published as a request tree. Use a full checkout.",
    );
  const tags = await run(["ls-files", "-t", "-z"], {
    cwd: ctx.root,
    env: ctx.read,
  });
  if (nul(tags).some((line) => line.startsWith("S ")))
    throw new RequestTreeError(
      "SPARSE_CHECKOUT_UNSUPPORTED",
      "Some files are marked skip-worktree. Use a full checkout to publish a request tree.",
    );
  if (
    (await config(["--get", "extensions.partialClone"])) ||
    (await config(["--get-regexp", "^remote\\..*\\.promisor$"]))
  )
    throw new RequestTreeError(
      "PARTIAL_CLONE_UNSUPPORTED",
      "Partial clones cannot be published as a request tree (file contents may be missing locally).",
    );
}
interface Candidate {
  path: string;
  size: number;
  untracked: boolean;
  binary: boolean;
  // False when the collection scan did not read the bytes (over
  // SECRET_SCAN_LIMIT, or a known binary container). Bookkeeping for why a file
  // was not left out here; what the request discloses as unexamined comes from
  // the gate's report on the commit, not from this flag.
  scanned: boolean;
}
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]);
      }
    }),
  );
  return results;
}
type FileKind = "text" | "binary" | "unreadable" | "symlink" | "deleted";
// A file the requester cannot open — a root-owned build artefact from a sudo or
// docker run, a 0600 key — is one path out of thousands, so it leaves the
// request with a reason the way a deleted file does, never by aborting the run.
// Anything else (EMFILE, EIO) is a real fault and still throws.
function readFailure(e: unknown): FileKind {
  const code = (e as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return "deleted";
  // Raced into a symlink between lstat and open; O_NOFOLLOW did its job.
  if (code === "ELOOP") return "symlink";
  if (code === "EACCES" || code === "EPERM") return "unreadable";
  throw e;
}
// Blobs up to SECRET_SCAN_LIMIT are read through O_NOFOLLOW and matched as
// BYTES, by the same rules the gate applies to the commit: no UTF-8 decode is
// required (every pattern is ASCII), so a CP949 or UTF-16 source file is scanned
// like any other text instead of being filed as "binary, nothing to see". The
// only file this scan skips is one whose first bytes are a known binary
// container, which is exactly what the gate skips — so a file the review screen
// leaves out as "secret" is a file the gate would refuse, and a file the screen
// keeps is one the gate will read.
//
// Whatever this scan does not read still reaches the gate before the push;
// `scanned` only records what happened here. It names the classes it matched and
// leaves the decision to the caller: which file travels is policy, and policy
// belongs where the requester's own answer is known.
async function classify(
  full: string,
  size: number,
): Promise<{ kind: FileKind; scanned: boolean; reasons?: string[] }> {
  let file;
  try {
    file = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e) {
    return { kind: readFailure(e), scanned: false };
  }
  try {
    if (size > SECRET_SCAN_LIMIT) {
      const head = Buffer.alloc(BINARY_SNIFF_BYTES);
      const { bytesRead } = await file.read(head, 0, BINARY_SNIFF_BYTES, 0);
      return {
        kind: head.subarray(0, bytesRead).includes(0) ? "binary" : "text",
        scanned: false,
      };
    }
    const data = await file.readFile();
    if (binaryFormat(data)) return { kind: "binary", scanned: false };
    const reasons = secretReasonsInBytes(data);
    return {
      kind: isUtf8(data) && !data.includes(0) ? "text" : "binary",
      scanned: true,
      ...(reasons.length ? { reasons } : {}),
    };
  } catch (e) {
    return { kind: readFailure(e), scanned: false };
  } finally {
    await file.close();
  }
}
// What the requester answered about new (untracked) files. `undefined` is "the
// question was never asked" — the automatic flow never asks it — and the
// new-file rule decides alone. A list is the requester's own answer: exactly
// those untracked paths may travel, and an empty list means none of them may.
// Only an explicit answer narrows the request; nothing here widens it.
export interface Selection {
  untracked?: string[];
  // Files the requester named on the review screen after reading the classes
  // that matched in them, with those classes. A file whose path is here travels
  // only while the classes it matches are the ones named: a class that appeared
  // since the screen was read is a finding nobody has answered for, and the file
  // goes back to being held. Naming a file is the only way to widen what
  // travels, and it widens it by exactly one file.
  publishSecret?: SecretAcceptance[];
}
export interface Collected {
  include: Candidate[];
  excluded: Excluded[];
  // Files kept out of the commit because they match a credential pattern: the
  // path and the classes, never the bytes. What travels and still matches is not
  // answered here — the gate answers it, over the commit (buildRequestTree).
  heldForSecret: SecretAcceptance[];
  // Every untracked path left out because the requester did not include it.
  refusedPaths: string[];
  tree: TreeSummary;
  // Tracked paths whose published bytes have to come from the working tree:
  // exactly what `git status` reports as different from HEAD or from the index.
  // Everything else keeps HEAD's own blob, so the tree the requester approves
  // ("N changed") and the tree that is published can never disagree.
  changedPaths: Set<string>;
}
// The include list: every tracked and untracked (not ignored) regular file that is
// not deleted, protected, secret-bearing, LFS-managed or over GitHub's limit. No
// rule about a new file's name, folder or size: the worker gets the whole tree.
export async function collect(
  ctx: GitContext,
  documentPaths: string[],
  selection: Selection = {},
): Promise<Collected> {
  const ls = async (args: string[]) =>
    nul(
      await run(["ls-files", "-z", ...args], { cwd: ctx.root, env: ctx.read }),
    );
  const tracked = await ls(["--cached"]);
  const untracked = await ls(["--others", "--exclude-standard"]);
  const deleted = new Set(await ls(["--deleted"]));
  const trackedIgnored = await ls([
    "--cached",
    "--ignored",
    "--exclude-standard",
  ]);
  const untrackedSet = new Set(untracked);
  const candidates = [...new Set([...tracked, ...untracked])].sort();
  const conflict = candidates.find((p) => documentPaths.includes(p));
  if (conflict)
    throw new RequestTreeError(
      "REQUEST_DOC_CONFLICT",
      `The project already has ${conflict} at its root; the request documents need that name. Move or rename it, then run tig again.`,
    );
  // LFS-managed paths would be published as pointers or raw large blobs.
  const lfs = new Set<string>();
  if (candidates.length) {
    const attrs = nul(
      await run(["check-attr", "--stdin", "-z", "filter"], {
        cwd: ctx.root,
        env: ctx.read,
        input: candidates.join("\0") + "\0",
      }),
    );
    for (let i = 0; i + 2 < attrs.length; i += 3)
      if (attrs[i + 2] === "lfs") lfs.add(attrs[i]);
  }
  const include: Candidate[] = [];
  // Three lists merged back into one capped `excluded`: what the requester can
  // act on (a tracked file, a new file they refused, anything reading the file
  // decided) keeps its own reserved room, so the bulk protected paths — which
  // arrive alphabetically and in the thousands — can never push it off the
  // stored list. The merge restores the order the paths were found in, so the
  // list reads the same as before whenever nothing had to be dropped.
  type Recorded = Excluded & { seq: number };
  const trackedOut: Recorded[] = [];
  const chosenOut: Recorded[] = [];
  const bulkOut: Recorded[] = [];
  let seq = 0;
  let trackedExcludedCount = 0;
  const record = (path: string, reason: string, bulk: boolean) => {
    const row = { path, reason, seq: seq++ };
    if (!untrackedSet.has(path)) {
      trackedExcludedCount++;
      if (trackedOut.length < LIST_CAP.notable) trackedOut.push(row);
    } else if (bulk) {
      if (bulkOut.length < LIST_CAP.excluded) bulkOut.push(row);
    } else if (chosenOut.length < LIST_CAP.notable) chosenOut.push(row);
  };
  // undefined = never asked; a list = the requester's own answer.
  const allowed = selection.untracked ? new Set(selection.untracked) : null;
  const named = new Map(
    (selection.publishSecret ?? []).map((a) => [a.path, new Set(a.reasons)]),
  );
  const heldForSecret: SecretAcceptance[] = [];
  const refusedPaths: string[] = [];
  let binaryCount = 0;
  const protectedDirs = new Map<string, { count: number; reason: string }>();
  // Group a left-out untracked path under its top-level folder. The group keeps
  // the first reason seen in it; every path keeps its exact reason in `excluded`.
  const group = (
    dirs: Map<string, { count: number; reason: string }>,
    path: string,
    reason: string,
  ) => {
    const slash = path.indexOf("/");
    const dir = slash < 0 ? "(root)" : path.slice(0, slash + 1);
    const entry = dirs.get(dir) ?? { count: 0, reason };
    entry.count++;
    dirs.set(dir, entry);
  };
  // A protected untracked path is counted apart (git add would not help), and
  // pathExcluded is every path-level exclusion, a tracked .env or CI workflow
  // included.
  let protectedCount = 0;
  let pathExcluded = 0;
  const survivors: string[] = [];
  for (const path of candidates) {
    const guarded = protectedPathReason(path);
    const untracked = untrackedSet.has(path);
    // A tracked file is never dropped by a selection: the request is the whole
    // working state, and the question the requester answered was about new
    // files only.
    const refused = untracked && !!allowed && !allowed.has(path);
    const reason = guarded ?? (refused ? REFUSED_REASON : null);
    if (!reason) {
      survivors.push(path);
      continue;
    }
    pathExcluded++;
    record(path, reason, !refused || !!guarded);
    if (!untracked) continue;
    if (guarded) {
      protectedCount++;
      group(protectedDirs, path, reason);
      // A protected path stays out whatever the requester answered, so it is
      // reported by its own rule rather than counted as their decision.
      continue;
    }
    if (refused) refusedPaths.push(path);
  }
  type Row = (Excluded & { reasons?: string[] }) | Candidate;
  const rows = await mapLimit(survivors, 16, async (path): Promise<Row> => {
    if (deleted.has(path)) return { path, reason: "deleted" };
    const full = resolve(ctx.root, path);
    let stat;
    try {
      stat = await lstat(full);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT")
        return { path, reason: "deleted" };
      throw e;
    }
    if (stat.isSymbolicLink()) return { path, reason: "symlink" };
    if (stat.isDirectory()) return { path, reason: "nested-repository" };
    if (!stat.isFile()) return { path, reason: "not a regular file" };
    if (lfs.has(path)) return { path, reason: "git-lfs" };
    if (stat.size > GITHUB_FILE_LIMIT)
      return { path, reason: "too-large-for-github" };
    const { kind, scanned, reasons } = await classify(full, stat.size);
    // The file could not be read after all (permissions, a raced symlink or a
    // deletion): one path leaves the request, the other thousands still travel.
    if (kind === "unreadable") return { path, reason: "unreadable" };
    if (kind === "symlink" || kind === "deleted") return { path, reason: kind };
    // A match holds the file out of the branch unless the requester has named
    // that path with these exact classes. Held is the default because it is the
    // only answer that cannot leak: a push is public the moment it lands and the
    // remedy is rotating whatever was in it, so the cost of not reading the
    // screen has to be a weaker handoff, never a disclosed credential.
    if (reasons && !reasons.every((r) => named.get(path)?.has(r) === true))
      return { path, reason: "secret", reasons };
    return {
      path,
      size: stat.size,
      untracked: untrackedSet.has(path),
      binary: kind === "binary",
      scanned,
    };
  });
  let bytes = 0;
  let rowsExcluded = 0;
  for (const row of rows) {
    if ("reason" in row) {
      rowsExcluded++;
      if (row.reasons)
        heldForSecret.push({ path: row.path, reasons: row.reasons });
      // Every exclusion decided by reading the file (secret, unreadable,
      // symlink, LFS, nested repository, over GitHub's limit) is a per-file
      // finding the requester can act on, tracked or not: it is never bulk.
      record(row.path, row.reason, false);
      continue;
    }
    if (row.binary) binaryCount++;
    bytes += row.size;
    include.push(row);
  }
  if (bytes > TREE_BYTE_LIMIT)
    throw new RequestTreeError(
      "TREE_TOO_LARGE",
      `The project's files come to ${Math.round(bytes / 1024 / 1024)} MB; requests are limited to 1 GB. Move build output, data and caches out of the tree or into .gitignore, then run tig again.`,
    );
  // Tracked changes from git status against the source index; untracked from ls-files.
  const status = nul(
    await run(
      [
        "--no-optional-locks",
        "status",
        "--porcelain=v1",
        "-z",
        "--no-renames",
        "--untracked-files=no",
      ],
      { cwd: ctx.root, env: ctx.read },
    ),
  );
  const changedSinceHead: TreeSummary["changedSinceHead"] = [];
  const changed = { modified: 0, added: 0, untracked: 0, deleted: 0 };
  // Uncapped, unlike changedSinceHead: the index build reads this to decide which
  // blobs it may take from HEAD unchanged, so a missing path would publish stale
  // bytes. Both the count on the screen and the published tree come from here.
  const changedPaths = new Set<string>();
  for (const line of status) {
    const x = line[0],
      y = line[1],
      path = line.slice(3);
    const kind =
      x === "D" || y === "D" ? "deleted" : x === "A" ? "added" : "modified";
    changed[kind]++;
    changedPaths.add(path);
    changedSinceHead.push({ path, kind });
  }
  const dirs = new Map<string, { count: number; bytes: number }>();
  for (const f of include)
    if (f.untracked) {
      changed.untracked++;
      changedSinceHead.push({ path: f.path, kind: "untracked" });
      const slash = f.path.indexOf("/");
      const dir = slash < 0 ? "(root)" : f.path.slice(0, slash + 1);
      const entry = dirs.get(dir) ?? { count: 0, bytes: 0 };
      entry.count++;
      entry.bytes += f.size;
      dirs.set(dir, entry);
    }
  const byCount = (dirs: Map<string, { count: number; reason: string }>) =>
    [...dirs]
      .map(([dir, v]) => ({ dir, ...v }))
      .sort((a, b) => b.count - a.count || a.dir.localeCompare(b.dir))
      .slice(0, LIST_CAP.dirs);
  // The cap falls on the bulk skips alone; everything else keeps its place.
  const reserved = [...trackedOut, ...chosenOut];
  const excluded = [
    ...reserved,
    ...bulkOut.slice(0, Math.max(0, LIST_CAP.excluded - reserved.length)),
  ]
    .sort((a, b) => a.seq - b.seq)
    .map(({ path, reason }) => ({ path, reason }));
  return {
    include,
    excluded,
    heldForSecret,
    refusedPaths,
    changedPaths,
    tree: treeSummarySchema.parse({
      fileCount: include.length + documentPaths.length,
      bytes,
      binaryCount,
      changed,
      changedSinceHead: changedSinceHead.slice(0, LIST_CAP.changed),
      untrackedDirs: [...dirs]
        .map(([dir, v]) => ({ dir, ...v }))
        .sort((a, b) => b.count - a.count || a.dir.localeCompare(b.dir))
        .slice(0, LIST_CAP.dirs),
      trackedIgnored: trackedIgnored.slice(0, LIST_CAP.ignored),
      trackedIgnoredCount: trackedIgnored.length,
      // Every new file travels: nothing is left out for not being in git.
      skippedDirs: [],
      skippedCount: 0,
      protectedCount,
      protectedDirs: byCount(protectedDirs),
      // unscannedCount / unscannedBytes / unscannedPaths and the two secret
      // lists are not collect()'s to fill: they are what the gate reports about
      // the commit, and the commit does not exist yet (buildRequestTree adds
      // them, from heldForSecret / publishedSecret above plus its own findings).
      trackedExcluded: trackedOut
        .slice(0, LIST_CAP.dirs)
        .map(({ path, reason }) => ({ path, reason })),
      trackedExcludedCount,
      refusedPaths: refusedPaths.slice(0, LIST_CAP.dirs),
      refusedCount: refusedPaths.length,
      excludedCount: pathExcluded + rowsExcluded,
    }),
  };
}
// ONE gate in front of the request branch. Both sides of the requester flow call
// this and nothing else: the build (so the review screen states what the gate
// could not examine, and so a hit is refused before the requester is asked to
// approve anything) and the publish step (so nothing can be pushed without
// passing). It reads the commit's own blobs — not the working tree, not the
// collection scan's decoded copy — which is why `git update-index
// --assume-unchanged` cannot hide bytes from it any more.
//
// The two request documents are skipped by path: tig writes them itself from the
// envelope, their bytes are checked with containsSecret when they are written,
// and the publish step verifies the published blobs are those exact bytes
// (verifyRequestTree in requester.ts). Nothing else is skipped by name.
export const LIST_CAP_UNSCANNED = 50;
export async function scanRequestCommit(o: {
  gitDir: string;
  commit: string;
  documentPaths: string[];
}): Promise<CommitScan> {
  // The gate only reads objects out of the repository it is given: the user's
  // global config, their hooks and any insteadOf rule of theirs have no business
  // in it, and neither has a GIT_DIR/GIT_OBJECT_DIRECTORY left in the shell that
  // would point these reads at another store.
  const {
    GIT_DIR: _dir,
    GIT_WORK_TREE: _tree,
    GIT_INDEX_FILE: _index,
    GIT_OBJECT_DIRECTORY: _objects,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: _alternates,
    ...env
  } = process.env;
  return scanCommit({
    gitDir: o.gitDir,
    commit: o.commit,
    env: {
      ...env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_GLOBAL: NULL_DEVICE,
      GIT_CONFIG_NOSYSTEM: "1",
    },
    skip: o.documentPaths,
  });
}
// What the requester is told when the bytes that would be published carry a
// secret AFTER the file was supposed to have been held out of the commit. It
// names the file and the class of pattern (never the secret itself), says
// plainly that nothing left the machine, and gives the one way forward.
//
// This is the narrow case now, not the ordinary one: an ordinary hit holds its
// file back and the run continues. Reaching here means the gate found, in the
// commit, a hit at a path the requester never named — the two reads disagreed
// (`git update-index --assume-unchanged`), or it turned up after the review
// screen was built. A publish cannot proceed on a finding nobody has read.
export function secretGateRefusal(hits: SecretHit[]): string {
  // Grouped by file first: the count and the "that file / those files" below are
  // about files, and one file matching three patterns is still one file to fix.
  const { files, named, more } = namedHits(hits);
  const rest = more ? `, and ${more} more` : "";
  const one = files === 1;
  return `This request would publish what looks like a secret: ${named.join(", ")}${rest}. Nothing was pushed; the request branch was not created and your project is untouched. Remove the secret from ${one ? "that file" : "those files"} (or stop tracking ${one ? "it" : "them"}), then run tig again. The scan reads the bytes the push would send, so a file git calls unmodified is read as git stored it.`;
}
export async function buildRequestTree(options: {
  root: string;
  directory: string;
  id: string;
  documents: Documents[];
  author: { name: string; email: string };
  // The requester's answer about new files; absent when they were never asked.
  selection?: Selection;
  // The branch the commit is pushed as: main for a request's own repository
  // (the default), tig/requests/<id> for a branch in a shared one.
  branch?: string;
}): Promise<BuiltTree> {
  const ctx = await gitContext(options.root);
  await preflight(ctx);
  const documentPaths = options.documents.map((d) => d.path);
  const collected = await collect(ctx, documentPaths, options.selection ?? {});
  const objects = join(options.directory, "objects");
  await mkdir(objects, { recursive: true, mode: 0o700 });
  // Temporary index + object directory; the source objects are read through the
  // alternate. Global and system config stay out of these local-only operations
  // (a global hooksPath, a signing key, an insteadOf rule have no business
  // here); the source repository's own config and .gitattributes still apply.
  // Dropping them cannot change an unmodified tracked file any more: those keep
  // HEAD's blob instead of being re-hashed (see the index build below).
  const env: NodeJS.ProcessEnv = {
    ...ctx.read,
    GIT_INDEX_FILE: join(options.directory, "index"),
    GIT_OBJECT_DIRECTORY: objects,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: ctx.objects,
    GIT_CONFIG_GLOBAL: NULL_DEVICE,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: options.author.name,
    GIT_AUTHOR_EMAIL: options.author.email,
    GIT_COMMITTER_NAME: options.author.name,
    GIT_COMMITTER_EMAIL: options.author.email,
  };
  const common = [
    "-c",
    `core.hooksPath=${join(options.directory, "no-hooks")}`,
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.safecrlf=false",
    "-c",
    "core.splitIndex=false",
    "-c",
    "core.untrackedCache=false",
    "-c",
    "commit.gpgsign=false",
  ];
  const g = (args: string[], input?: Buffer | string) =>
    run([...common, ...args], { cwd: ctx.root, env, input });
  const list = (paths: string[]) => paths.join("\0") + "\0";
  // Everything between read-tree and commit-tree is git talking to a temporary
  // index. When it fails it is a state this build does not support, and the
  // requester gets the same kind of sentence as MERGE_IN_PROGRESS rather than
  // git's own words about --add options.
  const buildCommit = async () => {
    try {
      // A repository whose first commit is still to come has no HEAD to read.
      const born = await g(["rev-parse", "--verify", "--quiet", "HEAD"]).then(
        () => true,
        () => false,
      );
      await g(born ? ["read-tree", "HEAD"] : ["read-tree", "--empty"]);
      const headPaths = born
        ? nul(await g(["ls-tree", "-r", "-z", "--name-only", "HEAD"]))
        : [];
      const headSet = new Set(headPaths);
      const includeSet = new Set(collected.include.map((f) => f.path));
      // Remove first. A path that is a file in HEAD and a directory in the
      // working tree (or the reverse) is rejected by --add with "appears as
      // both a file and as a directory" while HEAD's entry is still in the
      // index, and that rejection used to end the whole run.
      const remove = headPaths.filter((p) => !includeSet.has(p));
      if (remove.length)
        await g(
          ["update-index", "--force-remove", "-z", "--stdin"],
          list(remove),
        );
      // Only what cannot come from HEAD is hashed out of the working tree: new
      // files and whatever git status reports as different. An unmodified
      // tracked file keeps HEAD's own blob, so it is byte-identical by
      // construction — no filter (core.autocrlf, living in the global or system
      // config this build deliberately drops) can rewrite it behind the review
      // screen's back, and a big repository is not re-hashed to say nothing
      // changed.
      const add = [...includeSet].filter(
        (p) => !headSet.has(p) || collected.changedPaths.has(p),
      );
      // Paths are fed literally on stdin: no pathspec globbing (pages/[id].tsx).
      if (add.length)
        await g(["update-index", "--add", "-z", "--stdin"], list(add));
      for (const doc of options.documents) {
        const sha = (await g(["hash-object", "-w", "--stdin"], doc.content))
          .toString("utf8")
          .trim();
        await g([
          "update-index",
          "--add",
          "--cacheinfo",
          `100644,${sha},${doc.path}`,
        ]);
      }
      const tree = (await g(["write-tree"])).toString("utf8").trim();
      // No parent: the requester's history never leaves the machine (P-022 scope).
      return (
        await g([
          "commit-tree",
          tree,
          "-m",
          `Tokenisgold request ${options.id}`,
        ])
      )
        .toString("utf8")
        .trim();
    } catch (e) {
      if (e instanceof RequestTreeError) throw e;
      throw new RequestTreeError(
        "INDEX_BUILD_FAILED",
        `The working tree could not be assembled into a request commit: ${(e as Error).message}. Nothing was published and the project is untouched — if files were being written while tig read them, let that finish and run tig again.`,
      );
    }
  };
  // The same temporary index, minus a few paths: the index still holds the full
  // tree after buildCommit, so a second pass costs one write-tree instead of
  // hashing the working tree again.
  const rebuildWithout = async (paths: string[]) => {
    try {
      await g(["update-index", "--force-remove", "-z", "--stdin"], list(paths));
      const tree = (await g(["write-tree"])).toString("utf8").trim();
      return (
        await g([
          "commit-tree",
          tree,
          "-m",
          `Tokenisgold request ${options.id}`,
        ])
      )
        .toString("utf8")
        .trim();
    } catch (e) {
      throw new RequestTreeError(
        "INDEX_BUILD_FAILED",
        `The request commit could not be rebuilt without the files the secret gate matched: ${(e as Error).message}. Nothing was published and the project is untouched.`,
      );
    }
  };
  let commit = await buildCommit();
  // The only ref lives in a bare push repository that reads both object stores.
  const pushDir = join(options.directory, "push.git");
  const plain = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  await run(["init", "--bare", "--quiet", "--template=", pushDir], {
    cwd: options.directory,
    env: plain,
  });
  await mkdir(join(pushDir, "objects", "info"), { recursive: true });
  await writeFile(
    join(pushDir, "objects", "info", "alternates"),
    `${objects}\n${ctx.objects}\n`,
    { mode: 0o600 },
  );
  // The gate, on the commit that was just built. Nothing has been pushed at this
  // point, so a hit costs the requester a file instead of a public branch — and
  // the same gate runs again immediately before the push, over the same commit,
  // because a check that only runs at build time is a check a later code path
  // can walk around.
  //
  // The collection scan above already held back every file it matched, so what
  // is left here is what only the gate can see: a path whose committed blob is
  // not the working-tree file it read (`git update-index --assume-unchanged`),
  // or a file too large for it to finish. Those are held back the same way —
  // removed from the commit, named on the review screen with their classes —
  // because "this file cannot travel" and "this publish cannot happen" are two
  // different sentences and only the first one is true here. The second pass is
  // then scanned again, and a hit that survives it is the refusal: the gate's
  // own answer about the bytes has stopped moving, and nothing is published on a
  // finding the requester was never shown.
  //
  // `named` is the requester's own answer and only that — never what the
  // collection scan matched, because a file it could not finish reading has no
  // classes to offer and the answer about that path still has to mean something.
  const named = options.selection?.publishSecret ?? [];
  const held = [...collected.heldForSecret];
  let scan = await scanRequestCommit({
    gitDir: pushDir,
    commit,
    documentPaths,
  });
  let split = partitionHits(scan.hits, named);
  let refused = split.refused;
  // Deltas for the summary: a file the second pass removes must leave the
  // headline too, or the screen counts a file the branch does not hold.
  const removed = { files: 0, bytes: 0, binary: 0, untracked: 0, tracked: 0 };
  const sizes = new Map(collected.include.map((f) => [f.path, f]));
  if (refused.length) {
    const drop = groupHitsByPath(refused);
    held.push(...drop);
    for (const { path } of drop) {
      if (collected.excluded.length < LIST_CAP.excluded)
        collected.excluded.push({ path, reason: "secret" });
      const file = sizes.get(path);
      if (!file) continue;
      removed.files++;
      removed.bytes += file.size;
      if (file.binary) removed.binary++;
      if (file.untracked) removed.untracked++;
      else removed.tracked++;
    }
    commit = await rebuildWithout(drop.map((d) => d.path));
    scan = await scanRequestCommit({ gitDir: pushDir, commit, documentPaths });
    split = partitionHits(scan.hits, named);
    refused = split.refused;
    if (refused.length)
      throw new RequestTreeError(
        "SECRET_IN_REQUEST_TREE",
        secretGateRefusal(refused),
      );
  }
  // What still matches in the commit that will be pushed, read from that
  // commit's own bytes: the review screen's "going public" line and the list the
  // publish step honours are the gate's answer, not a promise made earlier.
  const accepted = groupHitsByPath(split.accepted);
  const dropped = new Set(held.map((h) => h.path));
  await run(["update-ref", `refs/heads/${options.branch ?? "main"}`, commit], {
    cwd: pushDir,
    env: plain,
  });
  return {
    commit,
    pushDir,
    // The review screen's "not examined" line is the gate's own report about
    // these exact bytes: same commit, same rule, same number as the publish step
    // will apply (P-052).
    tree: treeSummarySchema.parse({
      ...collected.tree,
      fileCount: collected.tree.fileCount - removed.files,
      bytes: collected.tree.bytes - removed.bytes,
      binaryCount: collected.tree.binaryCount - removed.binary,
      changed: {
        ...collected.tree.changed,
        untracked: collected.tree.changed.untracked - removed.untracked,
      },
      changedSinceHead: collected.tree.changedSinceHead.filter(
        (c) => !dropped.has(c.path),
      ),
      trackedExcludedCount:
        (collected.tree.trackedExcludedCount ?? 0) + removed.tracked,
      excludedCount: collected.tree.excludedCount + removed.files,
      secretHeld: held.slice(0, LIST_CAP.excluded),
      secretHeldCount: held.length,
      secretPublished: accepted,
      secretPublishedCount: accepted.length,
      unscannedCount: scan.unexamined.length,
      unscannedBytes: scan.unexamined.reduce((n, b) => n + b.bytes, 0),
      unscannedPaths: scan.unexamined.slice(0, LIST_CAP_UNSCANNED),
    }),
    excluded: collected.excluded,
    refusedPaths: collected.refusedPaths,
  };
}
// Reads a published-or-not request commit from its push repository.
export async function treeEntries(pushDir: string, commit: string) {
  const rows = nul(
    await run(["ls-tree", "-r", "-z", commit], {
      cwd: pushDir,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    }),
  );
  return rows.map((row) => {
    const tab = row.indexOf("\t"),
      [mode = "", type = "", sha = ""] = row.slice(0, tab).split(" ");
    return { path: row.slice(tab + 1), mode, type, sha };
  });
}
export async function commitParents(pushDir: string, commit: string) {
  return (
    await run(["rev-list", "--parents", "-n", "1", commit], {
      cwd: pushDir,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    })
  )
    .toString("utf8")
    .trim()
    .split(" ")
    .slice(1)
    .filter(Boolean);
}
// True when a global url.<base>.insteadOf rule would rewrite the GitHub push URL;
// the push then runs with GIT_CONFIG_GLOBAL=/dev/null (system config is kept).
export async function globalRewritesGithub(target: string) {
  const out = await run(
    ["config", "--global", "--get-regexp", "^url\\..*\\.(push)?insteadof$"],
    { cwd: process.cwd(), env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
  ).catch(() => Buffer.alloc(0));
  return out
    .toString("utf8")
    .split("\n")
    .some((line) => {
      const space = line.indexOf(" ");
      const prefix = space < 0 ? "" : line.slice(space + 1).trim();
      return prefix.length > 0 && target.startsWith(prefix);
    });
}
