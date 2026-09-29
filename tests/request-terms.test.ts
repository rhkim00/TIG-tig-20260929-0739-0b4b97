import { test } from "node:test";
import assert from "node:assert/strict";
import {
  effortAllowed,
  normalizeEffort,
  parseRequestTerms,
  parseWorkerAi,
} from "../apps/cli/src/request-terms.js";

test("one answer names the work, the tool, the model, the level and the reward; a trailing terms clause is cut from the work", () => {
  const t = parseRequestTerms(
    "인증 미들웨어 리팩터링, claude / opus / high, 300 TIG",
  );
  assert.deepEqual(t, {
    provider: "claude",
    model: "opus",
    effort: "high",
    reward: "300",
    work: "인증 미들웨어 리팩터링",
  });
  const spaced = parseRequestTerms(
    "Fix the addition bug codex gpt-5 extra high 120 TIG",
  );
  assert.equal(spaced.provider, "codex");
  assert.equal(spaced.model, "gpt-5");
  assert.equal(spaced.effort, "xhigh");
  assert.equal(spaced.reward, "120");
  assert.equal(spaced.work, "Fix the addition bug");
  const korean = parseRequestTerms(
    "테스트 추가해줘 (클로드 코드 / sonnet / 높음) 50 티그",
  );
  assert.equal(korean.provider, "claude");
  assert.equal(korean.model, "sonnet");
  assert.equal(korean.effort, "high");
  assert.equal(korean.reward, "50");
  assert.equal(korean.work, "테스트 추가해줘");
});
test("a term inside a sentence is read but the sentence is kept whole; nothing is invented for a missing term", () => {
  const inline = parseRequestTerms(
    "Fix add with gpt astra extrahigh for 1000 TIG",
  );
  assert.equal(inline.provider, undefined);
  assert.equal(inline.model, "gpt astra");
  assert.equal(inline.effort, "xhigh");
  assert.equal(inline.reward, "1000");
  assert.equal(inline.work, "Fix add with gpt astra extrahigh for 1000 TIG");
  const bare = parseRequestTerms("버그 고쳐줘");
  assert.deepEqual(bare, {
    provider: undefined,
    model: undefined,
    effort: undefined,
    reward: undefined,
    work: "버그 고쳐줘",
  });
  const tool = parseRequestTerms("코덱스로 해줘, 보상은 50 TIG");
  assert.equal(tool.provider, "codex");
  assert.equal(tool.reward, "50");
  assert.equal(tool.model, undefined);
  assert.equal(tool.work, "코덱스로 해줘");
  // Two amounts, or a corrected one, are not a reward (the requester is asked).
  assert.equal(parseRequestTerms("100 TIG 아니고 200 TIG로").reward, undefined);
  // A terms-only answer keeps its text as the work rather than nothing.
  assert.equal(
    parseRequestTerms("claude / opus / high").work,
    "claude / opus / high",
  );
  // "high priority" is a level word without a tool: read as the level, and the
  // sentence stays whole because the word sits inside it.
  const priority = parseRequestTerms("high priority: fix the login bug");
  assert.equal(priority.effort, "high");
  assert.equal(priority.work, "high priority: fix the login bug");
});
test("provider / model / effort typed whole is read with the tools' own level vocabulary; anything else is not a worker AI", () => {
  assert.deepEqual(parseWorkerAi("Claude Code / opus / high"), {
    provider: "claude",
    model: "opus",
    effort: "high",
  });
  assert.equal(parseWorkerAi("opus / high"), null);
  assert.equal(parseWorkerAi("gemini / x / y"), null);
  assert.equal(
    parseWorkerAi("codex / gpt-6-astra / extra high")!.effort,
    "xhigh",
  );
  assert.equal(parseWorkerAi("codex gpt-6-astra light")!.effort, "low");
  assert.equal(parseWorkerAi("codex / gpt-5.6-sol / ultra")!.effort, "ultra");
  assert.equal(parseWorkerAi("claude opus extra high")!.effort, "xhigh");
  assert.equal(parseWorkerAi("claude / opus / maximum")!.effort, "max");
  assert.equal(parseWorkerAi("claude / opus / 최대")!.effort, "max");
  assert.equal(parseWorkerAi("클로드 / opus / 높음")!.provider, "claude");
  // ultracode is a Claude Code working mode, not a level; ultra is Codex's.
  assert.equal(parseWorkerAi("claude / opus / Ultracode"), null);
  assert.equal(parseWorkerAi("claude / opus / ultra"), null);
  assert.equal(normalizeEffort("Extra High"), "xhigh");
  assert.equal(effortAllowed("claude", "ultra"), false);
  assert.equal(effortAllowed("codex", "ultra"), true);
});
