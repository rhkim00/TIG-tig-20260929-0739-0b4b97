// Everything between "the server told me where the result is" and "here is the
// diff, verified to sit on the request commit". Nothing in this file decides a
// settlement: it fetches what the submission points at, proves the commit it got
// is the commit that was submitted, and hands back facts for settle.ts's rules.
//
// Three things the rest of the settlement rests on.
//
// `git fetch` is the ONLY source of the code, never a fallback. When the changed
// files do not all fit the mirror (worker-agent mirrorFits) the platform artifact
// carries report.md and nothing else, so a validator that reads files from the
// API approves the largest results blind.
//
// The diff is read by readCommittedChanges — the very function the worker runs
// over the same commit immediately before pushing it. A second reader here would
// let the two sides disagree about the same bytes, and the requester's money
// rides on them agreeing. That is why the working directory is laid out as
// <dir>/git + <dir>/ws: it is the layout workspacePaths(trial) derives, so the
// worker's reader can be handed this directory unchanged.
//
// The input is hostile. The commit messages, the diff and the file contents were
// written by someone who is paid when the answer is "approve", so every git
// invocation names its own git dir, an empty core.hooksPath is written into the
// settlement repository's own config (this module's calls pass it on the command
// line as well, but the readers it lends the directory to do not, so the config
// is what makes the rule true), and the remote URL is assembled from the
// repository field rather than taken from it.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  readCommittedChanges,
  ResultSecretDetected,
  ResultUnscannedText,
  workspaceGit,
  workspacePaths,
  type ChangedFile,
} from "./worker-agent.js";
import type {
  EvidencePaths,
  MechanicalEvidence,
  ResultChanges,
  ResultGitCoordinates,
  ResultTreeEntry,
} from "./settle.js";

const exec = promisify(execFile);

// A stranger's repository over the network, and a pass that runs in front of
// whatever the requester actually typed: it may not hang there.
export const RESULT_FETCH_TIMEOUT_MS = 2 * 60000;
// §4's budget for the hunks the AI is shown. The per-file limit is the design's
// REVIEW_FILE_MAX; the total is a default the caller overrides with whatever is
// left of REVIEW_CONTEXT_LIMIT once the acceptance checks (which are never cut)
// have taken their share.
export const REVIEW_FILE_MAX = 20000;
export const REVIEW_DIFF_MAX = 140000;

// The same shapes packages/contracts/src/lifecycle.ts enforces on submission.
// Re-checked here rather than assumed: these strings become argv for git, and
// "the server validated it" is not a thing this machine can see.
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const RESULT_BRANCH = /^tig\/results\/[a-f0-9-]{36}$/;
const SHA = /^[a-f0-9]{40}$/;

// Production always assembles this. `repository` is the worker's field and may be
// their fork, so it is followed — but only as a repository name, never as a URL:
// a URL taken from a submission is a remote this machine was told to run git
// against (file://, ext::sh -c …).
export const resultRemoteUrl = (repository: string) =>
  `https://github.com/${repository}.git`;

// ---------------------------------------------------------------------------
// What a read can end in
// ---------------------------------------------------------------------------
// The asymmetry, expressed in the type rather than in a sentence: the caller
// refunds on a fault and holds on an obstacle, so the two can never be reached
// through the same field. There is no third case and no "maybe".

/**
 * Something about the result that reading PROVED. Only this may end in a refund,
 * and it is only reachable through provenFault().
 */
export type ProvenFault = {
  rule: "secret";
  // The paths the scan named, with the class of pattern — never the secret.
  paths: string[];
  detail: string;
};

/**
 * tig could not look. Never the worker's fault, so the caller holds. "I could
 * not read it" is not "it is bad", and this type exists so that sentence cannot
 * be lost in a message string on the way to the settlement.
 */
export type ReadObstacle =
  | { rule: "coordinates"; detail: string }
  | { rule: "fetch"; detail: string }
  | { rule: "base"; detail: string }
  | { rule: "unscanned"; paths: string[]; detail: string }
  | { rule: "diff"; detail: string };

export type ResultDiffRead =
  | { read: "diff"; changes: ResultChanges; unexamined: ResultUnexamined[] }
  | { read: "fault"; fault: ProvenFault }
  | { read: "obstacle"; obstacle: ReadObstacle };

// The gate's own report about blobs of the result commit it stopped short of.
// Derived from the reader rather than re-declared, so the two cannot drift.
export type ResultUnexamined = Awaited<
  ReturnType<typeof readCommittedChanges>
