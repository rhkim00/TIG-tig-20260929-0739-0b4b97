import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { subscriptionEnvironment } from "./local-ai.js";
import {
  observationSchema,
  type Observation,
} from "../../../packages/contracts/src/index.js";
const exec = promisify(execFile);
type Json = Record<string, any>;
export function projectCodexMetadata(
  account: Json,
  limits: Json,
  version: string,
  bucket = "codex",
): Observation {
  const chatgpt = account.account?.type === "chatgpt";
  const candidate =
    limits.rateLimitsByLimitId?.[bucket] ??
    (limits.rateLimits?.limitId === bucket ? limits.rateLimits : null);
  const windows = chatgpt
    ? ["primary", "secondary"].map((name) => {
        const w = candidate?.[name],
          percent = w?.usedPercent;
        const resets =
          typeof w?.resetsAt === "number" && Number.isFinite(w.resetsAt)
            ? new Date(w.resetsAt * 1000)
            : null;
        return {
          name: `${bucket}:${name}`,
          required: true,
          usedPercent:
            typeof percent === "number" &&
            Number.isFinite(percent) &&
            percent >= 0 &&
            percent <= 100
              ? percent
              : null,
          resetsAt:
            resets && !Number.isNaN(resets.getTime())
              ? resets.toISOString()
              : null,
        };
      })
    : [];
  const plan =
    chatgpt &&
    typeof account.account.planType === "string" &&
    /^[a-z0-9_]{1,80}$/.test(account.account.planType)
      ? account.account.planType
      : null;
  return observationSchema.parse({
    provider: "codex",
    planId: plan,
    source: "client_observed",
    toolVersion: version,
    windows,
  });
}
export async function withCodexMetadata<T>(
  binary: string,
  read: (rpc: (method: string, params: Json) => Promise<Json>) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) throw new Error("Codex metadata cancelled.");
  const cwd = await mkdtemp(join(tmpdir(), "tig-codex-metadata-"));
  const child = spawn(binary, ["app-server", "--listen", "stdio://"], {
    cwd,
    env: subscriptionEnvironment(),
    stdio: ["pipe", "pipe", "ignore"],
  });
  let seq = 0,
    buffer = "",
    ended = false;
  const requests = new Map<
    number,
    {
      resolve: (v: Json) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  const fail = () => {
    ended = true;
    for (const p of requests.values()) {
      clearTimeout(p.timer);
      p.reject(
        new Error(
          "Official Codex metadata is unavailable. No account credentials were read by Tokenisgold.",
        ),
      );
    }
    requests.clear();
  };
  child.on("error", fail);
  child.on("exit", fail);
  child.stdin.on("error", fail);
  const abort = () => {
    fail();
    child.kill("SIGKILL");
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    if (buffer.length > 1_000_000) {
      fail();
      child.kill("SIGKILL");
      return;
    }
    while (buffer.includes("\n")) {
      const i = buffer.indexOf("\n"),
        line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      let m: Json;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (m.method && m.id !== undefined) {
        child.stdin.write(
          JSON.stringify({
            id: m.id,
            error: {
              code: -32601,
              message: "Metadata client does not support server requests",
            },
          }) + "\n",
        );
        continue;
      }
      const pending = requests.get(m.id);
      if (pending) {
        requests.delete(m.id);
        clearTimeout(pending.timer);
        if (m.error)
          pending.reject(new Error("Official Codex metadata request failed."));
        else pending.resolve(m.result ?? {});
      }
    }
  });
  function rpc(method: string, params: Json): Promise<Json> {
    if (
      ![
        "initialize",
        "account/read",
        "account/rateLimits/read",
        "model/list",
      ].includes(method)
    )
      return Promise.reject(
        new Error("Only read-only Codex metadata is supported."),
      );
    return new Promise((resolve, reject) => {
      if (ended) {
        reject(new Error("Codex app-server did not start."));
        return;
      }
      const id = ++seq,
        timer = setTimeout(() => {
          requests.delete(id);
          reject(new Error("Codex metadata request timed out."));
        }, 15000);
      requests.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ method, id, params }) + "\n");
    });
  }
  try {
    await rpc("initialize", {
      clientInfo: { name: "tokenisgold_metadata", version: "0.1.0" },
    });
    child.stdin.write(
      JSON.stringify({ method: "initialized", params: {} }) + "\n",
    );
    const account = await rpc("account/read", { refreshToken: false });
    if (account.account?.type !== "chatgpt")
      throw new Error(
        "Connect a ChatGPT account in the official Codex CLI first.",
      );
    return await read(rpc);
  } finally {
    signal?.removeEventListener("abort", abort);
    fail();
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null)
        return resolve();
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 1000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    await rm(cwd, { recursive: true, force: true });
  }
}

export async function readCodexObservation(
  binary = "codex",
  bucket = "codex",
): Promise<Observation> {
  if (!/^[a-zA-Z0-9_-]{1,60}$/.test(bucket))
    throw new Error("Invalid quota bucket");
  return withCodexMetadata(binary, async (rpc) => {
    const account = await rpc("account/read", { refreshToken: false });
    const limits = await rpc("account/rateLimits/read", {});
    const version =
      (
        await exec(binary, ["--version"], {
          timeout: 5000,
          env: subscriptionEnvironment(),
        })
      ).stdout.match(/codex-cli [0-9A-Za-z.+-]+/)?.[0] ?? "unknown";
    return projectCodexMetadata(account, limits, version, bucket);
  });
}
