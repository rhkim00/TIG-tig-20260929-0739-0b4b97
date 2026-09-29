import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdir,
  readFile,
  writeFile,
  open,
  unlink,
  lstat,
  access,
} from "node:fs/promises";
import { basename, join, dirname, delimiter } from "node:path";
import { homedir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import {
  artifactSchema,
  projectSchema,
  taskSpec,
  cents,
} from "../../../packages/contracts/src/index.js";
import {
  safePath,
  containsSecret,
  protectedPathReason,
} from "../../../packages/contracts/src/files.js";
import {
  buildRequestTree,
  commitParents,
  globalRewritesGithub,
  NULL_DEVICE,
  scanRequestCommit,
  secretGateRefusal,
  treeEntries,
  treeSummarySchema,
  type Selection,
} from "./request-tree.js";
import { partitionHits, type SecretAcceptance } from "./secret-gate.js";
import {
  requestInput,
  requestEnvelope,
  renderRequest,
  requestTaskFields,
} from "../../../packages/contracts/src/request.js";
import {
  capture,
  projectRoot,
  git,
  stateDir,
  digest,
  atomicJson,
} from "./drafts.js";
import { api, loadConnection } from "./client.js";
import { requesterInstructions } from "./request-instructions.js";
const exec = promisify(execFile);
const repoName = projectSchema.shape.repository;
const uuid = z.uuid();
export interface DeliveryRepo {
  id: string;
  repository: string;
  public: boolean;
  push: boolean;
}
export interface RequesterServices {
  api: typeof api;
  origin(): Promise<string>;
  githubIdentity(): Promise<string>;
  repository(name: string): Promise<DeliveryRepo>;
  createRepository(name: string, description?: string): Promise<void>;
  push(
    directory: string,
    repository: string,
    branch: string,
    commit: string,
  ): Promise<void>;
}
export async function ghPath() {
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(dir, process.platform === "win32" ? "gh.exe" : "gh");
    try {
      await access(candidate);
      return candidate;
    } catch {
      /* Try next PATH entry. */
    }
  }
  const local = join(
    homedir(),
    ".local",
    "bin",
    process.platform === "win32" ? "gh.exe" : "gh",
  );
  try {
    await access(local);
    return local;
  } catch {
    return "gh";
  }
}
export async function gh(args: string[]) {
  try {
    return (
      await exec(await ghPath(), args, {
        maxBuffer: 64_000_000,
        timeout: 60000,
        env: { ...process.env, GH_PROMPT_DISABLED: "1" },
      })
    ).stdout;
  } catch {
    // Never forward captured subprocess output, which can contain credentials.
    throw new Error(
      "GitHub command failed. Check gh auth status, repository name and write permission, then retry.",
    );
  }
}
export const requesterServices: RequesterServices = {
  api,
  origin: async () => (await loadConnection()).origin,
  githubIdentity: async () =>
    JSON.parse(await gh(["api", "--hostname", "github.com", "user"])).login,
  repository: async (name) => {
    repoName.parse(name);
    const r = JSON.parse(
      await gh(["api", "--hostname", "github.com", `repos/${name}`]),
    );
    if (!Number.isSafeInteger(r.id) || !repoName.safeParse(r.full_name).success)
      throw new Error("GitHub returned an invalid repository.");
    return {
      id: String(r.id),
      repository: r.full_name,
      public: r.private === false && r.visibility === "public",
      push: r.permissions?.push === true,
    };
  },
  createRepository: async (name, description) => {
    repoName.parse(name);
    // An empty repository: the request commit becomes its main branch, so the
    // landing page is request.md and the project as the requester had it.
    await gh([
      "repo",
      "create",
      `github.com/${name}`,
      "--public",
      "--description",
      description ??
        "Tokenisgold request: request.md, request.json and the requester's project files on main.",
    ]);
  },
  push: async (directory, repository, branch, commit) => {
    repoName.parse(repository);
    const path = await ghPath();
    const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
    const url = `https://github.com/${repository}.git`;
    // A global insteadOf rule rewriting github.com would send the push elsewhere;
    // only then is the global config dropped (system config always stays).
    const dropGlobal = await globalRewritesGithub(url);
    try {
      await exec(
        "git",
        [
          "-C",
          directory,
          "-c",
          "credential.helper=",
          "-c",
          `credential.helper=!${quote(path)} auth git-credential`,
          "push",
          "--porcelain",
          url,
          `${commit}:refs/heads/${branch}`,
        ],
        {
          maxBuffer: 64_000_000,
          // A whole working tree can be large; 30 minutes instead of 2.
          timeout: 30 * 60 * 1000,
          env: {
            ...process.env,
            ...(dropGlobal ? { GIT_CONFIG_GLOBAL: NULL_DEVICE } : {}),
            GIT_TERMINAL_PROMPT: "0",
            GH_PROMPT_DISABLED: "1",
          },
        },
      );
    } catch {
      throw new Error(
        "Git push did not complete. Check GitHub permission/network and retry the same request ID. No force push is used.",
      );
    }
  },
};
// The project's connection: which account and server it was connected to. A
// repository is no longer chosen here — every request creates its own at
// publish time — so the three repository fields only remain readable for a
// project connected by an earlier tig.
const configSchema = z
  .object({
    version: z.literal(1),
    root: z.string(),
    origin: z.string(),
    userId: z.uuid(),
    repository: repoName.optional(),
    repositoryId: z.string().optional(),
    projectId: z.uuid().optional(),
    destination: z.enum(["origin", "delivery"]).optional(),
  })
  .strict();