>["unexamined"][number];

export interface ResultGitRead {
  gitResult: ResultGitCoordinates;
  // submission.baseCommit: the commit the result must be built on.
  requestCommit: string;
  /**
   * NOT "the network call returned zero". It is "everything settle.ts's rules
   * read out of Git was really read": the commit is here, it is a commit, its
   * parents were read and its tree was listed. Anything less is false, because
   * M1 refuses an empty parent list and M4 refuses an empty tree — a refusal
   * must never come out of a read that did not happen, and P3 (fetched false)
   * is the one door in mechanicalChecks that holds before those rules run.
   */
  fetched: boolean;
  // Kept for diagnosis and never printed: git's stderr carries remote text.
  fetchReason: string | null;
  parents: string[];
  // null when the branch could not be read. M2 holds on null and refuses only on
  // a tip that really moved, so a network failure never costs the worker money.
  branchTip: string | null;
  resultTree: ResultTreeEntry[];
  diff: ResultDiffRead;
}

export const provenFault = (r: ResultGitRead): ProvenFault | null =>
  r.diff.read === "fault" ? r.diff.fault : null;
export const readObstacle = (r: ResultGitRead): ReadObstacle | null =>
  r.diff.read === "obstacle" ? r.diff.obstacle : null;
export const resultChanges = (r: ResultGitRead): ResultChanges | null =>
  r.diff.read === "diff" ? r.diff.changes : null;

const COORDINATES_DETAIL =
  "The Git coordinates of this result are not in the shape tig can follow, so nothing was fetched.";
const FETCH_DETAIL =
  "The result commit could not be read from the repository the submission names.";
const BASE_DETAIL =
  "The result is not built on your request commit, so there is no request-to-result diff to read.";
const DIFF_DETAIL = "The change could not be read out of the result commit.";
const unscannedDetail = (paths: string[]) =>
  `The result holds text too large to scan for secrets (${paths.join(", ")}). Nothing was read from it, so nothing is judged.`;
const secretDetail = (paths: string[]) =>
  `The result contains what looks like a secret in ${paths.join(", ")}.`;

/**
 * The git-shaped half of the evidence settle.ts's mechanicalChecks reads. The
 * mapping lives here, next to the union it comes from, so no caller has to
 * decide for itself which failure means "refund" and which means "hold".
 */
export function gitEvidence(
  read: ResultGitRead,
): Pick<
  MechanicalEvidence,
  | "requestCommit"
  | "gitResult"
  | "fetched"
  | "fetchReason"
  | "parents"
  | "branchTip"
  | "changes"
  | "secret"
  | "unscanned"
  | "resultTree"
> {
  const fault = provenFault(read);
  const obstacle = readObstacle(read);
  return {
    requestCommit: read.requestCommit,
    gitResult: read.gitResult,
    fetched: read.fetched,
    fetchReason: read.fetchReason,
    parents: read.parents,
    branchTip: read.branchTip,
    changes: resultChanges(read),
    secret: fault ? { paths: fault.paths } : null,
    unscanned:
      obstacle?.rule === "unscanned" ? { paths: obstacle.paths } : null,
    resultTree: read.resultTree,
  };
}

// ---------------------------------------------------------------------------
// The settlement working directory
// ---------------------------------------------------------------------------

/**
 * The layout worker-agent's readers derive from a directory string. settle.ts's
 * openEvidence builds the same one; this exists so a caller (or a test) that has
 * only a directory can build it without reaching into the state directory.
 */
export const resultGitPaths = (dir: string): EvidencePaths => {
  const { gitDir, workTree } = workspacePaths(dir);
  return { dir, gitDir, workTree };
};

/**
 * An empty repository to fetch the result into, plus the no-hooks directory
 * every git call in this module points core.hooksPath at. The work tree is made
 * and left empty on purpose: the result is read as a diff between two commits
 * and is never checked out, so nothing the worker wrote is ever a file here.
 */
