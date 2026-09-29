// What request.md needs beyond the requester's own words, read from the project
// rather than written by a model: the fields requestInput requires (context,
// completedWork, setupSteps, testSteps) are facts about the folder — its
// branch, its recent commits, the files that say how it is installed and
// tested — and a category read off the request's own vocabulary. None of it is
// an estimate: a line is either observed here or a stated fallback that says
// nothing was found, and the review screen shows all of it before anything is
// published.
import { access, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { category as categorySchema } from "../../../packages/contracts/src/index.js";
import { containsSecret } from "../../../packages/contracts/src/files.js";
import { git } from "./drafts.js";

export type Category = ReturnType<typeof categorySchema.parse>;
export interface ProjectFacts {
  context: string;
  completedWork: string;
  setupSteps: string[];
  testSteps: string[];
}
const STEP_MAX = 500;
const LINE_MAX = 200;
const TOP_LEVEL_SHOWN = 12;
const RECENT_COMMITS = 5;
const clean = (text: string) =>
  text.replace(/\s+/g, " ").trim().slice(0, LINE_MAX);
// A commit subject or folder name that looks like a credential would fail the
// request's own secret check, so it is left out rather than published.
const safeLines = (lines: string[]) =>
  lines.map(clean).filter((l) => l.length >= 3 && !containsSecret(l));

// The request's category from its own words; "other" when none of them says.
// Rules, not inference: the same text always lands in the same category.
const CATEGORY_WORDS: [Category, RegExp][] = [
  [
    "bug",
    /버그|고쳐|고치|오류|에러|크래시|\b(?:bug|fix|error|crash|broken)\b/i,
  ],
  ["test", /테스트|\b(?:tests?|spec|coverage)\b/i],
  ["docs", /문서|주석|\b(?:docs?|readme|documentation|comments?)\b/i],
  [
    "setup",
    /설치|환경\s*설정|초기\s*설정|\b(?:setup|install|configure|bootstrap|scaffold)\b/i,
  ],
  ["review", /리뷰|검토|\b(?:review|audit)\b/i],
  [
    "refactor",
    /리팩터|리팩토링|정리|구조\s*개선|\b(?:refactor|cleanup|clean up|restructure)\b/i,
  ],
  ["build", /빌드|배포|파이프라인|\b(?:build|deploy|ci|pipeline|release)\b/i],
  [
    "feature",
    /추가|구현|만들|기능|\b(?:feature|add|implement|create|support)\b/i,
  ],
];
export function inferCategory(text: string): Category {
  for (const [category, re] of CATEGORY_WORDS)
    if (re.test(text)) return category;
  return "other";
}
// The title is the request's first line, cut to the field's length.
export function titleFromText(text: string): string {
  const first = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length >= 3);
  const line = (first ?? text.trim()).replace(/[.。!?]+$/u, "").trim();
  const base = line.length >= 3 ? line : text.trim();
  return base.length > 140 ? `${base.slice(0, 139)}…` : base;
}
// Acceptance checks from an answer: one per line or ";"-separated item, else one
// per sentence, else the whole answer as the single check. The requester wrote
// every one of them; tig only splits.
export function acceptanceFromText(text: string): string[] {
  const items = (parts: string[]) =>
    parts
      .map((p) => p.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
      .filter((p) => p.length >= 3)
      .map((p) => (p.length > STEP_MAX ? `${p.slice(0, STEP_MAX - 1)}…` : p));
  let checks = items(text.split(/\r?\n|;|；/));
  if (checks.length <= 1) {
    const sentences = items(text.split(/(?<=[.!?。])\s+/u));
    if (sentences.length > 1) checks = sentences;
  }
  if (!checks.length && text.trim().length >= 3) checks = items([text]);
  return checks.slice(0, 20);
}
async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
async function readJson(path: string): Promise<Record<string, any> | null> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}
// Setup and verification commands, from the files that declare them. The
// fallback lines say that nothing was found; they never invent a command.
export async function detectSteps(root: string) {
  const setup: string[] = [];
  const test: string[] = [];
  const has = (name: string) => exists(join(root, name));
  const pkg = await readJson(join(root, "package.json"));
  if (pkg) {
    const manager = (await has("pnpm-lock.yaml"))
      ? "pnpm"
      : (await has("yarn.lock"))
        ? "yarn"
        : (await has("bun.lockb")) || (await has("bun.lock"))
          ? "bun"
          : "npm";
    setup.push(`${manager} install`);
    const scripts = pkg.scripts ?? {};
    if (typeof scripts.test === "string" && scripts.test.trim())
      test.push(`${manager} test`);
    if (typeof scripts.typecheck === "string")
      test.push(`${manager} run typecheck`);
  }
  if (await has("requirements.txt"))
    setup.push("pip install -r requirements.txt");
  if (await has("pyproject.toml")) {
    let text = "";
    try {
      text = await readFile(join(root, "pyproject.toml"), "utf8");
    } catch {
      /* unreadable: no step from it */
    }
    setup.push(
      /\[tool\.poetry\]/.test(text) ? "poetry install" : "pip install -e .",
    );
    if (/\[tool\.pytest/.test(text)) test.push("pytest");
  }
  if (
    !test.includes("pytest") &&
    ((await has("pytest.ini")) || (await has("conftest.py")))
  )
    test.push("pytest");
  if (await has("Cargo.toml")) {
    setup.push("cargo build");
    test.push("cargo test");
  }
  if (await has("go.mod")) {
    setup.push("go mod download");
    test.push("go test ./...");
  }
  if (await has("Gemfile")) {
    setup.push("bundle install");
    if (await has("spec")) test.push("bundle exec rspec");
  }
  if (await has("Makefile")) {
    let text = "";
    try {
      text = await readFile(join(root, "Makefile"), "utf8");
    } catch {
      /* unreadable */
    }
    if (/^test\s*:/m.test(text)) test.push("make test");
  }
  return {
    setupSteps: setup.length
      ? [...new Set(setup)]
      : ["No install command was found in the project; follow its README."],
    testSteps: test.length
      ? [...new Set(test)]
      : [
          "No test command was found in the project; review the changed files against the acceptance checks.",
        ],
  };
}
const gitLine = async (root: string, args: string[]) =>
  (await git(root, args).catch(() => "")).trim();
export async function projectFacts(root: string): Promise<ProjectFacts> {
  const branch = await gitLine(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const head = await gitLine(root, ["rev-parse", "--short", "HEAD"]);
  const status = (
    await gitLine(root, ["status", "--porcelain", "--untracked-files=all"])
  )
    .split("\n")
    .filter(Boolean);
  const untracked = status.filter((l) => l.startsWith("??")).length;
  const changed = status.length - untracked;
  const tracked = (await gitLine(root, ["ls-files", "-z"]))
    .split("\0")
    .filter(Boolean);
  const top = [...new Set(tracked.map((p) => p.split("/")[0]))].sort();
  const shown = top.slice(0, TOP_LEVEL_SHOWN);
  const context = safeLines([
    `Project folder: ${basename(root)}.`,
    branch && head
      ? `Git: ${branch === "HEAD" ? "detached" : `branch ${branch}`} at ${head}; ${changed} changed and ${untracked} new file(s) not yet committed.`
      : "Git: no commits yet.",
    tracked.length
      ? `Tracked files: ${tracked.length}. Top level: ${shown.join(", ")}${top.length > shown.length ? `, … (${top.length} entries)` : ""}.`
      : "Tracked files: none.",
  ]).join(" ");
  const subjects = safeLines(
    (
      await gitLine(root, [
        "log",
        `-${RECENT_COMMITS}`,
        "--format=%s",
        "--no-merges",
      ])
    ).split("\n"),
  );
  const completedWork = subjects.length
    ? `Recent commits: ${subjects.map((s) => `"${s}"`).join("; ")}.`
    : "No commits are recorded before this request.";
  const steps = await detectSteps(root);
  return {
    context:
      context.length >= 10 ? context : `Project folder: ${basename(root)}.`,
    completedWork,
    ...steps,
  };
}
