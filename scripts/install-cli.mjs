import { mkdir, readFile, writeFile, lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
const pkg = JSON.parse(await readFile("package.json", "utf8"));
const archive = resolve(`.local/releases/tokenisgold-cli-${pkg.version}.tgz`);
if (process.platform === "win32") {
  console.log(`Run: npm install --global "${archive}"`);
  process.exit(0);
}
const prefix = join(homedir(), ".local/share/tokenisgold-cli-install");
const bin = join(homedir(), ".local/bin/tig");
const marker = "# Tokenisgold managed CLI launcher";
try {
  const stat = await lstat(bin);
  if (!stat.isFile() || !(await readFile(bin, "utf8")).includes(marker))
    throw new Error(
      `An existing command is at ${bin}; refusing to replace it. Install the tarball with a different npm prefix.`,
    );
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
execFileSync(
  process.execPath,
  [
    process.env.npm_execpath,
    "install",
    "--global",
    "--prefix",
    prefix,
    archive,
    "--no-audit",
    "--no-fund",
  ],
  { stdio: "inherit" },
);
const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
await mkdir(join(homedir(), ".local/bin"), { recursive: true });
await writeFile(
  bin,
  `#!/bin/sh\n${marker}\nexec ${quote(process.execPath)} ${quote(join(prefix, "lib/node_modules/tokenisgold-cli/apps/cli/src/main.js"))} "$@"\n`,
  { mode: 0o755 },
);
console.log(`Installed ${bin}. Run: tig`);