export async function prepareResultGit(paths: EvidencePaths) {
  const layout = resultGitPaths(paths.dir);
  if (layout.gitDir !== paths.gitDir || layout.workTree !== paths.workTree)
    throw new Error(
      "The settlement working directory must use the <dir>/git and <dir>/ws layout the result readers derive.",
    );
  const { noHooks } = workspacePaths(paths.dir);
  // A pass killed mid-fetch leaves objects nobody verified. The diff is only
  // trusted when it comes from what this pass fetched itself.
  await rm(paths.gitDir, { recursive: true, force: true });
  await rm(paths.workTree, { recursive: true, force: true });
  for (const p of [paths.dir, paths.gitDir, paths.workTree, noHooks])
    await mkdir(p, { recursive: true, mode: 0o700 });
  const git = workspaceGit(paths.dir);
  // --template=: no sample hooks are copied in, so the empty hooksPath below is
  // not the only thing standing between a fetch and a script.
  await git.run(["init", "--template=", "-q"]);
  // In the repository's OWN config, not only on this module's argv. The readers
  // this module hands the directory to (worker-agent's scanResultCommit and
  // scanCommit) spawn git with --git-dir and no -c of their own, so a hooksPath
  // that lives only in an argument is an invariant that is already false; here
  // it holds for every command run against this repository, including the next
  // one somebody adds.
  await git.run(["config", "core.hooksPath", noHooks]);
  return git;
}

// ---------------------------------------------------------------------------
// Reading one result
// ---------------------------------------------------------------------------

export interface ReadResultGitOptions {
  paths: EvidencePaths;
  gitResult: ResultGitCoordinates;
  requestCommit: string;
  /**
   * Tests only. Production assembles the GitHub URL from the repository field;
   * an override exists so the tests can drive the real git against a real local
   * repository instead of mocking any of this.
   */
  remoteUrl?: (repository: string) => string;
  signal?: AbortSignal;
}

const stopped = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new Error("The settlement pass was stopped.");
};
// git's stderr is remote text: recorded for diagnosis, never a printed sentence.
const diagnosis = (e: unknown) =>
  ((e as Error)?.message ?? String(e)).slice(0, 400);

/**
 * Fetch the submitted result, prove it is the commit that was submitted and that
 * it sits on the request commit, and read the change out of it.
 *
 * Never throws for anything the worker or the network did: every such ending is
 * a value, and which of the two kinds it is decides whether the caller may take
 * the worker's money back.
 */
