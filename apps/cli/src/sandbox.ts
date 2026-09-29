import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const exec = promisify(execFile);
export async function sandboxDoctor() {
  if (process.platform !== "linux")
    return {
      available: false,
      executionEnabled: false,
      reason: "This OS needs its own verified isolation adapter.",
    };
  const dir = await mkdtemp(join(tmpdir(), "tig-isolation-"));
  try {
    await writeFile(join(dir, "allowed"), "fixture");
    await exec(
      "bwrap",
      [
        "--unshare-all",
        "--die-with-parent",
        "--new-session",
        "--ro-bind",
        "/usr",
        "/usr",
        "--symlink",
        "usr/bin",
        "/bin",
        "--symlink",
        "usr/lib",
        "/lib",
        "--symlink",
        "usr/lib64",
        "/lib64",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--tmpfs",
        "/tmp",
        "--dir",
        "/work",
        "--ro-bind",
        dir,
        "/work",
        "--chdir",
        "/work",
        "--clearenv",
        "/usr/bin/test",
        "-f",
        "/work/allowed",
      ],
      { timeout: 5000, maxBuffer: 4000 },
    );
    return {
      available: true,
      executionEnabled: false,
      reason:
        "Namespace probe passed; CPU/memory/network and credential-broker execution tests are still required.",
    };
  } catch {
    return {
      available: false,
      executionEnabled: false,
      reason:
        "Isolation could not start. Task execution is blocked; no unsandboxed fallback.",
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
