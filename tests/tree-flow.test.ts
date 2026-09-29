import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { tmpdir } from "node:os";
import { git } from "../apps/cli/src/drafts.js";
import {
  initRequester,
  prepareRequest,
  publishRequest,
  type RequesterServices,
} from "../apps/cli/src/requester.js";
import {
  marketWork,
  packageManifest,
  workServices,
} from "../apps/cli/src/work.js";
import { publishWorkerResult } from "../apps/cli/src/worker-git.js";
import { CODEX_AGENT_FLAGS } from "../apps/cli/src/local-ai.js";
import type { CodexModel } from "../apps/cli/src/models.js";
import type { Terminal } from "../apps/cli/src/terminal.js";
const exec = promisify(execFile);

// End-to-end tree layout without external services: the requester publishes a
// working tree (uncommitted change + untracked file + a protected .env) as a
// parentless branch into a local bare "GitHub"; the worker clones that branch, a
// fake Codex edits the checkout, the result commit is pushed as tig/results/<task>
// and the platform submission mirrors the diff. Only the HTTP API and `gh` are
// stubbed; every Git step is real.

const models: CodexModel[] = [
  {
    id: "gpt-6-astra",
    model: "gpt-6-astra",
    displayName: "GPT-6 Astra",
    supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
    defaultReasoningEffort: "medium",
  },
];
const spec = () => ({
  title: "Fix the addition function",
  requestCategory: "bug",
  originalRequest: "Post the addition bug fix for 100 TIG.",
  context: "math.js exports add but subtracts. Correct it.",
  completedWork: "The failing test is written; the fix is not implemented.",
  scope: "Fix add in math.js so it returns the sum.",
  constraints: ["Do not add dependencies"],
  setupSteps: ["Use Node 24; no installation needed"],
  testSteps: ["node --test math.test.cjs"],
  acceptanceChecks: ["add(2, 3) equals 5"],
  aiRequirement: {
    provider: "codex",
    model: "astra",
    effort: "medium",
    source: "declared",
  },
  rewardTig: "100",
  executionDeadlineAt: new Date(Date.now() + 86400000).toISOString(),
});
const FIXED = "exports.add = (a, b) => a + b;\n";
const WIP = "exports.add = (a, b) => a - b; // wip\n";

function terminal() {
  const log: string[] = [];
  const ui: Terminal = {
    say: (x) => {
      log.push(x);
    },
    section: (a, b) => {
      log.push(a, b);
    },
    busy: (_label, run) => run(),
    ask: async () => {
      throw new Error("unexpected ask");
    },
    choose: async () => {
      throw new Error("unexpected choice");
    },
    confirm: async () => true,
  };
  return { ui, log };
}

// A fake Codex: answers --help with the flags tig checks, then edits the checkout
// (its cwd) and writes the structured report to --output-last-message.
async function fakeCodex(dir: string) {
  const report = {
    summary: "Changed subtraction to addition in math.js and noted it.",
    suggestedTests: ["node --test math.test.cjs"],
    limitations: ["Tests were not executed."],
    commandsRun: [],
  };
  const script = [
    `#!${process.execPath}`,
    "const fs = require('node:fs'), path = require('node:path');",
    "const args = process.argv.slice(2);",
    `if (args.includes('--help')) { console.log(${JSON.stringify(CODEX_AGENT_FLAGS.join(" "))}); process.exit(0); }`,
    "process.stdin.resume();",
    "process.stdin.on('end', () => {",
    `  fs.writeFileSync(path.join(process.cwd(), 'math.js'), ${JSON.stringify(FIXED)});`,
    "  fs.writeFileSync(path.join(process.cwd(), 'CHANGELOG.md'), '- add returns the sum\\n');",
    `  fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], ${JSON.stringify(JSON.stringify(report))});`,
    "});",
  ].join("\n");
  const bin = join(dir, "fake-codex");
  await writeFile(bin, script, { mode: 0o700 });
  return { bin, report };
}

// A fake `gh` on PATH: only `pr create` is expected; it prints the PR URL.
async function fakeGh(dir: string) {
  const bindir = join(dir, "gh-bin");
  await mkdir(bindir);
  const calls = join(dir, "gh-calls.log");
  await writeFile(
    join(bindir, "gh"),
    [
      `#!${process.execPath}`,
      "const fs = require('node:fs');",
      "const args = process.argv.slice(2);",
      `fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');`,
      "if (args[0] === 'pr' && args[1] === 'create') { console.log('https://github.com/example/delivery/pull/7'); process.exit(0); }",
      "process.exit(1);",
    ].join("\n"),
    { mode: 0o700 },
  );
  return {
    bindir,
    calls: async () =>
      (await readFile(calls, "utf8").catch(() => ""))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as string[]),
  };
}