export async function readResultGit(
  o: ReadResultGitOptions,
): Promise<ResultGitRead> {
  const { gitResult, requestCommit } = o;
  const unread = (
    obstacle: ReadObstacle,
    fetchReason: string | null = null,
  ): ResultGitRead => ({
    gitResult,
    requestCommit,
    fetched: false,
    fetchReason,
    parents: [],
    branchTip: null,
    resultTree: [],
    diff: { read: "obstacle", obstacle },
  });

  const shape = coordinateProblem(gitResult, requestCommit);
  if (shape)
    return unread({ rule: "coordinates", detail: COORDINATES_DETAIL }, shape);

  const url = (o.remoteUrl ?? resultRemoteUrl)(gitResult.repository);
  // An argv element that starts with "-" is a flag, whoever wrote it.
  if (url.startsWith("-"))
    return unread(
      { rule: "coordinates", detail: COORDINATES_DETAIL },
      "remote url starts with a dash",
    );

  const git = await prepareResultGit(o.paths);
  const fetch = (args: string[]) =>
    git.run(
      // fsckObjects: the objects come from a repository whose owner is paid when
      // this ends in "approve". A malformed one stops the read (a hold), which
      // is the safe direction.
      ["-c", "fetch.fsckObjects=true", "fetch", "--no-tags", ...args],
      { network: true, timeout: RESULT_FETCH_TIMEOUT_MS },
    );

  // The commit itself, two deep. --depth 1 would make the parent a shallow
  // boundary and there would be no request-to-result diff to read at all.
  try {
    stopped(o.signal);
    await fetch(["--depth", "2", url, gitResult.commit]);
    const head = (await git.run(["rev-parse", "FETCH_HEAD"])).trim();
    if (head !== gitResult.commit)
      return unread(
        { rule: "fetch", detail: FETCH_DETAIL },
        `FETCH_HEAD ${head} is not the submitted commit`,
      );
  } catch (e) {
    return unread({ rule: "fetch", detail: FETCH_DETAIL }, diagnosis(e));
  }

  // From here the two reads that must not come back empty by accident: an empty
  // parent list refuses (M1) and an empty tree refuses (M4), so a failure here
  // is reported as "not fetched" rather than as a result with no parent.
  let parents: string[];
  let resultTree: ResultTreeEntry[];
  try {
    stopped(o.signal);
    parents = (
      await git.run(["rev-list", "--parents", "-n", "1", gitResult.commit])
    )
      .trim()
      .split(/\s+/)
      .slice(1)
      .filter(Boolean);
    resultTree = await readResultTree(git, gitResult.commit);
  } catch (e) {
    return unread({ rule: "fetch", detail: FETCH_DETAIL }, diagnosis(e));
  }

  // The branch, separately: a tip that no longer points at the submitted commit
  // is a force push over what was reviewed. Its own failure is never the
  // commit's failure — M2 holds on null and refuses only on a tip it really
  // read. Two deep like the fetch above, and for the same reason: --depth 1
  // here re-shallows the repository at the result commit, which takes the
  // request commit's parenthood away again and leaves the evidence directory
  // (kept after a refusal, so the requester can look) with no diff to show.
  let branchTip: string | null = null;
  let fetchReason: string | null = null;
  try {
    stopped(o.signal);
    await fetch([
      "--depth",
      "2",
      url,
      `+refs/heads/${gitResult.branch}:refs/tig/result-branch`,
    ]);
    branchTip = (await git.run(["rev-parse", "refs/tig/result-branch"])).trim();
  } catch (e) {
    fetchReason = diagnosis(e);
  }

  const read = {
    gitResult,
    requestCommit,
    fetched: true,
    fetchReason,
    parents,
    branchTip,
    resultTree,
  };

  // The request commit is in this repository only as the result's parent. When
  // the result was not built on it there is nothing to diff against, and M1
  // refuses from `parents` before this obstacle is ever consulted.
  if (parents.length !== 1 || parents[0] !== requestCommit)
    return {
      ...read,
      diff: {
        read: "obstacle",
        obstacle: { rule: "base", detail: BASE_DETAIL },
      },
    };

  try {
    stopped(o.signal);
    const changes = await readCommittedChanges(
      o.paths.dir,
      requestCommit,
      gitResult.commit,
    );
    return {
      ...read,
      diff: {
        read: "diff",
        changes: {
          files: changes.files,
          unscanned: changes.unscanned,
          stat: changes.stat,
        },
        unexamined: changes.unexamined,
      },
    };
  } catch (e) {
    // The one place in this module where the two kinds of ending are told apart,
    // and the reason the reader's two error classes exist. A secret was read and
    // is therefore proven; text over the scan limit was NOT read, so it says
    // nothing at all about the result.
    if (e instanceof ResultSecretDetected) {
      const paths = namesIn(e.message, SECRET_MARK);
      return {
        ...read,
        diff: {
          read: "fault",
          fault: { rule: "secret", paths, detail: secretDetail(paths) },
        },
      };
    }
    if (e instanceof ResultUnscannedText) {
      const paths = namesIn(e.message, UNSCANNED_MARK);
      return {
        ...read,
        diff: {
          read: "obstacle",
          obstacle: {
            rule: "unscanned",
            paths,
            detail: unscannedDetail(paths),
          },
        },
      };
    }
    return {
      ...read,
      fetchReason: fetchReason ?? diagnosis(e),
      diff: {
        read: "obstacle",
        obstacle: { rule: "diff", detail: DIFF_DETAIL },
      },
    };
  }
}

function coordinateProblem(
  gitResult: ResultGitCoordinates,
  requestCommit: string,
): string | null {
  if (!REPOSITORY.test(gitResult.repository)) return "repository";
  if (!RESULT_BRANCH.test(gitResult.branch)) return "branch";
  if (!SHA.test(gitResult.commit)) return "commit";
  if (!SHA.test(requestCommit)) return "request commit";
  return null;
}

// The reader names the files it refused over in its message and keeps no field
// for them (it is the worker's error type, and this module does not edit that
// file). The list is recovered from the sentence it builds; when it cannot be,
// the finding still stands — a secret that was read is proven whether or not its
// path survived the round trip.
const SECRET_MARK = {
  after: "looks like a secret in ",
  before: ". Nothing was pushed",
  fallback: "the result",
};
const UNSCANNED_MARK = {
  after: "too large to scan for secrets in ",
  before: ". Nothing was pushed",
  fallback: "a file in the result",
};
function namesIn(
  message: string,
  mark: { after: string; before: string; fallback: string },
): string[] {
  const start = message.indexOf(mark.after);
  const end = message.indexOf(mark.before, start);
  if (start < 0 || end < 0) return [mark.fallback];
  const names = message
    .slice(start + mark.after.length, end)
    .split(", ")
    .map((p) => p.trim())
    .filter(Boolean);
  return names.length ? names : [mark.fallback];
}

