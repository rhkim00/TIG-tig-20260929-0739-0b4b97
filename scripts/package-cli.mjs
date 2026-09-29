import { cp, mkdir, writeFile, rm, readFile, chmod } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { validateOrigin } from "../build/apps/cli/src/client.js";
const root = resolve(".local/cli-package"),
  releases = resolve(".local/releases");
const pkg = JSON.parse(await readFile("package.json", "utf8"));
await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });
await mkdir(releases, { recursive: true });
await cp("build/apps/cli", `${root}/apps/cli`, { recursive: true });
if (process.env.TIG_RELEASE_ORIGIN) {
  const origin = validateOrigin(process.env.TIG_RELEASE_ORIGIN);
  await writeFile(
    `${root}/apps/cli/src/deployment.js`,
    `export const defaultOrigin = ${JSON.stringify(origin)};\n`,
  );
}
await cp("build/packages/contracts", `${root}/packages/contracts`, {
  recursive: true,
});
await chmod(`${root}/apps/cli/src/main.js`, 0o755);
await writeFile(
  `${root}/package.json`,
  JSON.stringify(
    {
      name: "tokenisgold-cli",
      version: pkg.version,
      type: "module",
      engines: pkg.engines,
      bin: { tig: "apps/cli/src/main.js" },
      dependencies: Object.fromEntries(
        ["commander", "chokidar", "zod"].map((k) => [k, pkg.dependencies[k]]),
      ),
    },
    null,
    2,
  ),
);
await writeFile(
  `${root}/README.md`,
  "# Tokenisgold CLI\nRequires Node 24. Install this local tarball with npm install --global <file.tgz>.\nRun tig in an interactive terminal. It guides first-time setup, local Codex drafting, review and publication.\nAutomatic requester drafting uses your official Codex CLI and ChatGPT login. Worker execution is separate; local development balances are sample TIG. Provider credentials are not collected.\n",
);
execFileSync(
  process.execPath,
  [process.env.npm_execpath, "pack", root, "--pack-destination", releases],
  { stdio: "inherit" },
);
console.log(`CLI package: ${releases}/tokenisgold-cli-${pkg.version}.tgz`);
