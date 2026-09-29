import { z } from "zod";
import { artifactSchema } from "./index.js";
export const versionBody = z
  .object({ expectedVersion: z.number().int().positive() })
  .strict();
export const claimBody = versionBody
  .extend({ consent: z.literal("accept_this_task") })
  .strict();
export const executionBody = versionBody
  .extend({ generation: z.number().int().positive() })
  .strict();
export const submitBody = executionBody
  .extend({
    artifact: artifactSchema,
    report: z.string().trim().min(10).max(12000),
    // Worker-declared local execution details for Git requests. Never treated as
    // verified: the server records them as client_observed.
    execution: z
      .object({
        provider: z.enum(["codex", "claude"]),
        model: z.string().trim().min(1).max(100),
        effort: z.string().trim().min(1).max(80),
      })
      .strict()
      .optional(),
    // Where the same result was published in Git for the requester (branch on the
    // delivery repository or the worker's fork, plus the pull request). The server
    // confirms the repository is public and the commit exists before storing it.
    gitResult: z
      .object({
        repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
        branch: z.string().regex(/^tig\/results\/[a-f0-9-]{36}$/),
        commit: z.string().regex(/^[a-f0-9]{40}$/),
        pullRequestUrl: z.url().max(300).nullable(),
      })
      .strict()
      .optional(),
  })
  .strict();
// This exercise uses data, never client-supplied executable code.
export const fixtureOutput = {
  available: "Available TIG",
  escrow: "Reserved TIG",
  paid: "Reward paid",
} as const;
export const fixtureContent = JSON.stringify(fixtureOutput, null, 2) + "\n";
export const fixtureSummary =
  "Update the wallet labels in wallet-labels.json to the specified English copy.";
