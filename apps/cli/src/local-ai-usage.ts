// Which installed local AI should not be asked to run: the tool whose session
// hit its limit, or whose observed usage is 80%+ used. Only measured signals
// count; with no signal nothing is avoided. Read by the result review to pick
// the tool that reads a worker's diff.
import { localAiTools, type LocalAiProvider } from "./local-ai.js";
import type { AiSession } from "./evidence.js";
import { activeLimit, resetClock } from "./limits.js";
import { readCodexObservation } from "./codex.js";
import {
  loadCapturedRateLimits,
  projectClaudeMetadata,
} from "./claude-usage.js";
import { usageSignal } from "../../../packages/contracts/src/index.js";

export async function usageAvoids(
  found: Partial<Record<LocalAiProvider, string | null>>,
  session: AiSession | null,
  services = {
    codexUsage: (binary: string) => readCodexObservation(binary),
    claudeUsage: loadCapturedRateLimits,
    now: () => Date.now(),
  },
): Promise<Partial<Record<LocalAiProvider, string>>> {
  const avoid: Partial<Record<LocalAiProvider, string>> = {};
  for (const provider of ["codex", "claude"] as const)
    if (found[provider]) {
      const hit = await activeLimit(provider, services.now());
      if (hit)
        avoid[provider] =
          `${localAiTools[provider].name} hit its limit (resets ${resetClock(hit)})`;
    }
  if (session?.limitHit && !avoid[session.provider])
    avoid[session.provider] =
      `your last ${localAiTools[session.provider].name} session hit its usage limit`;
  if (found.codex && !avoid.codex) {
    try {
      const observation = await services.codexUsage(found.codex);
      if (usageSignal(observation.windows) === "low")
        avoid.codex = "Codex usage is 80%+ used";
    } catch {
      /* unknown usage is not a reason */
    }
  }
  if (found.claude && !avoid.claude) {
    const captured = await services.claudeUsage();
    if (
      captured &&
      services.now() - Date.parse(captured.capturedAt) < 6 * 3600000 &&
      usageSignal(
        projectClaudeMetadata(captured, "statusline", services.now()).windows,
      ) === "low"
    )
      avoid.claude = "Claude usage is 80%+ used";
  }
  return avoid;
}