export type RequestLayout = "bundle" | "tree";
// Tree layout is the default; TIG_REQUEST_LAYOUT=bundle keeps the code/ snapshot.
export const requestLayout = (): RequestLayout =>
  process.env.TIG_REQUEST_LAYOUT === "bundle" ? "bundle" : "tree";
const configPath = (root: string) =>
  join(stateDir(), "projects", digest(root) + ".json");
const requestDir = (id: string) => join(stateDir(), "requests", uuid.parse(id));
// Every request is its own PUBLIC repository under the requester's GitHub
// account, created only when they say yes. The request commit is its main
// branch, so the landing page is request.md and the project as they had it.
export const REQUEST_BRANCH = "main";
// The name carries the project folder, the day and minute, and the request
// id's first characters: a list of them reads in order and never collides.
export function requestRepositoryName(
  login: string,
  root: string,
  id: string,
  at = new Date(),
) {
  const slug =
    basename(root)
      .replace(/[^A-Za-z0-9_.-]+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "")
      .slice(0, 50) || "project";
  const stamp = at
    .toISOString()
    .replace(/[-:]/g, "")
    .slice(0, 13)
    .replace("T", "-");
  return repoName.parse(`${login}/${slug}-tig-${stamp}-${id.slice(0, 6)}`);
}
const immutableSchema = z
  .object({
    version: z.literal(1),
    id: z.uuid(),
    origin: z.string(),
    userId: z.uuid(),
    repository: repoName,
    // Set by an earlier tig, which published every request of a project into one
    // fixed repository. A request of its own repository has neither: the
    // repository and the platform project come into being at publish time and
    // are recorded on the plan, outside the reviewed digest.
    repositoryId: z.string().optional(),
    projectId: z.uuid().optional(),
    branch: z.string().regex(/^(?:main|tig\/requests\/[a-f0-9-]{36})$/),
    commit: z.string().regex(/^[a-f0-9]{40}$/),
    envelope: requestEnvelope,
    artifact: artifactSchema,
    excluded: z.array(z.object({ path: z.string(), reason: z.string() })),
    untrackedNotShared: z.array(z.string()),
    // Present for layout "tree" only; a bundle plan keeps its previous bytes.
    layout: z.enum(["bundle", "tree"]).optional(),
    // "new": a repository of this request's own (created at publish).
    destination: z.enum(["origin", "delivery", "new"]).optional(),
    tree: treeSummarySchema.optional(),
  })
  .strict();