async function setup(t: TestContext) {
  const temp = await mkdtemp(join(tmpdir(), "tig-tree-flow-"));
  const previousState = process.env.TIG_STATE_DIR,
    previousPath = process.env.PATH;
  process.env.TIG_STATE_DIR = join(temp, "state");
  const gh = await fakeGh(temp);
  process.env.PATH = `${gh.bindir}${delimiter}${previousPath ?? ""}`;
  t.after(async () => {
    if (previousState === undefined) delete process.env.TIG_STATE_DIR;
    else process.env.TIG_STATE_DIR = previousState;
    process.env.PATH = previousPath;
    await rm(temp, { recursive: true, force: true });
  });
  // The local "GitHub": one bare repository standing in for the request's own
  // repository, whichever name tig gives it.
  const origin = join(temp, "origin.git");
  await git(temp, ["init", "-q", "--bare", origin]);
  // The requester's project: a committed baseline, then an uncommitted change,
  // an untracked file and a protected .env that must never leave the machine.
  const root = join(temp, "source");
  await mkdir(root);
  await git(root, ["init", "-q", "--template="]);
  await git(root, ["config", "user.name", "Requester"]);
  await git(root, ["config", "user.email", "requester@example.invalid"]);
  await writeFile(join(root, "math.js"), "exports.add = (a, b) => a - b;\n");
  await writeFile(
    join(root, "math.test.cjs"),
    "const {add}=require('./math.js'); require('node:assert/strict').equal(add(2,3),5);\n",
  );
  await git(root, ["add", "."]);
  await git(root, ["commit", "-q", "-m", "source"]);
  const sourceHead = (await git(root, ["rev-parse", "HEAD"])).trim();
  await writeFile(join(root, "math.js"), WIP);
  await writeFile(join(root, "notes.md"), "untracked notes\n");
  await writeFile(join(root, ".env"), "API_TOKEN=do-not-publish\n");
  const status = (await git(root, ["status", "--porcelain"])).trim();
  return { temp, origin, root, sourceHead, status, gh };
}

// Requester services with a real push into the local bare repository.
function requesterStub(origin: string) {
  const posts: { path: string; body: any }[] = [];
  const userId = randomUUID(),
    projectId = randomUUID(),
    taskId = randomUUID();
  const services: RequesterServices = {
    origin: async () => "http://localhost:4173",
    githubIdentity: async () => "requester",
    api: async (path, options?: any) => {
      if (path === "/v1/me") return { id: userId };
      if (path === "/v1/wallet") return { available: "1000.00" };
      if (options?.body) posts.push({ path, body: options.body });
      if (path === "/v1/projects") return { id: projectId };
      if (path === "/v1/tasks") return { id: taskId };
      return { id: randomUUID() };
    },
    repository: async (name) => ({
      id: "42",
      repository: name,
      public: true,
      push: true,
    }),
    createRepository: async () => {},
    push: async (directory, repository, branch, commit) => {
      assert.match(
        repository,
        /^requester\/source-tig-\d{8}-\d{4}-[0-9a-f]{6}$/,
      );
      // The request lands on main; the worker's result is its own branch.
      assert.match(branch, /^(?:main|tig\/results\/[0-9a-f-]{36})$/);
      await exec("git", [
        "-C",
        directory,
        "push",
        "-q",
        `file://${origin}`,
        `${commit}:refs/heads/${branch}`,
      ]);
    },
  };
  return { services, posts, userId, taskId };
}

