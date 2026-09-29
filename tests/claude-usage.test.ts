import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureStatusLine,
  installStatusLine,
  isTigStatusLine,
  loadCapturedRateLimits,
  pickRateLimits,
  projectClaudeMetadata,
  rateLimitsPath,
  runStatusLine,
  tigStatusText,
  uninstallStatusLine,
} from "../apps/cli/src/claude-usage.js";
import { recordUsageAlert, usageMessages } from "../apps/cli/src/usage.js";
import { usageSignal } from "../packages/contracts/src/index.js";

const NOW = Date.parse("2026-09-14T00:00:00Z");
const epoch = (offsetSeconds: number) => Math.floor(NOW / 1000) + offsetSeconds;

async function isolatedState(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "tig-claude-usage-"));
  const prior = process.env.TIG_STATE_DIR;
  process.env.TIG_STATE_DIR = join(dir, "state");
  t.after(async () => {
    if (prior === undefined) delete process.env.TIG_STATE_DIR;
    else process.env.TIG_STATE_DIR = prior;
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

test("status line JSON is reduced to the documented rate-limit numbers only", async (t) => {
  await isolatedState(t);
  const session = {
    cwd: "/home/someone/private-project",
    model: { id: "claude-opus", display_name: "Opus" },
    cost: { total_cost_usd: 1.25 },
    rate_limits: {
      five_hour: { used_percentage: 23.5, resets_at: epoch(3600), extra: "x" },
      seven_day: { used_percentage: "41", resets_at: epoch(86400) },
      spend_limit: { used_percentage: 62.8 },
      other: { used_percentage: 1 },
    },
  };
  const captured = await captureStatusLine(
    JSON.stringify(session),
    new Date(NOW),
  );
  assert.deepEqual(captured, {
    capturedAt: new Date(NOW).toISOString(),
    rateLimits: {
      five_hour: { used_percentage: 23.5, resets_at: epoch(3600) },
      seven_day: { resets_at: epoch(86400) },
      spend_limit: { used_percentage: 62.8 },
    },
  });
  const stored = await readFile(rateLimitsPath(), "utf8");
  assert.doesNotMatch(stored, /private-project|Opus|total_cost/);
  assert.deepEqual(await loadCapturedRateLimits(), captured);

  // Sessions before the first response carry no rate_limits: the last capture survives.
  assert.equal(
    await captureStatusLine(
      JSON.stringify({ cwd: "/x" }),
      new Date(NOW + 1000),
    ),
    null,
  );
  assert.equal(await captureStatusLine("not json"), null);
  assert.deepEqual(await loadCapturedRateLimits(), captured);
  assert.equal(pickRateLimits(null), null);
});

test("observations report both required windows; stale, missing or exceeded values are handled", () => {
  const fresh = projectClaudeMetadata(
    {
      capturedAt: new Date(NOW).toISOString(),
      rateLimits: {
        five_hour: { used_percentage: 23.5, resets_at: epoch(3600) },
        seven_day: { used_percentage: 141.2, resets_at: epoch(86400) },
      },
    },
    "claude-code 2.1.267",
    NOW,
  );
  assert.equal(fresh.provider, "claude");
  assert.equal(fresh.source, "client_observed");
  assert.deepEqual(fresh.windows, [
    {
      name: "claude:five_hour",
      required: true,
      usedPercent: 23.5,
      resetsAt: new Date(epoch(3600) * 1000).toISOString(),
    },
    {
      name: "claude:seven_day",
      required: true,
      usedPercent: 100,
      resetsAt: new Date(epoch(86400) * 1000).toISOString(),
    },
  ]);
  assert.equal(usageSignal(fresh.windows), "low");

  const stale = projectClaudeMetadata(
    {
      capturedAt: new Date(NOW - 7200000).toISOString(),
      rateLimits: {
        five_hour: { used_percentage: 90, resets_at: epoch(-60) },
        seven_day: { used_percentage: -5, resets_at: epoch(86400) },
      },
    },
    "claude-code 2.1.267",
    NOW,
  );
  assert.deepEqual(
    stale.windows.map((w) => [w.usedPercent, w.resetsAt]),
    [
      [null, null],
      [null, new Date(epoch(86400) * 1000).toISOString()],
    ],
  );
  assert.equal(usageSignal(stale.windows), "unknown");
  assert.equal(
    usageSignal(projectClaudeMetadata(null, "unknown", NOW).windows),
    "unknown",
  );
});

test("the status line text shows both windows and hints only for low or spare usage", () => {
  const at = (five: number, seven: number) => ({
    capturedAt: new Date(NOW).toISOString(),
    rateLimits: {
      five_hour: { used_percentage: five, resets_at: epoch(3600) },
      seven_day: { used_percentage: seven, resets_at: epoch(86400) },
    },
  });
  assert.equal(tigStatusText(null, NOW), "Tig · usage not reported yet");
  assert.equal(tigStatusText(at(23.5, 41.2), NOW), "Tig · 5h 24% · 7d 41%");
  assert.equal(
    tigStatusText(at(82, 41), NOW),
    "Tig · 5h 82% · 7d 41% · 80%+ used — run tig to hand off the rest",
  );
  assert.equal(
    tigStatusText(at(10, 30), NOW),
    "Tig · 5h 10% · 7d 30% · spare usage — tig work --market earns TIG",
  );
  assert.equal(
    tigStatusText(
      {
        capturedAt: new Date(NOW).toISOString(),
        rateLimits: { five_hour: { used_percentage: 10 } },
      },
      NOW,
    ),
    "Tig · 5h 10% · 7d ?",
  );
});

test("the runtime keeps the user's own status line above tig's line", async (t) => {
  await isolatedState(t);
  const input = JSON.stringify({
    rate_limits: {
      five_hour: { used_percentage: 5, resets_at: epoch(3600) },
      seven_day: { used_percentage: 12, resets_at: epoch(86400) },
    },
  });
  const calls: string[] = [];
  const text = await runStatusLine(input, {
    now: new Date(NOW),
    previous: { type: "command", command: "my-statusline.sh" },
    run: async (command, stdin) => {
      calls.push(command);
      assert.equal(stdin, input);
      return "[Opus] 8% context\n";
    },
  });
  assert.deepEqual(calls, ["my-statusline.sh"]);
  assert.equal(
    text,
    "[Opus] 8% context\nTig · 5h 5% · 7d 12% · spare usage — tig work --market earns TIG",
  );
  assert.equal(
    await runStatusLine(input, { now: new Date(NOW), previous: null }),
    "Tig · 5h 5% · 7d 12% · spare usage — tig work --market earns TIG",
  );
  // A real shell command receives the JSON on stdin.
  const chained = await runStatusLine(input, {
    now: new Date(NOW),
    previous: { type: "command", command: "head -c 14" },
  });
  assert.equal(chained.split("\n")[0], input.slice(0, 14));
});

test("install keeps other settings, remembers the previous status line and uninstall restores it", async (t) => {
  const dir = await isolatedState(t);
  const settings = join(dir, "claude", "settings.json");
  await mkdir(join(dir, "claude"));
  await writeFile(
    settings,
    JSON.stringify({
      model: "opus",
      statusLine: { type: "command", command: "mine.sh", padding: 1 },
    }),
  );
  const installed = await installStatusLine(
    settings,
    "/home/u/.local/bin/tig claude-statusline",
  );
  assert.deepEqual(installed, {
    changed: true,
    previous: { type: "command", command: "mine.sh", padding: 1 },
  });
  let parsed = JSON.parse(await readFile(settings, "utf8"));
  assert.equal(parsed.model, "opus");
  assert.deepEqual(parsed.statusLine, {
    type: "command",
    command: "/home/u/.local/bin/tig claude-statusline",
  });
  assert.equal(isTigStatusLine(parsed.statusLine), true);
  // Installing twice changes nothing and never forgets the original.
  const again = await installStatusLine(settings, "tig claude-statusline");
  assert.equal(again.changed, false);
  assert.deepEqual(again.previous, {
    type: "command",
    command: "mine.sh",
    padding: 1,
  });
  // The runtime picks the remembered command up without options.
  const text = await runStatusLine(JSON.stringify({}), {
    now: new Date(NOW),
    run: async (command) => `${command} ran`,
  });
  assert.equal(text, "mine.sh ran\nTig · usage not reported yet");

  assert.deepEqual(await uninstallStatusLine(settings), { changed: true });
  parsed = JSON.parse(await readFile(settings, "utf8"));
  assert.deepEqual(parsed, {
    model: "opus",
    statusLine: { type: "command", command: "mine.sh", padding: 1 },
  });
  assert.deepEqual(await uninstallStatusLine(settings), { changed: false });

  // Without a previous status line the key is removed; a missing file is created.
  const empty = join(dir, "claude2", "settings.json");
  await installStatusLine(empty, "tig claude-statusline");
  assert.equal(
    isTigStatusLine(JSON.parse(await readFile(empty, "utf8")).statusLine),
    true,
  );
  await uninstallStatusLine(empty);
  assert.deepEqual(JSON.parse(await readFile(empty, "utf8")), {});

  await writeFile(settings, "[]");
  await assert.rejects(
    installStatusLine(settings, "tig claude-statusline"),
    /not a JSON object/,
  );
});

test("usage alerts follow P-053: low or spare only, same alert suppressed for six hours", async (t) => {
  await isolatedState(t);
  const observation = (used: number) =>
    projectClaudeMetadata(
      {
        capturedAt: new Date(NOW).toISOString(),
        rateLimits: {
          five_hour: { used_percentage: used, resets_at: epoch(3600) },
          seven_day: { used_percentage: used, resets_at: epoch(86400) },
        },
      },
      "claude-code 2.1.267",
      NOW,
    );
  assert.equal(await recordUsageAlert(observation(50), NOW), null);
  assert.equal(await recordUsageAlert(observation(85), NOW), usageMessages.low);
  assert.equal(await recordUsageAlert(observation(85), NOW + 3600000), null);
  assert.equal(
    await recordUsageAlert(observation(10), NOW + 3600000),
    usageMessages.spare,
  );
  assert.equal(
    await recordUsageAlert(observation(85), NOW + 2 * 3600000),
    usageMessages.low,
  );
  assert.equal(
    await recordUsageAlert(observation(85), NOW + 9 * 3600000),
    usageMessages.low,
  );
});
