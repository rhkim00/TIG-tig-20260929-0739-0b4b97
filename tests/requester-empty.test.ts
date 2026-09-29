import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { git } from "../apps/cli/src/drafts.js";
import {
  initRequester,
  prepareRequest,
  type RequesterServices,
} from "../apps/cli/src/requester.js";
// P-036: AI-centred project creation is in scope. A folder with no shareable
// files must still prepare a request; only request.md/request.json are shared.
const newProjectSpec = () => ({
  title: "Create ten coding-test practice problems",
  requestCategory: "build",
  originalRequest: "코딩테스트를 준비하기 위한 문제들 10개 만들어줘. 100 TIG.",
  context:
    "The repository is empty. Build a practice set of ten coding-test problems from scratch.",
  completedWork: "Nothing exists yet; the repository has only an empty commit.",
  scope:
    "Create problems/01.md through problems/10.md, each with a statement, input/output format, two examples and constraints.",
  constraints: ["Markdown only; no external dependencies"],
  setupSteps: ["No setup; the repository starts empty"],
  testSteps: ["ls problems | wc -l prints 10"],
  acceptanceChecks: [
    "Exactly ten files exist under problems/",
    "Every problem lists statement, format, two examples and constraints",
  ],
  aiRequirement: {
    provider: "codex",
    model: "user-requested-model",
    effort: "user-requested-effort",
    source: "declared",
  },
  rewardTig: "100",
  executionDeadlineAt: new Date(Date.now() + 86400000).toISOString(),
});
test("an empty project prepares a documents-only new-project request", async () => {
  const temp = await mkdtemp(join(tmpdir(), "tig-empty-request-"));
  const previous = process.env.TIG_STATE_DIR;
  process.env.TIG_STATE_DIR = join(temp, "state");
  try {
    const root = join(temp, "source");
    await mkdir(root);
    await git(root, ["init", "--template="]);
    await git(root, ["config", "user.name", "Requester Test"]);
    await git(root, ["config", "user.email", "requester@example.invalid"]);
    await git(root, [
      "commit",
      "--allow-empty",
      "-m",
      "Initialize project for Tokenisgold",
    ]);
    const userId = randomUUID(),
      projectId = randomUUID();
    const services: RequesterServices = {
      origin: async () => "http://localhost:4173",
      githubIdentity: async () => "test",
      api: async (path) =>
        path === "/v1/me" ? { id: userId } : { id: projectId },
      repository: async (name) => ({
        id: "42",
        repository: name,
        public: true,
        push: true,
      }),
      createRepository: async () => {},
      push: async () => {
        throw new Error("prepare must not upload");
      },
    };
    await initRequester({ project: root }, services);
    const specPath = join(temp, "input.json");
    await writeFile(specPath, JSON.stringify(newProjectSpec()));
    const preview = await prepareRequest(
      { project: root, spec: specPath },
      services,
    );
    const shared = preview.files.map((f: { path: string }) => f.path).sort();
    assert.deepEqual(shared, ["request.json", "request.md"]);
    // Tree layout with nothing in the working tree: the parentless request
    // commit is exactly the two documents, and the summary says so.
    assert.equal(preview.layout, "tree");
    const tree = (
      await git(preview.localGit, [
        "ls-tree",
        "-r",
        "--name-only",
        preview.commit,
      ])
    )
      .trim()
      .split("\n")
      .sort();
    assert.deepEqual(tree, ["request.json", "request.md"]);
    assert.equal(
      (
        await git(preview.localGit, [
          "rev-list",
          "--parents",
          "-n",
          "1",
          preview.commit,
        ])
      )
        .trim()
        .split(" ").length,
      1,
    );
    assert.equal(preview.tree!.fileCount, 2);
    assert.deepEqual(preview.tree!.changed, {
      modified: 0,
      added: 0,
      untracked: 0,
      deleted: 0,
    });
    assert.deepEqual(preview.excluded, []);
    assert.equal(
      dirname(preview.requestFile),
      dirname(preview.localGit) + "/documents",
    );
  } finally {
    if (previous === undefined) delete process.env.TIG_STATE_DIR;
    else process.env.TIG_STATE_DIR = previous;
    await rm(temp, { recursive: true, force: true });
  }
});