type Immutable = z.infer<typeof immutableSchema>;
const planSchema = z
  .object({
    immutable: immutableSchema,
    previewDigest: z.string().regex(/^[a-f0-9]{64}$/),
    pushed: z.boolean(),
    // The repository created for this request and the platform project that
    // registers it, both recorded once they exist so a retry reuses them.
    repositoryId: z.string().optional(),
    projectId: z.uuid().optional(),
    artifactId: z.uuid().optional(),
    receipt: z
      .object({ taskId: z.uuid(), taskUrl: z.string(), requestUrl: z.string() })
      .optional(),
  })
  .strict();
type Plan = z.infer<typeof planSchema>;
const savePlan = (p: Plan) =>
  atomicJson(join(requestDir(p.immutable.id), "plan.json"), p);
async function readPlan(id: string) {
  const p = planSchema.parse(
    JSON.parse(await readFile(join(requestDir(id), "plan.json"), "utf8")),
  );
  if (
    p.immutable.id !== id ||
    p.previewDigest !== digest(JSON.stringify(p.immutable))
  )
    throw new Error(
      "Prepared request changed. Prepare and review a new snapshot before publishing.",
    );
  return p;
}
async function account(s: RequesterServices) {
  return {
    origin: await s.origin(),
    user: z
      .object({ id: z.uuid() })
      .passthrough()
      .parse(await s.api("/v1/me")),
  };
}
function usable(repo: DeliveryRepo) {
  if (!repo.public)
    throw new Error(
      "Only PUBLIC delivery repositories are supported. Private repositories will not be changed. Use a separate public delivery repository after reviewing what will be shared.",
    );
  if (!repo.push)
    throw new Error(
      "The signed-in GitHub account needs push permission on the delivery repository.",
    );
}
async function installInstructions(root: string) {
  const guide = join(root, "TOKENISGOLD.md");
  const additions = [
    { path: guide, text: requesterInstructions, guide: true },
    ...["AGENTS.md", "CLAUDE.md"].map((name) => ({
      path: join(root, name),
      guide: false,
      text: "\n<!-- tokenisgold-requester-v1 -->\nFor Tokenisgold task requests, read TOKENISGOLD.md and run `tig instructions` before preparing or publishing.\n<!-- /tokenisgold-requester-v1 -->\n",
    })),
  ];
  // Validate all destinations before changing any existing instructions.
  const changes: { path: string; text: string; exists: boolean }[] = [];
  for (const a of additions) {
    let old = "",
      exists = false;
    try {
      const stat = await lstat(a.path);
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new Error(
          "Instruction destination must be a regular file: " + a.path,
        );
      old = await readFile(a.path, "utf8");
      exists = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (a.guide && exists && old !== a.text)
      throw new Error(
        "TOKENISGOLD.md already exists with different content; review it before installing instructions.",
      );
    if (
      a.guide
        ? old === a.text
        : old.includes("<!-- tokenisgold-requester-v1 -->")
    )
      continue;
    changes.push({
      path: a.path,
      text: a.guide ? a.text : old + a.text,
      exists,
    });
  }
  for (const c of changes)
    await writeFile(c.path, c.text, {
      flag: c.exists ? "w" : "wx",
      mode: 0o600,
    });
}
export async function initRequester(
  options: { project: string; installInstructions?: boolean },
  s = requesterServices,
) {
  const root = await projectRoot(options.project);
  await git(root, ["rev-parse", "HEAD"]); // Unborn projects need an explicit first source commit.
  const a = await account(s),
    githubUser = await s.githubIdentity();
  const config = configSchema.parse({
    version: 1,
    root,
    origin: a.origin,
    userId: a.user.id,
  });
  await atomicJson(configPath(root), config);
  if (options.installInstructions) await installInstructions(root);
  return {
    connected: true,
    githubUser,
    visibility: "PUBLIC",
    uploaded: false,
    instructionsInstalled: !!options.installInstructions,
    next: `Run tig, or ask your existing AI to read tig instructions, prepare the request JSON, and run tig request prepare. Each published request becomes a new PUBLIC repository under github.com/${githubUser}.`,
  };
}
function gitBlob(content: string) {
  return createHash("sha1")
    .update(`blob ${Buffer.byteLength(content)}\0`)
    .update(content)
    .digest("hex");
}
function manifest(files: Immutable["artifact"]["files"]) {
  // Same canonical order as the existing artifact contract (keys sorted alphabetically).
  return digest(
    JSON.stringify(
      files
        .map((f) => ({ path: f.path, sha256: f.sha256, source: f.source }))
        .sort((a, b) => a.path.localeCompare(b.path)),
    ),
  );
}
export async function prepareRequest(
  options: {
    project: string;
    spec: string;
    include?: string[];
    selectedPaths?: string[];
    // The requester's own answer about new (untracked) files, when they were
    // asked one: only these untracked paths may be published, and an empty
    // array means none of them may. Absent (the automatic flow never asks) the
    // new-file rule decides alone, so nothing here can widen what travels.
    approvedUntracked?: string[];
    // Files held back by the secret gate that the requester named on the review
    // screen, with the pattern classes they were shown next to each path. Only
    // these travel; every other match stays out of the branch.
    publishSecret?: SecretAcceptance[];
    expectedManifestHash?: string;
  },
  s = requesterServices,
) {
  const root = await projectRoot(options.project);
  let config: z.infer<typeof configSchema>;
  try {
    config = configSchema.parse(
      JSON.parse(await readFile(configPath(root), "utf8")),
    );
  } catch {
    throw new Error("Run tig (or tig init) in this project first.");
  }
  const a = await account(s);
  if (
    a.origin !== config.origin ||
    a.user.id !== config.userId ||
    config.root !== root
  )
    throw new Error(
      "The connected Tokenisgold account or server changed. Run tig init again.",
    );
  const input = requestInput.parse(
    JSON.parse(await readFile(options.spec, "utf8")),
  );
  if (Date.parse(input.executionDeadlineAt) <= Date.now())
    throw new Error("Choose a future completion deadline.");
  const draft = await capture(root, {
    summary: input.context,
    approvedUntracked: options.include ?? [],
    selectedPaths: options.selectedPaths,
  });
  if (
    options.expectedManifestHash &&
    draft.artifact.manifestHash !== options.expectedManifestHash
  )
    throw new Error(
      "Project files changed during drafting. Run tig again to review the updated code.",
    );
  const layout = requestLayout();
  const id = randomUUID(),
    directory = requestDir(id),
    snapshot = join(directory, "snapshot");
  // This request's own repository, named now so request.md can say where it
  // lives; created only when the requester publishes.
  const repository = requestRepositoryName(await s.githubIdentity(), root, id);
  const name = (await git(root, ["config", "user.name"])).trim(),
    email = (await git(root, ["config", "user.email"])).trim();
  if (!name || !email)
    throw new Error(
      "Configure your Git commit name and email before preparing.",
    );
  if (layout === "tree")
    return prepareTree({
      root,
      repository,
      account: a,
      input,
      sourceCommit: draft.baseCommit,
      id,
      directory,
      author: { name, email },
      selection: {
        untracked: options.approvedUntracked,
        publishSecret: options.publishSecret,
      },
    });
  // An empty snapshot is a new-project request (P-036): only request.md and
  // request.json are published. The preview/approve step remains the guard.
  if (draft.artifact.files.length > 98)
    throw new Error(
      "At most 98 source files fit alongside request.md/request.json. Select a smaller project.",
    );
  if (draft.excluded.some((f) => f.reason === "development package size limit"))
    throw new Error(
      "Package exceeds the development limit; do not publish a silently truncated snapshot.",
    );
  const envelope = requestEnvelope.parse({
    version: 1,
    id,
    repository,
    sourceCommit: draft.baseCommit,
    request: input,
  });
  const documents = [
    { path: "request.md", content: renderRequest(envelope) },
    { path: "request.json", content: JSON.stringify(envelope, null, 2) + "\n" },
  ];
  const files = [
    ...draft.artifact.files.map((f) => ({ ...f, path: `code/${f.path}` })),
    ...documents.map((f) => ({
      ...f,
      sha256: digest(f.content),
      source: "tracked" as const,
    })),
  ].sort((a, b) => a.path.localeCompare(b.path));
  if (
    files.some(
      (f) =>
        !safePath(f.path) ||
        containsSecret(f.content) ||
        Buffer.byteLength(f.content) > 200000,
    ) ||
    files.reduce((n, f) => n + Buffer.byteLength(f.content), 0) > 1_000_000
  )
    throw new Error(
      "Request package exceeds file/size limits or contains sensitive content. Nothing was uploaded.",
    );
  // Source index, branch and history are never staged, committed or pushed.
  await mkdir(snapshot, { recursive: true, mode: 0o700 });
  await git(snapshot, [
    "init",
    "--template=",
    "--initial-branch",
    REQUEST_BRANCH,
  ]);
  for (const f of files) {
    await mkdir(dirname(join(snapshot, f.path)), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(join(snapshot, f.path), f.content, {
      flag: "wx",
      mode: 0o600,
    });
  }
  // Configure only the newly generated delivery repo. Its content is never executed.
  await git(snapshot, [
    "config",
    "core.hooksPath",
    join(directory, "no-hooks"),
  ]);
  await git(snapshot, ["config", "core.autocrlf", "false"]);
  await git(snapshot, ["config", "commit.gpgsign", "false"]);
  await git(snapshot, ["config", "user.name", name]);
  await git(snapshot, ["config", "user.email", email]);
  await git(snapshot, ["add", "--", ...files.map((f) => f.path)]);
  await git(snapshot, ["commit", "-m", `Tokenisgold request ${id}`]);
  const commit = (await git(snapshot, ["rev-parse", "HEAD"])).trim();
  // A set: the automatic flow approves every untracked path, thousands in a big repo.
  const included = new Set(options.include ?? []);
  const untracked = (
    await git(root, ["ls-files", "--others", "--exclude-standard", "-z"])
  )
    .split("\0")
    .filter((p) => p && !included.has(p));
  const immutable = immutableSchema.parse({
    version: 1,
    id,
    origin: a.origin,
    userId: a.user.id,
    repository,
    branch: REQUEST_BRANCH,
    commit,
    envelope,
    artifact: {
      baseCommit: commit,
      summary: input.context,
      files,
      deletedPaths: [],
      manifestHash: manifest(files),
    },
    excluded: [
      ...draft.excluded,
      ...draft.artifact.deletedPaths.map((path) => ({
        path,
        reason: "deleted in source; absent from snapshot",
      })),
    ],
    untrackedNotShared: untracked,
    destination: "new",
  });
  const plan: Plan = {
    immutable,
    previewDigest: digest(JSON.stringify(immutable)),
    pushed: false,
  };
  await savePlan(plan);
  return showRequest(id);
}
// Layout "tree": the whole working state becomes a parentless commit built in a
// temporary index (source .git untouched); the artifact sent to the server holds
// only the two documents, and request.json says layout "tree".
async function prepareTree(o: {
  root: string;
  repository: string;
  account: Awaited<ReturnType<typeof account>>;
  input: z.infer<typeof requestInput>;
  sourceCommit: string;
  id: string;
  directory: string;
  author: { name: string; email: string };
  selection?: Selection;
}) {
  const envelope = requestEnvelope.parse({
    version: 1,
    id: o.id,
    repository: o.repository,
    sourceCommit: o.sourceCommit,
    layout: "tree",
    request: o.input,
  });
  const documents = [
    { path: "request.md", content: renderRequest(envelope) },
    { path: "request.json", content: JSON.stringify(envelope, null, 2) + "\n" },
  ];
  const files = documents
    .map((f) => ({
      ...f,
      sha256: digest(f.content),
      source: "tracked" as const,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
  if (files.some((f) => !safePath(f.path) || containsSecret(f.content)))
    throw new Error(
      "The request documents contain sensitive content. Nothing was uploaded.",
    );
  const docs = join(o.directory, "documents");
  await mkdir(docs, { recursive: true, mode: 0o700 });
  for (const f of documents)
    await writeFile(join(docs, f.path), f.content, { flag: "wx", mode: 0o600 });
  const built = await buildRequestTree({
    root: o.root,
    directory: o.directory,
    id: o.id,
    documents,
    author: o.author,
    selection: o.selection,
    branch: REQUEST_BRANCH,
  });
  const immutable = immutableSchema.parse({
    version: 1,
    id: o.id,
    origin: o.account.origin,
    userId: o.account.user.id,
    repository: o.repository,
    branch: REQUEST_BRANCH,
    commit: built.commit,
    envelope,
    artifact: {
      baseCommit: built.commit,
      summary: o.input.context,
      files,
      deletedPaths: [],
      manifestHash: manifest(files),
    },
    excluded: built.excluded,
    // Tree layout: the new files the requester refused. Kept in full (not the
    // capped list on the summary) because the publish step checks the tree
    // against it — work the user said no to must not reach a PUBLIC branch.
    // Untracked paths a rule left out are disclosed by the tree summary
    // (skippedCount / skippedDirs), not here.
    untrackedNotShared: built.refusedPaths,
    layout: "tree",
    destination: "new",
    tree: built.tree,
  });
  const plan: Plan = {
    immutable,
    previewDigest: digest(JSON.stringify(immutable)),
    pushed: false,
  };
  await savePlan(plan);
  return showRequest(o.id);
}
const localGitDir = (i: Immutable) =>
  join(requestDir(i.id), i.layout === "tree" ? "push.git" : "snapshot");
export async function showRequest(id: string) {
  const p = await readPlan(id),
    i = p.immutable;
  const layout = i.layout ?? "bundle";
  return {
    requestId: id,
    repository: i.repository,
    visibility: "PUBLIC",
    layout,
    destination: i.destination ?? "delivery",
    branch: i.branch,
    commit: i.commit,
    title: i.envelope.request.title,
    scope: i.envelope.request.scope,
    completedWork: i.envelope.request.completedWork,
    acceptanceChecks: i.envelope.request.acceptanceChecks,
    aiRequirement: i.envelope.request.aiRequirement,
    rewardTig: i.envelope.request.rewardTig,
    executionDeadlineAt: i.envelope.request.executionDeadlineAt,
    requestFile: join(
      requestDir(id),
      layout === "tree" ? "documents" : "snapshot",
      "request.md",
    ),
    // The local Git directory the branch is pushed from (never the source .git).
    localGit: localGitDir(i),
    files: i.artifact.files.map((f) => ({
      path: f.path,
      bytes: Buffer.byteLength(f.content),
      sha256: f.sha256,
    })),
    tree: i.tree ?? null,
    excluded: i.excluded,
    untrackedNotShared: i.untrackedNotShared,
    previewDigest: p.previewDigest,
    gitPublished: p.pushed,
    receipt: p.receipt ?? null,
    next: p.receipt
      ? "Published. Use tig task <taskId> or open the task URL."
      : `After reviewing and authorizing this PUBLIC snapshot: tig request publish ${id} --approve ${p.previewDigest} --yes`,
  };
}
// The reviewed commit is what gets pushed: parentless, the two documents at the
// root exactly as the artifact carries them, and no protected path anywhere.
// The secret gate runs over the same commit right after this (verifyLocalSnapshot).
async function verifyRequestTree(i: Immutable) {
  const pushDir = localGitDir(i);
  if ((await commitParents(pushDir, i.commit)).length)
    throw new Error("Request commit must not include source Git history.");
  const rows = await treeEntries(pushDir, i.commit);
  const expected = new Map(
    i.artifact.files.map((f) => [f.path, gitBlob(f.content)]),
  );
  if (expected.size !== 2)
    throw new Error("A tree request registers exactly the two documents.");
  for (const [path, sha] of expected) {
    const row = rows.find((r) => r.path === path);
    if (!row || row.mode !== "100644" || row.type !== "blob" || row.sha !== sha)
      throw new Error("Git request tree differs from the reviewed documents.");
  }
  const leaked = rows.find((r) => protectedPathReason(r.path));
  if (leaked)
    throw new Error(
      `Protected path in the request tree: ${leaked.path}. Prepare the request again.`,
    );
  // The requester's own "no" is checked against the commit, like a protected
  // path: a refused new file must never be pushed to a PUBLIC branch.
  const refused = new Set(i.untrackedNotShared);
  if (refused.size) {
    const kept = rows.find((r) => refused.has(r.path));
    if (kept)
      throw new Error(
        `New file you chose not to share is in the request tree: ${kept.path}. Prepare the request again.`,
      );
  }
}
// The last thing that happens before any byte leaves this machine. The layout
// check says the commit is the one that was reviewed; the gate then reads that
// commit's own blobs and refuses a publish whose bytes look like a secret. Both
// layouts go through here, so there is no publish path that skips the gate.
async function verifyLocalSnapshot(i: Immutable) {
  if (i.layout === "tree") await verifyRequestTree(i);
  else await verifyBundleSnapshot(i);
  const scan = await scanRequestCommit({
    // Tree: a bare push repository. Bundle: an ordinary checkout.
    gitDir: i.layout === "tree" ? localGitDir(i) : join(localGitDir(i), ".git"),
    commit: i.commit,
    // Earned by the check above: those two paths were just verified to be the
    // reviewed documents, blob for blob.
    documentPaths: i.artifact.files
      .filter((f) => f.path === "request.md" || f.path === "request.json")
      .map((f) => f.path),
  });
  // The gate still reads the whole commit; what the plan can do is say which
  // findings were already answered for. `secretPublished` is the list the review
  // screen printed, path and class, and readPlan has just checked that the plan
  // still hashes to the digest the requester approved — so this cannot be a list
  // that grew after the screen. Anything else refuses the publish, including a
  // hit at an accepted path in a class that was not on the screen: that is how a
  // tree swapped between approval and push is caught.
  const { refused } = partitionHits(scan.hits, i.tree?.secretPublished ?? []);
  if (refused.length) throw new Error(secretGateRefusal(refused));
}
async function verifyBundleSnapshot(i: Immutable) {
  const snapshot = join(requestDir(i.id), "snapshot");
  const parents = (
    await git(snapshot, ["rev-list", "--parents", "-n", "1", i.commit])
  )
    .trim()
    .split(" ");
  if (parents.length !== 1)
    throw new Error("Delivery commit must not include source Git history.");
  const rows = (await git(snapshot, ["ls-tree", "-r", "-z", i.commit]))
    .split("\0")
    .filter(Boolean);
  const expected = new Map(
    i.artifact.files.map((f) => [f.path, gitBlob(f.content)]),
  );
  if (rows.length !== expected.size)
    throw new Error("Git snapshot differs from the reviewed files.");
  for (const row of rows) {
    const tab = row.indexOf("\t"),
      [mode, type, sha] = row.slice(0, tab).split(" ");
    if (
      mode !== "100644" ||
      type !== "blob" ||
      expected.get(row.slice(tab + 1)) !== sha
    )
      throw new Error("Git snapshot differs from the reviewed files.");
  }
}
export async function publishRequest(
  id: string,
  approval: string,
  yes: boolean,
  s = requesterServices,
) {
  const lockPath = join(requestDir(id), "publishing.lock");
  if (!yes)
    throw new Error(
      "Publishing requires authorization for the previewed PUBLIC code and TIG escrow (--yes).",
    );
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error(
        `This request is already publishing. Retry when it finishes. After a crashed process, inspect and remove only ${lockPath}.`,
      );
    throw e;
  }
  try {
    const p = await readPlan(id),
      i = p.immutable;
    if (approval !== p.previewDigest)
      throw new Error(
        "Approval does not match the reviewed snapshot. Run tig request show and review before publishing.",
      );
    const a = await account(s);
    if (a.origin !== i.origin || a.user.id !== i.userId)
      throw new Error(
        "Reconnect the original Tokenisgold account/server to publish this request.",
      );
    if (p.receipt) return p.receipt;
    if (
      Date.parse(i.envelope.request.executionDeadlineAt) <= Date.now() &&
      !p.artifactId
    )
      throw new Error(
        "The deadline passed. Prepare a new request with a future deadline.",
      );
    if (!p.pushed) {
      // Everything that can refuse runs before a repository exists: a request
      // that is refused must not leave an empty public repository behind.
      const wallet = await s.api("/v1/wallet");
      if (cents(wallet.available) < cents(i.envelope.request.rewardTig))
        throw new Error(
          "Insufficient TIG. Nothing new was pushed by this attempt.",
        );
      await verifyLocalSnapshot(i);
      if (i.repositoryId) {
        // An earlier tig's fixed repository: it must still be the one reviewed.
        const r = await s.repository(i.repository);
        usable(r);
        if (r.id !== i.repositoryId || r.repository !== i.repository)
          throw new Error(
            "Delivery repository identity changed. Reconnect and prepare a new request.",
          );
        p.repositoryId = r.id;
      } else if (!p.repositoryId) {
        // This request's own repository. A retry after a crash finds it already
        // there, so creation is allowed to fail as long as the repository is
        // then found, public and ours to push to.
        try {
          await s.createRepository(
            i.repository,
            `Tokenisgold request ${i.id}: ${i.envelope.request.title}`.slice(
              0,
              350,
            ),
          );
        } catch {
          /* may exist from an earlier attempt; checked next */
        }
        const r = await s.repository(i.repository);
        usable(r);
        if (r.repository !== i.repository)
          throw new Error(
            "GitHub returned a different repository than the one being created. Prepare the request again.",
          );
        p.repositoryId = r.id;
        await savePlan(p);
      }
      await s.push(localGitDir(i), i.repository, i.branch, i.commit);
      p.pushed = true;
      await savePlan(p);
    }
    if (!p.projectId) {
      // The platform project that registers this repository: one per request,
      // since the repository is.
      if (i.projectId) p.projectId = i.projectId;
      else {
        const project = await s.api("/v1/projects", {
          body: {
            repository: i.repository,
            projectType: "software",
            stack: [],
          },
          key: `request-project:${id}`,
        });
        p.projectId = z.uuid().parse(project.id);
      }
      await savePlan(p);
    }
    if (!p.artifactId) {
      const artifact = await s.api("/v1/artifacts", {
        body: i.artifact,
        key: `request-artifact:${id}`,
      });
      p.artifactId = z.uuid().parse(artifact.id);
      await savePlan(p);
    }
    const spec = taskSpec.parse({
      ...requestTaskFields(i.envelope.request),
      projectId: p.projectId,
      baseCommit: i.commit,
      handoffArtifactId: p.artifactId,
      packageManifestHash: i.artifact.manifestHash,
      gitRequest: {
        repository: i.repository,
        branch: i.branch,
        sourceCommit: i.envelope.sourceCommit,
        requestPath: "request.md",
      },
      commandApproval: {
        kind: "explicit_post",
        text: i.envelope.request.originalRequest,
      },
    });
    const task = await s.api("/v1/tasks", {
      body: spec,
      key: `request-post:${id}`,
    });
    p.receipt = {
      taskId: z.uuid().parse(task.id),
      taskUrl: `${i.origin}/?task=${task.id}`,
      requestUrl: `https://github.com/${i.repository}/blob/${i.commit}/request.md`,
    };
    await savePlan(p);
    return p.receipt;
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

export async function requesterConfig(root: string) {
  try {
    return configSchema.parse(
      JSON.parse(await readFile(configPath(root), "utf8")),
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(
      "Project connection is damaged. Use tig setup to reconnect.",
    );
  }
}