test("tree layout end to end: a working tree is published as a parentless branch, the worker's fake Codex edits a clone of it, and the result is a PR branch plus a mirrored submission", async (t) => {
  const s = await setup(t);
  const requester = requesterStub(s.origin);
  // ---- Requester: init, prepare (tree layout is the default), publish.
  await initRequester({ project: s.root }, requester.services);
  const specPath = join(s.temp, "spec.json");
  await writeFile(specPath, JSON.stringify(spec()));
  const preview = await prepareRequest(
    { project: s.root, spec: specPath },
    requester.services,
  );
  assert.equal(preview.layout, "tree");
  assert.equal(preview.destination, "new");
  assert.equal(preview.branch, "main");
  const repository = preview.repository;
  const receipt = await publishRequest(
    preview.requestId,
    preview.previewDigest,
    true,
    requester.services,
  );
  const branch = preview.branch;
  const requestCommit = (
    await git(s.origin, ["rev-parse", `refs/heads/${branch}`])
  ).trim();
  assert.equal(requestCommit, preview.commit);
  assert.equal(
    (await git(s.origin, ["rev-list", "--parents", "-n", "1", requestCommit]))
      .trim()
      .split(/\s+/).length,
    1,
    "the request commit has no parents",
  );
  const requestTree = (
    await git(s.origin, ["ls-tree", "-r", "--name-only", requestCommit])
  )
    .trim()
    .split("\n")
    .sort();
  assert.deepEqual(requestTree, [
    "math.js",
    "math.test.cjs",
    "notes.md",
    "request.json",
    "request.md",
  ]);
  assert.equal(
    await git(s.origin, ["show", `${requestCommit}:math.js`]),
    WIP,
    "the uncommitted change is what was published",
  );
  assert.deepEqual(
    preview.excluded.map((e: { path: string; reason: string }) => [
      e.path,
      e.reason,
    ]),
    [[".env", "protected"]],
  );
  // The source repository is untouched: same HEAD, same dirty state.
  assert.equal((await git(s.root, ["rev-parse", "HEAD"])).trim(), s.sourceHead);
  assert.equal((await git(s.root, ["status", "--porcelain"])).trim(), s.status);
  const artifact = requester.posts.find(
    (p) => p.path === "/v1/artifacts",
  )!.body;
  const taskSpec = requester.posts.find((p) => p.path === "/v1/tasks")!.body;
  assert.deepEqual(
    artifact.files.map((f: { path: string }) => f.path),
    ["request.json", "request.md"],
  );
  assert.equal(JSON.parse(artifact.files[0].content).layout, "tree");
  assert.equal(taskSpec.baseCommit, requestCommit);
  assert.equal(taskSpec.gitRequest.sourceCommit, s.sourceHead);
  assert.equal(
    receipt.requestUrl,
    `https://github.com/${repository}/blob/${requestCommit}/request.md`,
  );

  // ---- Worker: the task as the server would show it to the accepted worker.
  const workerId = randomUUID();
  const taskId = requester.taskId;
  let state = "OPEN",
    version = 1,
    generation = 0,
    assignee: string | null = null;
  const calls: { path: string; body?: any }[] = [];
  const view = () => ({
    id: taskId,
    title: taskSpec.title,
    requestCategory: taskSpec.requestCategory,
    rewardTig: taskSpec.rewardTig,
    state,
    version,
    generation,
    executionDeadlineAt: taskSpec.executionDeadlineAt,
    createdAt: new Date().toISOString(),
    aiRequirement: taskSpec.aiRequirement,
    requestUrl: receipt.requestUrl,
    requesterId: requester.userId,
    projectId: taskSpec.projectId,
    workerId: assignee,
    phaseDueAt: null,
    reviewDueAt: null,
    developmentFixture: false,
    layout: "tree",
    gitRequest: taskSpec.gitRequest,
    artifacts: [
      {
        id: randomUUID(),
        base_commit: artifact.baseCommit,
        summary: artifact.summary,
        files: artifact.files,
        deleted_paths: artifact.deletedPaths,
        manifest_hash: artifact.manifestHash,
      },
    ],
  });
  const api: typeof workServices.api = async (path, options) => {
    calls.push({ path, body: options?.body });
    if (path === "/v1/me") return { id: workerId };
    if (path === "/v1/tasks") return { tasks: [view()] };
    if (path === `/v1/tasks/${taskId}`) {
      const v = view();
      if (assignee !== workerId) delete (v as any).artifacts;
      return v;
    }
    if (path === `/v1/tasks/${taskId}/claim`) {
      assert.equal((options?.body as any)?.consent, "accept_this_task");
      state = "CLAIMED";
      version++;
      generation = 1;
      assignee = workerId;
      return view();
    }
    if (path === `/v1/tasks/${taskId}/start`) {
      state = "EXECUTING";
      version++;
      return view();
    }
    if (path === `/v1/tasks/${taskId}/heartbeat`) {
      version++;
      return view();
    }
    if (path === `/v1/tasks/${taskId}/submit`) {
      state = "AWAITING_REVIEW";
      version++;
      return view();
    }
    throw new Error("unexpected " + path);
  };
  const codex = await fakeCodex(s.temp);
  const workerGit: RequesterServices = {
    ...requester.services,
    githubIdentity: async () => "worker",
  };
  const ui = terminal();
  const result = await marketWork(
    taskId,
    ui.ui,
    undefined,
    {
      ...workServices,
      api,
      loadConnection: async () => ({
        origin: "http://localhost:4173",
        token: "fixture",
        deviceId: randomUUID(),
      }),
      findExecutable: async (name) => (name === "codex" ? codex.bin : null),
      codexReadiness: async () => {},
      readCodexModels: async () => models,
      // Production clones https://github.com/<repo>.git; here the same bare repo.
      prepareWorkspace: (o) => {
        assert.equal(o.source, `https://github.com/${repository}.git`);
        assert.equal(o.branch, branch);
        assert.equal(o.baseCommit, requestCommit);
        return workServices.prepareWorkspace({
          ...o,
          source: `file://${s.origin}`,
        });
      },
      publishResult: (input) => publishWorkerResult(input, workerGit),
    },
    { provider: "codex", assumeYes: true },
  );
  assert.equal(result.submitted, true);
  assert.equal(result.state, "AWAITING_REVIEW");
  assert.equal((result as any).mirrored, true);
  assert.equal((result as any).mode, "agentic");

  // ---- The result branch in the local "GitHub": on top of the request commit,
  // with the edit, the new file and the untouched request documents.
  const resultBranch = `tig/results/${taskId}`;
  const resultCommit = (
    await git(s.origin, ["rev-parse", `refs/heads/${resultBranch}`])
  ).trim();
  assert.equal(
    (await git(s.origin, ["rev-parse", `${resultCommit}^`])).trim(),
    requestCommit,
  );
  assert.equal(await git(s.origin, ["show", `${resultCommit}:math.js`]), FIXED);
  assert.equal(
    await git(s.origin, ["show", `${resultCommit}:CHANGELOG.md`]),
    "- add returns the sum\n",
  );
  for (const doc of ["request.md", "request.json"])
    assert.equal(
      await git(s.origin, ["show", `${resultCommit}:${doc}`]),
      await git(s.origin, ["show", `${requestCommit}:${doc}`]),
    );
  assert.equal(
    (
      await git(s.origin, [
        "diff-tree",
        "-r",
        "--name-status",
        requestCommit,
        resultCommit,
      ])
    ).trim(),
    "A\tCHANGELOG.md\nM\tmath.js",
  );
  for (const c of [requestCommit, resultCommit])
    assert(
      !(await git(s.origin, ["ls-tree", "-r", "--name-only", c])).includes(
        ".env",
      ),
      "the protected file is in neither branch",
    );
  // gh was asked for exactly one pull request against the request branch.
  const ghCalls = await s.gh.calls();
  assert.equal(ghCalls.length, 1);
  assert.deepEqual(ghCalls[0].slice(0, 8), [
    "pr",
    "create",
    "--repo",
    repository,
    "--base",
    branch,
    "--head",
    resultBranch,
  ]);

  // ---- The platform submission mirrors the diff and points at the PR.
  const submit = calls.find((c) => c.path.endsWith("/submit"))!.body;
  assert.deepEqual(
    submit.artifact.files.map((f: { path: string }) => f.path),
    ["code/CHANGELOG.md", "code/math.js", "report.md"],
  );
  assert.equal(
    submit.artifact.files.find((f: any) => f.path === "code/math.js").content,
    FIXED,
  );
  assert.deepEqual(submit.artifact.deletedPaths, []);
  assert.equal(submit.artifact.baseCommit, requestCommit);
  assert.equal(
    submit.artifact.manifestHash,
    packageManifest(submit.artifact.files, []),
  );
  assert.equal(submit.report, codex.report.summary);
  assert.deepEqual(submit.execution, {
    provider: "codex",
    model: "gpt-6-astra",
    effort: "medium",
  });
  assert.deepEqual(submit.gitResult, {
    repository,
    branch: resultBranch,
    commit: resultCommit,
    pullRequestUrl: "https://github.com/example/delivery/pull/7",
  });
  const report = submit.artifact.files.find(
    (f: any) => f.path === "report.md",
  ).content;
  assert.match(report, /Mirrored in the platform: yes/);
  assert.match(report, /- modified: math\.js/);
  assert.match(report, /- added: CHANGELOG\.md/);
  assert.match(report, /Mode: agentic in workspace/);
  assert.doesNotMatch(report, /do-not-publish/);
  // Claim → start → one heartbeat cycle at most → submit, in that order.
  assert.deepEqual(
    calls
      .map((c) => c.path.split("/").at(-1))
      .filter((p) => ["claim", "start", "submit"].includes(p!)),
    ["claim", "start", "submit"],
  );
  assert(
    ui.log.some((m) =>
      /Pull request: https:\/\/github\.com\/example\/delivery\/pull\/7/.test(m),
    ),
  );
});
