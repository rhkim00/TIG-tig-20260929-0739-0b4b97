import { taskView, walletView } from "../../../packages/contracts/src/index.js";
import { z } from "zod";
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
const pendingKeys = new Map<string, string>();
export async function request(path: string, body?: unknown, method?: string) {
  const fingerprint = `${path}:${JSON.stringify(body)}`;
  if (body !== undefined && !pendingKeys.has(fingerprint))
    pendingKeys.set(fingerprint, crypto.randomUUID());
  const response = await fetch(path, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    credentials: "same-origin",
    headers: {
      ...(body !== undefined
        ? {
            "Content-Type": "application/json",
            "Idempotency-Key": pendingKeys.get(fingerprint)!,
          }
        : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const value = await response.json();
  if (!response.ok) {
    if (response.status < 500) pendingKeys.delete(fingerprint);
    throw new ApiError(
      response.status,
      value.code,
      value.message ?? "Please try again.",
    );
  }
  pendingKeys.delete(fingerprint);
  return value;
}
export async function dashboard() {
  const [
    me,
    wallet,
    tasks,
    market,
    projects,
    connections,
    activity,
    devices,
    inbox,
  ] = await Promise.all([
    request("/v1/me"),
    request("/v1/wallet"),
    request("/v1/tasks?mine=true"),
    request("/v1/tasks"),
    request("/v1/projects"),
    request("/v1/connections"),
    request("/v1/wallet/entries"),
    request("/v1/devices"),
    request("/v1/notifications"),
  ]);
  return {
    me,
    unreadCount: inbox.unreadCount as number,
    wallet: walletView.parse(wallet),
    tasks: z.array(taskView).parse(tasks.tasks),
    market: z.array(taskView).parse(market.tasks),
    projects: projects.projects as {
      id: string;
      repository: string;
      url: string;
      projectType: string;
      stack: string[];
    }[],
    connections: connections.connections as {
      provider: string;
      planId: string | null;
      source: string;
      signal: string;
      verification: string;
      nextGrantAt: string | null;
    }[],
    activity: activity.entries as {
      id: string;
      reason: string;
      created_at: string;
      amount: string;
      kind: string;
    }[],
    devices: devices.devices as {
      id: string;
      name: string;
      revoked_at: string | null;
    }[],
  };
}
export type Dashboard = Awaited<ReturnType<typeof dashboard>>;
