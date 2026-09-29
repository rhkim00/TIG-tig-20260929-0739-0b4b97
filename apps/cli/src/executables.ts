import { constants } from "node:fs";
import { access, readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

interface SearchOptions {
  path?: string;
  home?: string;
  platform?: NodeJS.Platform;
  arch?: string;
}

async function executable(path: string, platform: NodeJS.Platform) {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function findExecutable(
  name: string,
  options: SearchOptions = {},
) {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const arch = options.arch ?? process.arch;
  const searchPath = options.path ?? process.env.PATH ?? "";
  let onPath: string | null = null;
  search: for (const dir of [
    ...searchPath.split(platform === "win32" ? ";" : delimiter),
    join(home, ".local", "bin"),
  ]) {
    // Never resolve a tool from the project via an empty/relative PATH entry.
    if (!isAbsolute(dir)) continue;
    for (const suffix of platform === "win32" ? [".exe", ".cmd", ""] : [""]) {
      const path = join(dir, name + suffix);
      if (await executable(path, platform)) {
        onPath = path;
        break search;
      }
    }
  }
  // Claude Code on PATH may be older than the copy bundled with the VS Code extension;
  // an outdated CLI is refused by the service, so the newest known version wins.
  if (name !== "claude" && (onPath || name !== "codex")) return onPath;

  // Compatibility fallback for the official VS Code extensions' bundled CLIs.
  // Their internal layout is not a stable API; the caller still checks CLI capabilities.
  const cpu = arch === "x64" ? "x86_64" : arch === "arm64" ? "aarch64" : null;
  if (!cpu || !["linux", "darwin", "win32"].includes(platform)) return null;
  const bundled =
    name === "codex"
      ? {
          pattern: /^openai\.chatgpt-\d/,
          publisher: "openai",
          extension: "chatgpt",
          relative: join("bin", `${platform}-${cpu}`),
        }
      : {
          pattern: /^anthropic\.claude-code-\d/,
          publisher: "anthropic",
          extension: "claude-code",
          relative: join("resources", "native-binary"),
        };
  const candidates: { path: string; version: string }[] = [];
  for (const editor of [
    ".vscode-server",
    ".vscode",
    ".vscode-server-insiders",
    ".vscode-insiders",
  ]) {
    const extensions = join(home, editor, "extensions");
    let entries: string[];
    let obsolete: Record<string, unknown> = {};
    try {
      entries = await readdir(extensions);
    } catch {
      continue;
    }
    try {
      obsolete =
        JSON.parse(await readFile(join(extensions, ".obsolete"), "utf8")) ?? {};
    } catch {
      /* no obsolete extension list */
    }
    for (const entry of entries) {
      if (!bundled.pattern.test(entry) || obsolete[entry]) continue;
      try {
        const folder = join(extensions, entry);
        const metadata = JSON.parse(
          await readFile(join(folder, "package.json"), "utf8"),
        );
        if (
          String(metadata.publisher).toLowerCase() !== bundled.publisher ||
          metadata.name !== bundled.extension ||
          !/^\d+\.\d+\.\d+$/.test(metadata.version)
        )
          continue;
        const path = join(
          folder,
          bundled.relative,
          platform === "win32" ? `${name}.exe` : name,
        );
        if (await executable(path, platform))
          candidates.push({ path, version: metadata.version });
      } catch {
        /* incomplete or removed extension; try the next installation */
      }
    }
  }
  candidates.sort(
    (a, b) =>
      b.version.localeCompare(a.version, "en", { numeric: true }) ||
      a.path.localeCompare(b.path),
  );
  const bundled_ = candidates[0];
  if (!onPath) return bundled_?.path ?? null;
  // The official installer links `claude` into .../versions/<semver>/; use that to compare.
  const onPathVersion = await installedVersion(onPath);
  if (
    bundled_ &&
    onPathVersion &&
    bundled_.version.localeCompare(onPathVersion, "en", { numeric: true }) > 0
  )
    return bundled_.path;
  return onPath;
}
async function installedVersion(path: string) {
  try {
    return (
      (await realpath(path)).match(/[\\/]versions[\\/](\d+\.\d+\.\d+)[\\/]?/)?.[1] ??
      null
    );
  } catch {
    return null;
  }
}