// The result commit's whole tree, which is what M4 (the request documents) and
// M5 (protected paths) are applied to. Same rows as request-tree's treeEntries
// reads for a request commit; read through this module's own runner so the
// git-dir and the empty hooksPath are named on this call too.
async function readResultTree(
  git: ReturnType<typeof workspaceGit>,
  commit: string,
): Promise<ResultTreeEntry[]> {
  const rows = (await git.run(["ls-tree", "-r", "-z", commit]))
    .split("\0")
    .filter(Boolean);
  return rows.map((row) => {
    const tab = row.indexOf("\t");
    const [mode = "", type = "", sha = ""] = row.slice(0, tab).split(" ");
    return { path: row.slice(tab + 1), mode, type, sha };
  });
}

// ---------------------------------------------------------------------------
// The hunks the AI is shown (§4)
// ---------------------------------------------------------------------------

export interface ResultHunk {
  path: string;
  status: ChangedFile["status"];
  // The unified diff for this one path, possibly cut short.
  text: string;
  // false: this file's change was not shown in full, so nothing read out of it
  // can settle anything.
  complete: boolean;
}
export interface ResultHunks {
  hunks: ResultHunk[];
  /**
   * Every path whose change the AI was NOT shown in full — cut short, left out
   * for want of budget, or unreadable. Load-bearing rather than informative: the
   * review guard forces cannot_tell on any verdict whose evidence sits in one of
   * these, and it does that from this list and not from any marker inside the
   * text, because the text is the worker's and the list is tig's.
   */
  truncated: string[];
  // What was collected, and how many files there were to collect from.
  bytes: number;
  files: number;
}

const CUT_MARK =
  "\n[tig: cut here — this file's change was not read in full]\n";
// git's own word for "there is nothing here a reader can read". Matched at the
// start of a line, which is where only git writes: every line of a diff body
// carries a leading space, + or -.
const BINARY_DIFF = /^(Binary files .* differ|GIT binary patch)$/m;

/**
 * The per-file hunks for one result, smallest file first, inside a per-file and
 * a total budget.
 *
 * Only ever called for a result whose mechanical rules all passed, which is also
 * why the text needs no secret scan of its own: readCommittedChanges refuses a
 * commit that carries one before this can run.
 */
export async function readResultHunks(o: {
  paths: EvidencePaths;
  requestCommit: string;
  commit: string;
  files: ChangedFile[];
  fileMax?: number;
  totalMax?: number;
  signal?: AbortSignal;
}): Promise<ResultHunks> {
  const git = workspaceGit(o.paths.dir);
  const fileMax = Math.max(0, o.fileMax ?? REVIEW_FILE_MAX);
  let left = Math.max(0, o.totalMax ?? REVIEW_DIFF_MAX);
  const hunks: ResultHunk[] = [];
  const truncated: string[] = [];
  // Smallest first: a budget spent on one huge file buys one answer, and the
  // same budget spent on twenty small ones buys twenty.
  const order = [...o.files].sort(
    (a, b) => a.bytes - b.bytes || a.path.localeCompare(b.path),
  );
  for (const file of order) {
    stopped(o.signal);
    const room = Math.min(fileMax, left);
    if (room <= 0) {
      truncated.push(file.path);
      continue;
    }
    let raw: Buffer;
    try {
      // head() stops git as soon as the bytes arrive, so a 500 MB diff is never
      // held in memory to be thrown away. :(literal) keeps a path that contains
      // a wildcard from selecting another file's change — the paths here came
      // out of the worker's own commit.
      raw = await git.head(
        [
          "diff",
          "--no-renames",
          "-U3",
          o.requestCommit,
          o.commit,
          "--",
          `:(literal)${file.path}`,
        ],
        room + 1,
      );
    } catch {
      truncated.push(file.path);
      continue;
    }
    const fits = raw.length <= room;
    const text = fits ? raw.toString("utf8") : cutAtLine(raw, room);
    if (!text) {
      truncated.push(file.path);
      continue;
    }
    // A hunk can fit the budget whole and still show nobody anything: git
    // prints one line about a blob it cannot render as text, and a blob that
    // never decoded is not text tig read. Both are "not shown in full", because
    // `truncated` is the one list the review guard and settle.ts's partial-read
    // rule both key off — a file that is not in it is a file somebody can be
    // paid for without its bytes having been read.
    const unreadable =
      (file.status !== "deleted" && !file.text) || BINARY_DIFF.test(text);
    const complete = fits && !unreadable;
    if (!complete) truncated.push(file.path);
    left -= Buffer.byteLength(text);
    hunks.push({ path: file.path, status: file.status, text, complete });
  }
  return {
    hunks,
    truncated,
    bytes: hunks.reduce((n, h) => n + Buffer.byteLength(h.text), 0),
    files: o.files.length,
  };
}

