import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activeLimit,
  isLimitMessage,
  limitPath,
  parseResetTime,
  recordLimitHit,
  resetClock,
  DEFAULT_LIMIT_MS,
} from "../apps/cli/src/limits.js";

const NOW = Date.parse("2026-09-14T08:00:00Z");

test("a tool's limit message is recognised and its reset time read as UTC", () => {
  assert.equal(
    isLimitMessage(
      "Claude Code could not complete the request: You've hit your session limit · resets 11:30am (UTC) No API fallback was used.",
    ),
    true,
  );
  assert.equal(isLimitMessage("usage limit reached for gpt-6"), true);
  assert.equal(isLimitMessage("Codex rate limit exceeded"), true);
  assert.equal(isLimitMessage("사용량 한도에 도달했습니다"), true);
  assert.equal(isLimitMessage("syntax error in report"), false);
  // "resets 11:30am (UTC)" later today; "resets 3pm UTC"; a past clock time → tomorrow.
  assert.equal(
    parseResetTime("resets 11:30am (UTC)", NOW),
    Date.parse("2026-09-14T11:30:00Z"),
  );
  assert.equal(
    parseResetTime("limit · resets at 3pm UTC", NOW),
    Date.parse("2026-09-14T15:00:00Z"),
  );
  assert.equal(
    parseResetTime("resets 07:05 UTC", NOW),
    Date.parse("2026-09-15T07:05:00Z"),
  );
  assert.equal(
    parseResetTime("resets 12am (UTC)", NOW),
    Date.parse("2026-09-15T00:00:00Z"),
  );
  // No stated reset: assume the usual five-hour window.
  assert.equal(parseResetTime("quota exceeded", NOW), NOW + DEFAULT_LIMIT_MS);
  assert.equal(parseResetTime("resets 99:00 UTC", NOW), NOW + DEFAULT_LIMIT_MS);
});

test("a recorded limit stays active until its reset, then clears itself", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "tig-limits-"));
  const previous = process.env.TIG_STATE_DIR;
  process.env.TIG_STATE_DIR = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.TIG_STATE_DIR;
    else process.env.TIG_STATE_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  });
  assert.equal(await activeLimit("claude", NOW), null);
  const hit = await recordLimitHit(
    "claude",
    "You've hit your session limit · resets 11:30am (UTC)",
    NOW,
  );
  assert.equal(hit.resetsAt, "2026-09-14T11:30:00.000Z");
  assert.equal(resetClock(hit), "11:30 UTC");
  // Stored locally only, in the tig state directory.
  const stored = JSON.parse(await readFile(limitPath("claude"), "utf8"));
  assert.equal(stored.provider, "claude");
  assert.match(stored.message, /session limit/);
  assert.deepEqual(await activeLimit("claude", NOW + 3600000), hit);
  assert.equal(await activeLimit("codex", NOW), null);
  // Past the reset the marker is gone.
  assert.equal(
    await activeLimit("claude", Date.parse("2026-09-14T11:31:00Z")),
    null,
  );
  await assert.rejects(readFile(limitPath("claude"), "utf8"), /ENOENT/);
});
