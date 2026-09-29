import { z } from "zod";
import { withCodexMetadata } from "./codex.js";

export const codexModel = z.object({
  id: z.string().min(1).max(100),
  model: z.string().min(1).max(100),
  displayName: z.string().min(1).max(100),
  supportedReasoningEfforts: z
    .array(z.object({ reasoningEffort: z.string().min(1).max(80) }))
    .max(20),
  defaultReasoningEffort: z.string().max(80),
  hidden: z.boolean().optional(),
});
export type CodexModel = z.infer<typeof codexModel>;

export async function readCodexModels(binary: string, signal?: AbortSignal) {
  return withCodexMetadata(
    binary,
    async (rpc) => {
      const models: CodexModel[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 10; page++) {
        const result = await rpc("model/list", {
          limit: 100,
          includeHidden: false,
          ...(cursor ? { cursor } : {}),
        });
        models.push(
          ...z
            .array(codexModel)
            .max(100)
            .parse(result.data)
            .filter((m) => !m.hidden),
        );
        if (!result.nextCursor) return models;
        cursor = z.string().max(2000).parse(result.nextCursor);
      }
      throw new Error(
        "Codex model catalog is incomplete. Retry before starting.",
      );
    },
    signal,
  );
}

export function matchingModels(models: CodexModel[], requested: string) {
  const normalized = requested.toLowerCase().trim();
  const exact = models.filter((m) =>
    [m.id, m.model, m.displayName].some((v) => v.toLowerCase() === normalized),
  );
  // A short name is only a suggestion. The trial's single start confirmation shows the full model ID.
  return exact.length
    ? exact
    : models.filter((m) =>
        [m.model, m.displayName].some((v) =>
          v
            .toLowerCase()
            .split(/[^a-z0-9.]+/)
            .includes(normalized),
        ),
      );
}
