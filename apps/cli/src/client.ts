import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { atomicJson, stateDir } from "./drafts.js";
// Features this CLI can handle; the server refuses work it would fail at
// (e.g. claiming a tree-layout request from a CLI that expects code/ bundles).
export const CLIENT_CAPABILITIES = ["request-tree"] as const;
let version: string | undefined;
export function clientVersion() {
  if (version) return version;
  // package.json sits three levels up in the source and installed layouts and
  // four levels up when running from build/.
  for (const rel of ["../../../package.json", "../../../../package.json"])
    try {
      const v = JSON.parse(
        readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"),
      ).version;
      if (typeof v === "string" && /^[0-9A-Za-z.+-]{1,40}$/.test(v))
        return (version = v);
    } catch {
      // try the next layout
    }
  return (version = "unknown");
}
export function clientHeaders() {
  return {
    "X-Tig-Client": `tig/${clientVersion()}`,
    "X-Tig-Capabilities": CLIENT_CAPABILITIES.join(" "),
  };
}
export interface Connection {
  origin: string;
  token: string;
  deviceId: string;
}
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export const connectionPath = () => join(stateDir(), "connection.json");
export function validateOrigin(origin: string) {
  const url = new URL(origin);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ))
  )
    throw new Error("Use an HTTPS origin, or HTTP on localhost.");
  return url.origin;
}
export async function loadConnection(): Promise<Connection> {
  try {
    return JSON.parse(await readFile(connectionPath(), "utf8"));
  } catch {
    throw new Error(
      "Connect this device first: tig connect --origin <website>",
    );
  }
}
export async function request(
  origin: string,
  path: string,
  options: {
    body?: unknown;
    token?: string;
    key?: string;
    method?: string;
  } = {},
) {
  const website = validateOrigin(origin);
  let response: Response;
  try {
    response = await fetch(website + path, {
      method: options.method ?? (options.body === undefined ? "GET" : "POST"),
      headers: {
        "Content-Type": "application/json",
        ...clientHeaders(),
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        ...(options.body !== undefined
          ? { "Idempotency-Key": options.key ?? randomUUID() }
          : {}),
      },
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    });
  } catch (e) {
    // fetch reports DNS/refused/TLS failures as a bare "fetch failed"; say what to check.
    throw new Error(
      (e as Error)?.name === "TimeoutError"
        ? `${website} did not answer within 15 seconds. Check your network, then retry.`
        : `Cannot reach ${website}. Check the website address, your network and that the website is running, then retry (tig doctor shows this connection).`,
    );
  }
  let body: any;
  try {
    body = await response.json();
  } catch {
    throw new Error(
      `${website} answered with something that is not Tokenisgold (HTTP ${response.status}). Check the website address.`,
    );
  }
  if (!response.ok)
    throw new ApiError(
      response.status,
      `${body.code ?? "REQUEST_FAILED"}: ${body.message ?? "Try again."}`,
    );
  return body;
}
export async function api(
  path: string,
  options: Parameters<typeof request>[2] = {},
) {
  const c = await loadConnection();
  return request(c.origin, path, { ...options, token: c.token });
}
export async function connect(
  origin: string,
  name: string,
  options: {
    signal?: AbortSignal;
    onAuthorization?: (auth: {
      verificationUri: string;
      userCode: string;
      expiresIn?: number;
    }) => Promise<void>;
    onConnected?: () => void;
  } = {},
) {
  const auth = await request(origin, "/v1/device-authorizations", {
    body: { name },
  });
  const minutes = Math.max(1, Math.round(auth.expiresIn / 60));
  if (options.onAuthorization) await options.onAuthorization(auth);
  else
    console.log(
      `Open ${auth.verificationUri}\nConfirm code ${auth.userCode} on your signed-in web page.\nThe code expires in ${minutes} minutes. Keep this terminal open until it says "Device connected."`,
    );
  for (let n = 0; n < auth.expiresIn / auth.interval; n++) {
    await delay(auth.interval * 1000, undefined, { signal: options.signal });
    const result = await request(origin, "/v1/device-authorizations/token", {
      body: { deviceCode: auth.deviceCode },
    });
    if (result.status === "connected") {
      await atomicJson(connectionPath(), {
        origin: validateOrigin(origin),
        token: result.token,
        deviceId: result.deviceId,
      });
      if (options.onConnected) options.onConnected();
      else console.log("Device connected.");
      return;
    }
  }
  throw new Error(
    `The code was not confirmed within ${minutes} minutes. Run tig connect again and confirm the new code while this terminal waits.`,
  );
}
