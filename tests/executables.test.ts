import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findExecutable } from "../apps/cli/src/executables.js";

async function fixture(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), "tig-discovery-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const options = { home, path: "", platform: "linux" as const, arch: "x64" };
  const extension = async (
    version = "26.9.1",
    editor = ".vscode-server",
    cpu = "linux-x86_64",
  ) => {
    const folder = join(
      home,
      editor,
      "extensions",
      `openai.chatgpt-${version}-linux-x64`,
    );
    const bin = join(folder, "bin", cpu);
    await mkdir(bin, { recursive: true });
    await writeFile(
      join(folder, "package.json"),
      JSON.stringify({ publisher: "openai", name: "chatgpt", version }),
    );
    const binary = join(bin, "codex");
    await writeFile(binary, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    return { folder, binary };
  };
  return { home, options, extension };
}

test("finds a remote VS Code Codex without a terminal PATH entry", async (t) => {
  const f = await fixture(t);
  const { binary } = await f.extension();
  assert.equal(await findExecutable("codex", f.options), binary);
  assert.equal(await findExecutable("gh", f.options), null);
});

test("standalone executable wins over the bundled extension", async (t) => {
  const f = await fixture(t);
  await f.extension();
  const bin = join(f.home, "tools");
  await mkdir(bin);
  const binary = join(bin, "codex");
  await writeFile(binary, "#!/bin/sh\n", { mode: 0o700 });
  assert.equal(
    await findExecutable("codex", { ...f.options, path: bin }),
    binary,
  );
});

test("prefers the latest numeric version across local and remote extensions", async (t) => {
  const f = await fixture(t);
  await f.extension("26.9.1");
  const { binary } = await f.extension("26.10.1", ".vscode");
  await f.extension("25.99.1", ".vscode-insiders");
  assert.equal(await findExecutable("codex", f.options), binary);
});

test("skips obsolete, wrong architecture and malformed extension installations", async (t) => {
  const f = await fixture(t);
  const valid = await f.extension();
  await f.extension("26.10.1", ".vscode-server", "linux-aarch64");
  const broken = await f.extension("26.11.1");
  await writeFile(join(broken.folder, "package.json"), "{");
  const unofficial = await f.extension("26.12.1");
  await writeFile(
    join(unofficial.folder, "package.json"),
    JSON.stringify({
      publisher: "someone",
      name: "chatgpt",
      version: "26.12.1",
    }),
  );
  await f.extension("26.13.1");
  await writeFile(
    join(f.home, ".vscode-server", "extensions", ".obsolete"),
    JSON.stringify({ "openai.chatgpt-26.13.1-linux-x64": true }),
  );
  assert.equal(await findExecutable("codex", f.options), valid.binary);
});

test("directories and files without execute permission are not CLI binaries", async (t) => {
  const f = await fixture(t);
  const invalid = await f.extension();
  await chmod(invalid.binary, 0o600);
  const dir = join(f.home, "tools");
  await mkdir(join(dir, "codex"), { recursive: true });
  assert.equal(
    await findExecutable("codex", { ...f.options, path: dir }),
    null,
  );
});

test("supports the existing local bin fallback and safely reports missing installs", async (t) => {
  const f = await fixture(t);
  assert.equal(await findExecutable("codex", f.options), null);
  const dir = join(f.home, ".local", "bin");
  await mkdir(dir, { recursive: true });
  const binary = join(dir, "codex");
  await writeFile(binary, "#!/bin/sh\n", { mode: 0o700 });
  assert.equal(await findExecutable("codex", f.options), binary);
});
