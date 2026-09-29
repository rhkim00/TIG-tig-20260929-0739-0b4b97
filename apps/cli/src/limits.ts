// A local AI tool that just refused with a usage/session limit is unusable until its
// window resets. tig remembers that on this computer (nothing is uploaded) so the next
// proposal, draft or worker run does not pick the exhausted tool again.
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { atomicJson, stateDir } from "./drafts.js";
import type { LocalAiProvider } from "./local-ai.js";

export const LIMIT_PATTERN =
  /usage limit|session limit|rate limit|limit (has been |was )?reached|out of (usage|tokens|credits)|quota|사용량 한도|한도에 도달/i;
export const DEFAULT_LIMIT_MS = 5 * 3600000; // a 5-hour window when no reset time is stated

export interface LimitHit {
  provider: LocalAiProvider;
  hitAt: string;
  resetsAt: string;
  message: string;
}
export const limitPath = (provider: LocalAiProvider) =>
  join(stateDir(), `limit-${provider}.json`);

// "resets 11:30am (UTC)" / "resets at 3pm UTC" / "resets 14:05 UTC" → the next such
// UTC time after `now`. Anything else → now + 5 hours.
export function parseResetTime(message: string, now = Date.now()): number {
  const m = message.match(
    /resets?(?: at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*\(?utc\)?/i,
  );
  if (!m) return now + DEFAULT_LIMIT_MS;
  let hour = Number(m[1]);
  const minute = Number(m[2] ?? "0");
  const ampm = m[3]?.toLowerCase();
  if (ampm === "pm" && hour < 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return now + DEFAULT_LIMIT_MS;
  const at = new Date(now);
  at.setUTCHours(hour, minute, 0, 0);
  if (at.getTime() <= now) at.setUTCDate(at.getUTCDate() + 1);
  return at.getTime();
}
export const isLimitMessage = (message: string) => LIMIT_PATTERN.test(message);

export async function recordLimitHit(
  provider: LocalAiProvider,
  message: string,
  now = Date.now(),
): Promise<LimitHit> {
  const hit: LimitHit = {
    provider,
    hitAt: new Date(now).toISOString(),
    resetsAt: new Date(parseResetTime(message, now)).toISOString(),
    message: message.slice(0, 300),
  };
  await atomicJson(limitPath(provider), hit);
  return hit;
}
export async function activeLimit(
  provider: LocalAiProvider,
  now = Date.now(),
): Promise<LimitHit | null> {
  try {
    const hit: LimitHit = JSON.parse(
      await readFile(limitPath(provider), "utf8"),
    );
    if (typeof hit?.resetsAt !== "string" || Date.parse(hit.resetsAt) <= now) {
      await rm(limitPath(provider), { force: true });
      return null;
    }
    return hit;
  } catch {
    return null;
  }
}
export const resetClock = (hit: LimitHit) =>
  `${new Date(hit.resetsAt).toISOString().slice(11, 16)} UTC`;
