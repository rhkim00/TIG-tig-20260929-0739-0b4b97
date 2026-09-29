import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const cli = resolve(process.env.TIG_TEST_CLI ?? "apps/cli/src/main.ts");
const loader = pathToFileURL(resolve("node_modules/tsx/dist/loader.mjs")).href;

test("help aliases work offline in an empty folder without creating request state", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "tig-help-"));
  try {
    const outputs = ["help", "--help", "-h"].map((arg) => {
      const run = spawnSync(process.execPath, ["--import", loader, cli, arg], {
        cwd,
        env: {
          ...process.env,
          TIG_STATE_DIR: cwd,
          TIG_ORIGIN: "http://127.0.0.1:1",
        },
        encoding: "utf8",
        timeout: 10000,
      });
      assert.equal(run.status, 0, run.stderr);
      assert.match(run.stdout, /처음이면 이 순서로/);
      assert.match(run.stdout, /tig issue <taskId> --yes/);
      assert.match(run.stdout, /tig request publish/);
      assert.doesNotMatch(run.stdout, /Device connected\.|Drafting from/);
      return run.stdout;
    });
    assert.equal(outputs[0], outputs[1]);
    assert.equal(outputs[1], outputs[2]);
    assert.deepEqual(await readdir(cwd), []);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("nested help reaches the requested command without executing required actions", () => {
  for (const args of [
    ["help", "request", "publish"],
    ["request", "publish", "--help"],
    ["help", "work"],
    ["help", "claude-statusline", "install"],
    ["help", "claude-notes", "install"],
    ["issue", "--help"],
  ]) {
    const run = spawnSync(process.execPath, ["--import", "tsx", cli, ...args], {
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(run.status, 0, `${args.join(" ")}: ${run.stderr}`);
    assert.match(run.stdout, /Usage: tig/);
    if (args.includes("publish")) {
      assert.match(run.stdout, /Usage: tig request publish/);
      assert.match(run.stdout, /--approve <digest>/);
      assert.match(
        run.stdout,
        /tig request publish <requestId> --approve <digest> --yes/,
      );
    }
    if (args.includes("issue")) assert.match(run.stdout, /--yes/);
  }
});

test("unknown help topics fail with guidance instead of becoming a natural-language request", () => {
  const run = spawnSync(
    process.execPath,
    ["--import", "tsx", cli, "help", "request", "not-a-command"],
    {
      encoding: "utf8",
      timeout: 10000,
    },
  );
  assert.equal(run.status, 1);
  assert.match(run.stderr, /알 수 없는 명령.*tig help/);
  assert.doesNotMatch(run.stdout, /Drafting|Publish publicly/);
});
