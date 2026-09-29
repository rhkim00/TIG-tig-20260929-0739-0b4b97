import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicJson, stateDir } from "./drafts.js";
import {
  usageSignal,
  type Observation,
} from "../../../packages/contracts/src/index.js";

// P-053: alert when a required window is 80%+ used (low) or every required window is
// known and at most 30% used (spare); repeat the same alert at most every 6 hours.
export const ALERT_SUPPRESSION_MS = 6 * 3600000;
export const usageMessages = {
  low: "Usage is getting low. Your saved handoff can help you post a task: run tig.",
  spare:
    "You have available usage. Browse a task to earn TIG: tig work --market.",
} as const;

export async function recordUsageAlert(
  observation: Observation,
  now = Date.now(),
): Promise<string | null> {
  const signal = usageSignal(observation.windows);
  if (signal !== "low" && signal !== "spare") return null;
  const path = join(stateDir(), `usage-${observation.provider}.json`);
  let old: { signal?: string; at?: number } | null = null;
  try {
    old = JSON.parse(await readFile(path, "utf8"));
  } catch {
    /* first observation */
  }
  if (
    old &&
    old.signal === signal &&
    typeof old.at === "number" &&
    now - old.at < ALERT_SUPPRESSION_MS
  )
    return null;
  await atomicJson(path, { signal, at: now });
  return usageMessages[signal];
}