// Cut on a line boundary: half a line of someone else's code reads like a line
// of code, and a decoded half character reads like nothing at all. The marker is
// paid for out of the same room, or the limit would be a suggestion.
function cutAtLine(raw: Buffer, room: number): string {
  const bound = room - Buffer.byteLength(CUT_MARK);
  if (bound <= 0) return "";
  const kept = raw.subarray(0, bound);
  const end = kept.lastIndexOf(0x0a);
  if (end < 0) return "";
  return kept.subarray(0, end).toString("utf8") + CUT_MARK;
}

// ---------------------------------------------------------------------------
// After a payment: the result on a branch of the requester's own repository (§6)
// ---------------------------------------------------------------------------

export const resultBranchName = (taskId: string) => `tig/results/${taskId}`;

export interface AdoptedResult {
  // The local branch that now holds the result, without refs/heads/.
  branch: string;
  commit: string;
  // false: the branch was already there at this commit and nothing was fetched.
  fetched: boolean;
}

/**
 * Put an approved result on a local branch of the requester's own repository.
 *
 * `git fetch` writes one ref and the objects under it. It does not check out,
 * does not merge, does not move HEAD and does not touch the index or a single
 * file in the working tree — and this function does nothing else, so the
 * requester's current branch and uncommitted work are exactly where they were.
 * The result's parent is the parentless request commit, so the branch is not
 * connected to their history; that is a fact about it, and the line that
 * announces it says so.
 *
 * Failing here changes no settlement: the money has already moved.
 */
export async function adoptResultBranch(o: {
  projectRoot: string;
  repository: string;
  commit: string;
  taskId: string;
  remoteUrl?: (repository: string) => string;
  signal?: AbortSignal;
}): Promise<AdoptedResult> {
  if (!REPOSITORY.test(o.repository) || !SHA.test(o.commit))
    throw new Error("The result's Git coordinates are not in a usable shape.");
  const wanted = resultBranchName(o.taskId);
  if (!RESULT_BRANCH.test(wanted))
    throw new Error("The result's Git coordinates are not in a usable shape.");
  const url = (o.remoteUrl ?? resultRemoteUrl)(o.repository);
  if (url.startsWith("-"))
    throw new Error("The result's Git coordinates are not in a usable shape.");

  // This is the requester's OWN repository, so their global config stays: their
  // proxy, their CA bundle and their credential helper are how git reaches the
  // network here. Only hooks are taken away — `git fetch` updates a ref, and a
  // reference-transaction hook runs when it does.
  const noHooks = await mkdtemp(join(tmpdir(), "tig-adopt-"));
  try {
    const git = async (args: string[]) =>
      (
        await exec(
          "git",
          [
            "-C",
            o.projectRoot,
            "-c",
            `core.hooksPath=${noHooks}`,
            "-c",
            "core.fsmonitor=false",
            ...args,
          ],
          {
            env: {
              ...process.env,
              GIT_TERMINAL_PROMPT: "0",
              GH_PROMPT_DISABLED: "1",
            },
            maxBuffer: 4_000_000,
            timeout: RESULT_FETCH_TIMEOUT_MS,
          },
        )
      ).stdout.trim();
    const at = async (branch: string) =>
      git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).catch(
        () => "",
      );

    stopped(o.signal);
    // A branch already there at this commit is the answer; nothing is fetched
    // and nothing is said twice.
    let branch = wanted;
    const existing = await at(branch);
    if (existing === o.commit)
      return { branch, commit: o.commit, fetched: false };
    if (existing) {
      // Another result already owns the name. It is never overwritten: a branch
      // the requester may have built on is not tig's to move.
      branch = `${wanted}-${o.commit.slice(0, 7)}`;
      if ((await at(branch)) === o.commit)
        return { branch, commit: o.commit, fetched: false };
    }
    await git([
      "fetch",
      "--no-tags",
      "--depth",
      "2",
      url,
      `+${o.commit}:refs/heads/${branch}`,
    ]);
    if ((await at(branch)) !== o.commit)
      throw new Error("The result commit did not arrive on the local branch.");
    return { branch, commit: o.commit, fetched: true };
  } finally {
    await rm(noHooks, { recursive: true, force: true }).catch(() => {});
  }
}
