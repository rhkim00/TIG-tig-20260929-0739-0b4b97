import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import {
  CLAUDE_AGENT_FLAGS,
  CODEX_AGENT_FLAGS,
  claudeAgentArgs,
  codexAgentArgs,
  codexIsolationArgs,
  runLocalProcess,
  workerAgentReadiness,
  type ProcessRequest,
} from "../apps/cli/src/local-ai.js";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test(
  "a timed-out or cancelled local AI is killed together with the processes it spawned",
  { skip: process.platform === "win32" },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "tig-kill-"));
    try {
      // The "CLI" forks a long sleep (an agent's test runner) and waits for it.
      const bin = join(dir, "agent");
      await writeFile(bin, '#!/bin/sh\nsleep 120 &\necho $! > "$1"\nwait\n', {
        mode: 0o700,
      });
      const pidFile = join(dir, "grandchild.pid");
      const request: ProcessRequest = {
        binary: bin,
        args: [pidFile],
        cwd: dir,
        env: { PATH: process.env.PATH! },
        timeout: 400,
      };
      await assert.rejects(runLocalProcess(request), /timed out/);
      const grandchild = Number(await readFile(pidFile, "utf8"));
      assert(grandchild > 0);
      for (let i = 0; i < 40 && alive(grandchild); i++) await delay(50);
      assert.equal(alive(grandchild), false, "the sleep died with the CLI");
      // Cancellation takes the same path.
      const controller = new AbortController();
      const cancelled = runLocalProcess({
        ...request,
        timeout: 60000,
        signal: controller.signal,
        args: [pidFile + ".2"],
      });
      await delay(150);
      controller.abort();
      await assert.rejects(cancelled, /cancelled/);
      const second = Number(await readFile(pidFile + ".2", "utf8"));
      for (let i = 0; i < 40 && alive(second); i++) await delay(50);
      assert.equal(alive(second), false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("worker agent arguments keep the tool's own sandbox on and never bypass it", () => {
  const claude = claudeAgentArgs({
    model: "opus",
    effort: "high",
    schema: "{}",
  });
  for (const flag of [
    "-p",
    "--restricted",
    "--safe-mode",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--json-schema",
  ])
    assert(claude.includes(flag), flag);
  assert.equal(claude[claude.indexOf("--permission-mode") + 1], "acceptEdits");
  assert.equal(claude[claude.indexOf("--permission-prompts") + 1], "none");
  assert.equal(
    claude[claude.indexOf("--tools") + 1],
    "Read,Edit,Write,Glob,Grep",
  );
  assert(!claude.includes("--bare"));
  assert(
    !claude.some((a) =>
      /dangerously|bypassPermissions|Bash|--allowedTools/.test(a),
    ),
  );
  const codex = codexAgentArgs({
    workspace: "/ws",
    model: "gpt-6",
    effort: "medium",
    schema: "/s.json",
    output: "/o.json",
  });
  assert.equal(codex[0], "exec");
  assert.equal(codex[codex.indexOf("--sandbox") + 1], "workspace-write");
  assert.equal(codex[codex.indexOf("-C") + 1], "/ws");
  assert.equal(codex.at(-1), "-");
  for (const flag of [
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--output-schema",
    "--output-last-message",
  ])
    assert(codex.includes(flag), flag);
  assert(codex.includes("sandbox_workspace_write.network_access=false"));
  assert(codex.includes('approval_policy="never"'));
  assert(codex.includes("mcp_servers={}"));
  // Commands are allowed inside the sandbox: the shell features stay on; every
  // other feature the drafting isolation disables stays off.
  assert(!codex.includes("features.shell_tool=false"));
  assert(!codex.includes("features.unified_exec=false"));
  for (const off of codexIsolationArgs.filter((a) =>
    /^features\.(?!shell_tool|unified_exec)/.test(a),
  ))
    assert(codex.includes(off), off);
  assert(!codex.some((a) => a.startsWith("--dangerously")));
  assert(!codex.includes("danger-full-access"));
  // The drafting path is unchanged: read-only, no shell.
  assert(codexIsolationArgs.includes("read-only"));
  assert(codexIsolationArgs.includes("features.shell_tool=false"));
});

test("worker readiness verifies the sandbox flags against the installed CLI's --help", async () => {
  const fake = (help: string) => async (r: ProcessRequest) => {
    assert(r.args.includes("--help"));
    return { stdout: help, stderr: "" };
  };
  await workerAgentReadiness(
    "codex",
    "codex",
    fake(CODEX_AGENT_FLAGS.join("\n")),
  );
  await workerAgentReadiness(
    "claude",
    "claude",
    fake(CLAUDE_AGENT_FLAGS.join("\n")),
  );
  await assert.rejects(
    workerAgentReadiness("codex", "codex", fake("--ephemeral --output-schema")),
    /Update Codex: .*--sandbox/,
  );
  await assert.rejects(
    workerAgentReadiness(
      "claude",
      "claude",
      fake("--json-schema --tools --permission-mode"),
    ),
    /Update Claude Code: .*--restricted.*--safe-mode/,
  );
});
