import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  adoptResultBranch,
  gitEvidence,
  provenFault,
  readObstacle,
  readResultGit,
  readResultHunks,
  resultBranchName,
  resultChanges,
  resultGitPaths,
  resultRemoteUrl,
} from "../apps/cli/src/result-git.js";
import {
  mechanicalChecks,
  type MechanicalEvidence,
} from "../apps/cli/src/settle.js";
import { workspacePaths } from "../apps/cli/src/worker-agent.js";

const exec = promisify(execFile);
const git = async (cwd: string, args: string[]) =>
  (
    await exec("git", args, {
      cwd,
      maxBuffer: 64_000_000,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_AUTHOR_NAME: "tig",
        GIT_AUTHOR_EMAIL: "tig@example.invalid",
        GIT_COMMITTER_NAME: "tig",
        GIT_COMMITTER_EMAIL: "tig@example.invalid",
      },
    })
  ).stdout.trim();

type Change = [string, string | Buffer | null];

// A published tree-layout request in a bare "GitHub" repository: a PARENTLESS
// commit holding the project tree and the two request documents at the root.
// Everything below drives the real git against it; nothing here is mocked.
async function remote(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "tig-result-git-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const taskId = randomUUID();
  const requestId = randomUUID();
  const origin = join(root, "origin.git");
  await git(root, ["init", "-q", "--bare", origin]);
  // GitHub serves any reachable commit by sha; a plain bare repo only advertises tips.
  await git(origin, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
  const src = join(root, "src");
  await git(root, ["init", "-q", src]);

  const apply = async (changes: Change[]) => {
    for (const [path, content] of changes) {
      if (content === null) {
        await rm(join(src, path), { force: true });
        continue;
      }
      await mkdir(dirname(join(src, path)), { recursive: true });
      await writeFile(join(src, path), content);
    }
    await git(src, ["add", "-A"]);
    return git(src, ["write-tree"]);
  };
  const docs = {
    "request.md": `# Make add return the sum\n\nRequest ${requestId}\n`,
    "request.json": `${JSON.stringify({ version: 1, id: requestId, layout: "tree" })}\n`,
  };
  const requestTree = await apply([
    ["README.md", "# demo\n"],
    ["lib/main.js", "export const add = (a, b) => a - b;\n"],
    ["request.md", docs["request.md"]],
    ["request.json", docs["request.json"]],
  ]);
  const requestCommit = await git(src, [
    "commit-tree",
    requestTree,
    "-m",
    `Tokenisgold request ${requestId}`,
  ]);

  const dir = join(root, "settlement");
  const branch = `tig/results/${taskId}`;
  return {
    root,
    src,
    taskId,
    requestCommit,
    docs,
    branch,
    dir,
    paths: resultGitPaths(dir),
    remoteUrl: () => `file://${origin}`,
    /** A commit on top of `parents` (the request commit by default). */
    async commit(changes: Change[], parents: string[] = [requestCommit]) {
      const tree = await apply(changes);
      return git(src, [
        "commit-tree",
        tree,
        ...parents.flatMap((p) => ["-p", p]),
        "-m",
        "Tokenisgold result",
      ]);
    },
    /** A parentless commit that is not the request commit. */
    async unrelated(changes: Change[]) {
      const tree = await apply(changes);
      return git(src, ["commit-tree", tree, "-m", "somewhere else"]);
    },
    async publish(commit: string, ref = branch) {
      await git(src, ["push", "-q", origin, `+${commit}:refs/heads/${ref}`]);
    },
    coordinates(commit: string) {
      return {
        repository: "worker/delivery",
        branch,
        commit,
        pullRequestUrl: null,
      };
    },
    read(
      commit: string,
      coordinates?: Partial<ReturnType<typeof this.coordinates>>,
    ) {
      return readResultGit({
        paths: resultGitPaths(dir),
        gitResult: { ...this.coordinates(commit), ...coordinates },
        requestCommit,
        remoteUrl: () => `file://${origin}`,
      });
    },
  };
}

type Remote = Awaited<ReturnType<typeof remote>>;

// The rest of the evidence settle.ts's rules read, so this module's output can be
// run through the real rules: what matters is not the sentence a failure carries
// but whether it can reach "failed" (a refund) at all.
const evidenceOf = (
  r: Remote,
  read: Awaited<ReturnType<typeof readResultGit>>,
): MechanicalEvidence => ({
  ...gitEvidence(read),
  requestDocs: [
    { path: "request.md", content: r.docs["request.md"] },
    { path: "request.json", content: r.docs["request.json"] },
  ],
  artifacts: {
    files: [{ path: "report.md", content: "# report\n" }],
    deletedPaths: [],
  },
  submission: {
    report: "Changed subtraction to addition.",
    reportMarkdown: null,
    execution: { provider: "codex" },
  },
  untrackedNotShared: [],
});

test("a clean result is fetched at the submitted commit, proved to sit on the request commit, and read as a diff", async (t) => {
  const r = await remote(t);
  const commit = await r.commit([
    ["lib/main.js", "export const add = (a, b) => a + b;\n"],
    ["NOTES.md", "how it was done\n"],
    ["README.md", null],
  ]);
  await r.publish(commit);

  const read = await r.read(commit);
  assert.equal(read.fetched, true);
  assert.equal(read.fetchReason, null);
  assert.deepEqual(read.parents, [r.requestCommit]);
  assert.equal(read.branchTip, commit);
  assert.equal(read.diff.read, "diff");
  assert.equal(provenFault(read), null);
  assert.equal(readObstacle(read), null);

  const changes = resultChanges(read);
  assert.ok(changes);
  assert.deepEqual(
    changes.files.map((f) => [f.path, f.status]).sort(),
    [
      ["NOTES.md", "added"],
      ["README.md", "deleted"],
      ["lib/main.js", "modified"],
    ].sort(),
  );
  assert.equal(changes.unscanned, 0);
  assert.match(changes.stat ?? "", /3 files changed/);

  // The whole result tree, which is what the request-document and protected-path
  // rules are applied to.
  const request = read.resultTree.find((e) => e.path === "request.json");
  assert.equal(request?.mode, "100644");
  assert.equal(request?.type, "blob");
  assert.ok(read.resultTree.some((e) => e.path === "lib/main.js"));

  // The result is read as a diff and is never checked out: nothing the worker
  // wrote is ever a file on this computer.
  assert.deepEqual(await readdir(r.paths.workTree), []);
  // Every git call in the module points core.hooksPath at this directory.
  assert.deepEqual(await readdir(workspacePaths(r.dir).noHooks), []);

  const checks = mechanicalChecks(evidenceOf(r, read));
  assert.deepEqual(
    checks.filter((c) => !c.passed),
    [],
    JSON.stringify(checks),
  );
});

test("a result with two parents is reported with both, and there is no request-to-result diff to read", async (t) => {
  const r = await remote(t);
  const side = await r.unrelated([["SIDE.md", "side\n"]]);
  const commit = await r.commit(
    [["lib/main.js", "export const add = (a, b) => a + b;\n"]],
    [r.requestCommit, side],
  );
  await r.publish(commit);

  const read = await r.read(commit);
  assert.equal(read.fetched, true);
  assert.equal(read.parents.length, 2);
  assert.equal(read.parents[0], r.requestCommit);
  assert.equal(readObstacle(read)?.rule, "base");
  assert.equal(resultChanges(read), null);

  // The rule, not this module, is what refuses it — and it does refuse.
  const checks = mechanicalChecks(evidenceOf(r, read));
  const failure = checks.find((c) => c.outcome === "failed");
  assert.equal(failure?.id, "M1");
});

test("a result built on something other than the request commit names the parent it really has", async (t) => {
  const r = await remote(t);
  const elsewhere = await r.unrelated([
    ["README.md", "# demo\n"],
    ["lib/main.js", "export const add = (a, b) => a - b;\n"],
    ["request.md", r.docs["request.md"]],
    ["request.json", r.docs["request.json"]],
    ["EXTRA.md", "not your request\n"],
  ]);
  const commit = await r.commit(
    [["lib/main.js", "export const add = (a, b) => a + b;\n"]],
    [elsewhere],
  );
  await r.publish(commit);

  const read = await r.read(commit);
  assert.equal(read.fetched, true);
  assert.deepEqual(read.parents, [elsewhere]);
  assert.equal(readObstacle(read)?.rule, "base");
  assert.equal(
    mechanicalChecks(evidenceOf(r, read)).find((c) => c.outcome === "failed")
      ?.id,
    "M1",
  );
});

test("a branch moved after submission is read as a moved branch, and the submitted commit is still read", async (t) => {
  const r = await remote(t);
  const submitted = await r.commit([
    ["lib/main.js", "export const add = (a, b) => a + b;\n"],
  ]);
  await r.publish(submitted);
  // The worker force-pushed something else over the branch after submitting.
  const later = await r.commit([
    ["lib/main.js", "export const add = () => 0;\n"],
  ]);
  await r.publish(later);

  const read = await r.read(submitted);
  assert.equal(read.fetched, true);
  assert.equal(read.branchTip, later);
  assert.notEqual(read.branchTip, submitted);
  // The diff is still the one that was submitted, not whatever is on the branch now.
  assert.equal(resultChanges(read)?.files.length, 1);

  const failure = mechanicalChecks(evidenceOf(r, read)).find(
    (c) => c.outcome === "failed",
  );
  assert.equal(failure?.id, "M2");
});

test("a fetch that fails reports nothing at all — no parents, no tree — and holds instead of refusing", async (t) => {
  const r = await remote(t);
  const commit = await r.commit([
    ["lib/main.js", "export const add = () => 1;\n"],
  ]);
  // Never published: the coordinates point at a commit the remote does not have.
  const read = await r.read(commit);
  assert.equal(read.fetched, false);
  assert.equal(readObstacle(read)?.rule, "fetch");
  assert.deepEqual(read.parents, []);
  assert.deepEqual(read.resultTree, []);
  assert.equal(read.branchTip, null);
  assert.ok(read.fetchReason);

  // The asymmetry: an empty parent list and an empty tree are exactly what M1 and
  // M4 refuse on, so a read that did not happen must never reach them.
  const checks = mechanicalChecks(evidenceOf(r, read));
  assert.deepEqual(
    checks.map((c) => c.outcome),
    ["hold"],
  );
  assert.equal(checks[0]?.id, "P3");
});

test("coordinates that are not in the submission's shape stop before any git runs", async (t) => {
  const r = await remote(t);
  const read = await readResultGit({
    paths: r.paths,
    gitResult: {
      repository: "https://evil.example.invalid/x.git",
      branch: r.branch,
      commit: "a".repeat(40),
      pullRequestUrl: null,
    },
    requestCommit: r.requestCommit,
    remoteUrl: r.remoteUrl,
  });
  assert.equal(read.fetched, false);
  assert.equal(readObstacle(read)?.rule, "coordinates");
  assert.equal(read.fetchReason, "repository");
  // Nothing was prepared, so nothing was fetched.
  await assert.rejects(readdir(r.paths.gitDir));
  assert.equal(
    resultRemoteUrl("worker/delivery"),
    "https://github.com/worker/delivery.git",
  );
});

test("a secret in the result is a fault that may refuse; text too large to scan is an obstacle that may not", async (t) => {
  const r = await remote(t);
  const key = `AKIA${"ABCDEFGHIJKLMNOP"}`;
  const commit = await r.commit([
    ["lib/config.js", `export const id = "${key}";\n`],
  ]);
  await r.publish(commit);

  const read = await r.read(commit);
  assert.equal(read.fetched, true);
  assert.equal(read.diff.read, "fault");
  const fault = provenFault(read);
  assert.equal(fault?.rule, "secret");
  assert.ok(fault?.paths.some((p) => p.startsWith("lib/config.js")));
  assert.equal(readObstacle(read), null);
  assert.equal(gitEvidence(read).unscanned, null);
  // Proven by reading, so it is allowed to cost the worker the reward.
  const failure = mechanicalChecks(evidenceOf(r, read)).find(
    (c) => c.outcome === "failed",
  );
  assert.equal(failure?.id, "M6");

  // The other half of the same classifier, in a second repository: 10 MB of text
  // nobody read says nothing whatever about the result.
  const big = await remote(t);
  const huge = await big.commit([
    ["data/dump.txt", Buffer.alloc(11 * 1024 * 1024, 0x41)],
  ]);
  await big.publish(huge);
  const unreadable = await big.read(huge);
  assert.equal(unreadable.fetched, true);
  assert.equal(unreadable.diff.read, "obstacle");
  const obstacle = readObstacle(unreadable);
  assert.equal(obstacle?.rule, "unscanned");
  assert.equal(provenFault(unreadable), null);
  assert.deepEqual(obstacle?.rule === "unscanned" ? obstacle.paths : [], [
    "data/dump.txt",
  ]);
  const held = mechanicalChecks(evidenceOf(big, unreadable));
  assert.equal(
    held.find((c) => c.outcome === "failed"),
    undefined,
  );
  assert.equal(held.find((c) => c.outcome === "hold")?.id, "M6");
});

test("the hunks the AI reads keep a per-file and a total budget, and name every file that was not shown in full", async (t) => {
  const r = await remote(t);
  const line = (n: number) => `export const v${n} = ${n};\n`;
  const medium = Array.from({ length: 200 }, (_, i) => line(i)).join("");
  const huge = Array.from({ length: 4000 }, (_, i) => line(i)).join("");
  const commit = await r.commit([
    ["small.js", "export const one = 1;\n"],
    ["medium.js", medium],
    ["huge.js", huge],
  ]);
  await r.publish(commit);
  const read = await r.read(commit);
  const files = resultChanges(read)?.files ?? [];
  assert.equal(files.length, 3);

  const whole = await readResultHunks({
    paths: r.paths,
    requestCommit: r.requestCommit,
    commit,
    files,
    fileMax: 1_000_000,
    totalMax: 5_000_000,
  });
  assert.deepEqual(whole.truncated, []);
  assert.equal(whole.hunks.length, 3);
  assert.equal(whole.files, 3);
  assert.ok(whole.hunks.every((h) => h.complete));
  assert.match(
    whole.hunks.find((h) => h.path === "small.js")?.text ?? "",
    /\+export const one = 1;/,
  );

  // The default per-file limit is REVIEW_FILE_MAX, and a file over it is named.
  const standard = await readResultHunks({
    paths: r.paths,
    requestCommit: r.requestCommit,
    commit,
    files,
  });
  assert.deepEqual(standard.truncated, ["huge.js"]);
  assert.equal(
    standard.hunks.find((h) => h.path === "medium.js")?.complete,
    true,
  );
  const cut = standard.hunks.find((h) => h.path === "huge.js");
  assert.equal(cut?.complete, false);
  assert.match(cut?.text ?? "", /\[tig: cut here/);
  assert.ok(Buffer.byteLength(cut?.text ?? "") <= 20000);
  // Cut on a line boundary: half a line of someone else's code reads like a line.
  const body = (cut?.text ?? "").split("[tig: cut here")[0] ?? "";
  assert.match(body.split("\n").at(-2) ?? "", /^\+export const v\d+ = \d+;$/);

  const tight = await readResultHunks({
    paths: r.paths,
    requestCommit: r.requestCommit,
    commit,
    files,
    fileMax: 1000,
    totalMax: 200,
  });
  // Smallest first, so the small file is shown whole and the budget is gone
  // before the big ones: a file with no room at all is left out and named.
  assert.deepEqual(
    tight.hunks.map((h) => h.path),
    ["small.js"],
  );
  assert.equal(tight.hunks[0]?.complete, true);
  assert.deepEqual(tight.truncated.sort(), ["huge.js", "medium.js"]);
  assert.ok(tight.bytes <= 200, `${tight.bytes} bytes`);
});

test("adopting an approved result writes one branch and leaves HEAD, the index and the working tree untouched", async (t) => {
  const r = await remote(t);
  const first = await r.commit([
    ["lib/main.js", "export const add = (a, b) => a + b;\n"],
  ]);
  await r.publish(first);

  const project = join(r.root, "project");
  await git(r.root, ["init", "-q", "-b", "main", project]);
  await writeFile(join(project, "app.js"), "console.log(1);\n");
  await git(project, ["add", "-A"]);
  await git(project, ["commit", "-q", "-m", "mine"]);
  // Work in progress the requester has not committed.
  await writeFile(join(project, "app.js"), "console.log(2);\n");
  await writeFile(join(project, "scratch.txt"), "notes\n");
  const before = {
    head: await git(project, ["rev-parse", "HEAD"]),
    branch: await git(project, ["symbolic-ref", "HEAD"]),
    status: await git(project, ["status", "--porcelain"]),
    app: await readFile(join(project, "app.js"), "utf8"),
  };

  const adopted = await adoptResultBranch({
    projectRoot: project,
    repository: "worker/delivery",
    commit: first,
    taskId: r.taskId,
    remoteUrl: r.remoteUrl,
  });
  assert.equal(adopted.branch, resultBranchName(r.taskId));
  assert.equal(adopted.commit, first);
  assert.equal(adopted.fetched, true);
  assert.equal(
    await git(project, ["rev-parse", `refs/heads/${adopted.branch}`]),
    first,
  );
  assert.equal(await git(project, ["rev-parse", "HEAD"]), before.head);
  assert.equal(await git(project, ["symbolic-ref", "HEAD"]), before.branch);
  assert.equal(await git(project, ["status", "--porcelain"]), before.status);
  assert.equal(await readFile(join(project, "app.js"), "utf8"), before.app);
  // The requester's own history is still their own history.
  assert.equal(await git(project, ["rev-list", "--count", "HEAD"]), "1");

  // Running again over the same result changes nothing and fetches nothing.
  const again = await adoptResultBranch({
    projectRoot: project,
    repository: "worker/delivery",
    commit: first,
    taskId: r.taskId,
    remoteUrl: r.remoteUrl,
  });
  assert.deepEqual(again, {
    branch: adopted.branch,
    commit: first,
    fetched: false,
  });

  // A second result for the same task never overwrites the first branch.
  const second = await r.commit([
    ["lib/main.js", "export const add = (a, b) => b + a;\n"],
  ]);
  await r.publish(second);
  const next = await adoptResultBranch({
    projectRoot: project,
    repository: "worker/delivery",
    commit: second,
    taskId: r.taskId,
    remoteUrl: r.remoteUrl,
  });
  assert.equal(
    next.branch,
    `${resultBranchName(r.taskId)}-${second.slice(0, 7)}`,
  );
  assert.equal(next.fetched, true);
  assert.equal(
    await git(project, [
      "rev-parse",
      `refs/heads/${resultBranchName(r.taskId)}`,
    ]),
    first,
  );
  assert.equal(await git(project, ["rev-parse", "HEAD"]), before.head);
  assert.equal(await git(project, ["status", "--porcelain"]), before.status);
});

// ---------------------------------------------------------------------------
// What "tig read this file" has to mean
// ---------------------------------------------------------------------------

test("a file git cannot render as text is named as unread, not shown as complete", async (t) => {
  const r = await remote(t);
  const blob = Buffer.alloc(4096);
  for (let i = 0; i < blob.length; i++) blob[i] = (i % 251) + 3;
  blob[0] = 0;
  const commit = await r.commit([
    ["lib/main.js", "export const add = (a, b) => a + b;\n"],
    ["assets/model.bin", blob],
  ]);
  await r.publish(commit);
  const read = await r.read(commit);
  const files = resultChanges(read)?.files ?? [];
  assert.equal(files.length, 2);

  const hunks = await readResultHunks({
    paths: r.paths,
    requestCommit: r.requestCommit,
    commit,
    files,
    fileMax: 1_000_000,
    totalMax: 5_000_000,
  });
  // `truncated` is the one list both guards read, so a file nobody read a byte
  // of belongs in it however much room there was.
  assert.deepEqual(hunks.truncated, ["assets/model.bin"]);
  assert.notEqual(
    hunks.hunks.find((h) => h.path === "assets/model.bin")?.complete,
    true,
  );
  assert.equal(
    hunks.hunks.find((h) => h.path === "lib/main.js")?.complete,
    true,
  );
});

test("the settlement repository keeps the result commit's parent reachable after every fetch", async (t) => {
  const r = await remote(t);
  const commit = await r.commit([
    ["lib/main.js", "export const add = (a, b) => a + b;\n"],
  ]);
  await r.publish(commit);
  const read = await r.read(commit);
  assert.equal(read.fetched, true);
  assert.equal(read.branchTip, commit);

  // The evidence directory is kept after a refusal so the requester can see what
  // was refused, and a reader added after the branch fetch must not silently get
  // an empty answer out of a repository this module re-shallowed behind it.
  const inGit = (args: string[]) =>
    exec("git", ["--git-dir", r.paths.gitDir, ...args], {
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
    }).then((o) => o.stdout.trim());
  const parents = (await inGit(["rev-list", "--parents", "-n", "1", commit]))
    .split(/\s+/)
    .slice(1);
  assert.deepEqual(parents, [r.requestCommit]);
  assert.match(
    await inGit(["diff", "--name-status", `${commit}^`, commit]),
    /lib\/main\.js/,
  );
});

test("the settlement repository names an empty hooks directory in its own config, not only on tig's own argv", async (t) => {
  const r = await remote(t);
  const commit = await r.commit([
    ["lib/main.js", "export const add = (a, b) => a + b;\n"],
  ]);
  await r.publish(commit);
  await r.read(commit);
  const { noHooks } = workspacePaths(r.dir);
  const configured = await exec("git", [
    "--git-dir",
    r.paths.gitDir,
    "config",
    "core.hooksPath",
  ]).then((o) => o.stdout.trim());
  assert.equal(configured, noHooks);

  // A git command spawned without tig's -c flags — which is what the readers in
  // worker-agent.ts do — must still find no hook to run.
  const ran = join(r.root, "hook-ran");
  const hooks = join(r.paths.gitDir, "hooks");
  await mkdir(hooks, { recursive: true });
  await writeFile(
    join(hooks, "reference-transaction"),
    `#!/bin/sh\necho ran > ${ran}\n`,
    { mode: 0o755 },
  );
  await exec("git", [
    "--git-dir",
    r.paths.gitDir,
    "update-ref",
    "refs/tig/probe",
    commit,
  ]);
  await assert.rejects(readFile(ran, "utf8"));
});
