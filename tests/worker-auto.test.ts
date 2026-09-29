import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  hasSpare,
  proposalAnswer,
  proposalLine,
  proposeOnce,
  recommendTask,
  toolSignals,
  watchAndWork,
  DECLINE_SUPPRESSION_MS,
  type Task,
  type ToolSignals,
} from "../apps/cli/src/worker-auto.js";
import { Cancelled, type Terminal } from "../apps/cli/src/terminal.js";

const NOW = Date.parse("2026-09-14T08:00:00Z");
function task(
  over: Partial<Task> & { provider?: "codex" | "claude" } = {},
): Task {
  const { provider = "claude", ...rest } = over;
  return {
    id: randomUUID(),
    title: "Fix div() zero divisor",
    requestCategory: "bug",
    rewardTig: "80",
    state: "OPEN",
    version: 1,
    executionDeadlineAt: new Date(NOW + 86400000).toISOString(),
    createdAt: new Date(NOW - 3600000).toISOString(),
    aiRequirement: {
      provider,
      model: "opus",
      effort: "medium",
      source: "declared",
    },
    requestUrl: "https://github.com/x/y/tree/tig/requests/abc",
    requesterId: randomUUID(),
    projectId: randomUUID(),
    workerId: null,
    generation: 0,
    phaseDueAt: null,
    reviewDueAt: null,
    developmentFixture: false,
    ...rest,
  } as Task;
}
function ui(answers: string[]) {
  const said: string[] = [];
  const asked: string[] = [];
  return {
    said,
    asked,
    ui: {
      say: (m: string) => said.push(m),
      section: (_s: string, t: string) => said.push(`# ${t}`),
      ask: async (q: string, fallback?: string) => {
        asked.push(q);
        return answers.shift() ?? fallback ?? "";
      },
      choose: async () => 0,
      confirm: async () => true,
      busy: async <T>(_l: string, run: () => Promise<T>) => run(),
    } as unknown as Terminal,
  };
}

test("usage signals come from each tool's own data; a stale Claude capture is unknown", async () => {
  const signals = await toolSignals(
    { codex: "/bin/codex", claude: "/bin/claude" },
    {
      codexUsage: async () => ({
        provider: "codex",
        planId: null,
        source: "client_observed",
        toolVersion: "t",
        windows: [
          {
            name: "codex:primary",
            required: true,
            usedPercent: 12,
            resetsAt: null,
          },
          {
            name: "codex:secondary",
            required: true,
            usedPercent: 20,
            resetsAt: null,
          },
        ],
      }),
      claudeUsage: async () => ({
        capturedAt: new Date(NOW - 7 * 3600000).toISOString(),
        rateLimits: { five_hour: { used_percentage: 90 } },
      }),
      limit: async () => null,
      now: () => NOW,
    },
  );
  assert.deepEqual(signals.codex, {
    signal: "spare",
    detail: "Codex 12%/20% used: usage to spare".replace(
      ": usage to spare",
      "",
    ),
  });
  assert.equal(signals.claude!.signal, "unknown");
  assert.equal(hasSpare(signals), true);
  const failing = await toolSignals(
    { codex: "/bin/codex" },
    {
      codexUsage: async () => {
        throw new Error("app-server down");
      },
      claudeUsage: async () => null,
      limit: async () => null,
      now: () => NOW,
    },
  );
  assert.deepEqual(failing, {
    codex: { signal: "unknown", detail: "Codex usage unknown" },
  });
  assert.equal(hasSpare(failing), false);
  // A tool that refused with a usage limit counts as low until its window resets.
  const limited = await toolSignals(
    { codex: "/bin/codex", claude: "/bin/claude" },
    {
      codexUsage: async () => {
        throw new Error("unused");
      },
      claudeUsage: async () => null,
      limit: async (provider) =>
        provider === "claude"
          ? {
              provider,
              hitAt: new Date(NOW).toISOString(),
              resetsAt: new Date(NOW + 3 * 3600000).toISOString(),
              message: "You've hit your session limit · resets 11:00am (UTC)",
            }
          : null,
      now: () => NOW,
    },
  );
  assert.deepEqual(limited.claude, {
    signal: "low",
    detail: "Claude Code hit its limit (resets 11:00 UTC)",
  });
  assert.equal(limited.codex!.signal, "unknown");
});

test("one request is recommended: usable tool required, spare tool and exact match preferred, then reward and recency", () => {
  const signals: ToolSignals = {
    codex: { signal: "spare", detail: "Codex 12%/20% used" },
    claude: { signal: "normal", detail: "Claude 58%/19% used" },
  };
  const forClaudeBig = task({
    provider: "claude",
    rewardTig: "500",
    title: "big claude",
  });
  const forCodexSmall = task({
    provider: "codex",
    rewardTig: "80",
    title: "small codex",
  });
  const forCodexNew = task({
    provider: "codex",
    rewardTig: "80",
    title: "new codex",
    createdAt: new Date(NOW - 60000).toISOString(),
  });
  const rec = recommendTask([forClaudeBig, forCodexSmall, forCodexNew], {
    installed: ["codex", "claude"],
    signals,
  });
  assert.equal(
    rec!.task.title,
    "new codex",
    "spare tool beats reward; newest wins the tie",
  );
  assert.equal(rec!.provider, "codex");
  assert.equal(rec!.substituted, false);
  assert.match(
    proposalLine(rec!),
    /^Take "new codex" for 80 TIG with Codex \(opus \/ medium\)\? — Codex 12%\/20% used: usage to spare; the request asks for Codex\.$/,
  );
  // Skipped requests are not proposed again; the next best is.
  const next = recommendTask([forClaudeBig, forCodexSmall, forCodexNew], {
    installed: ["codex", "claude"],
    signals,
    skipped: new Set([forCodexNew.id]),
  });
  assert.equal(next!.task.title, "small codex");
  // A low tool is never used; the other installed tool substitutes and says so.
  const low: ToolSignals = {
    codex: { signal: "low", detail: "Codex 85%/40% used" },
    claude: { signal: "unknown", detail: "Claude usage unknown" },
  };
  const sub = recommendTask([forCodexSmall], {
    installed: ["codex", "claude"],
    signals: low,
  });
  assert.equal(sub!.provider, "claude");
  assert.equal(sub!.substituted, true);
  assert.match(
    sub!.reason,
    /asks for Codex, which is not usable here, so Claude Code would run it/,
  );
  assert.equal(
    recommendTask([forCodexSmall], { installed: ["codex"], signals: low }),
    null,
  );
  assert.equal(recommendTask([], { installed: ["codex"], signals }), null);
});

test("answers: yes runs, next skips to another request, no declines, stop leaves", async () => {
  assert.equal(proposalAnswer("네"), "yes");
  assert.equal(proposalAnswer("다음"), "next");
  assert.equal(proposalAnswer(""), "no");
  assert.equal(proposalAnswer("그만"), "stop");
  assert.equal(proposalAnswer("maybe"), null);

  const a = task({ provider: "codex", title: "A" });
  const b = task({
    provider: "codex",
    title: "B",
    createdAt: new Date(NOW - 7200000).toISOString(),
  });
  const ran: string[] = [];
  const deps = {
    signals: async () => ({
      codex: { signal: "spare" as const, detail: "Codex 10%/10% used" },
    }),
    installed: async () => ["codex" as const],
    openTasks: async () => [a, b],
    run: async (rec: { task: Task }) => {
      ran.push(rec.task.title);
    },
  };
  const t = ui(["next", "yes"]);
  assert.equal((await proposeOnce(t.ui, deps, new Set())).outcome, "ran");
  assert.deepEqual(ran, ["B"]);
  assert.equal(t.asked.length, 2);
  assert.equal(
    (await proposeOnce(ui(["no"]).ui, deps, new Set())).outcome,
    "declined",
  );
  assert.equal(
    (await proposeOnce(ui(["stop"]).ui, deps, new Set())).outcome,
    "stopped",
  );
  const invalid = ui(["maybe", "yes"]);
  assert.equal((await proposeOnce(invalid.ui, deps, new Set())).outcome, "ran");
  assert.match(invalid.said.at(-1)!, /Reply yes, next or no/);
  // Without usage to spare the watch mode stays quiet; --market still proposes.
  const busy = {
    ...deps,
    signals: async () => ({
      codex: { signal: "normal" as const, detail: "Codex 50%/40% used" },
    }),
  };
  const quiet = await proposeOnce(ui([]).ui, busy, new Set(), {
    requireSpare: true,
  });
  assert.equal(quiet.outcome, "quiet");
  assert.match(quiet.note, /no usage to spare yet \(Codex 50%\/40% used\)/);
  assert.equal(
    (await proposeOnce(ui(["no"]).ui, busy, new Set())).outcome,
    "declined",
  );
  // No fitting request: the reason is spelled out instead of silence.
  const held = await proposeOnce(
    ui([]).ui,
    {
      ...deps,
      activeJob: async () =>
        task({ provider: "codex", title: "current job", state: "EXECUTING" }),
    },
    new Set(),
  );
  assert.equal(held.outcome, "none");
  assert.match(held.note, /already working on "current job" \(executing\)/);
  // The note names the id and the command that finishes the held job.
  const heldId = held.note.match(
    /run tig work ([0-9a-f-]{36}) to continue/,
  )![1];
  assert.match(heldId, /^[0-9a-f-]{36}$/);
  const interrupted = await proposeOnce(
    ui([]).ui,
    {
      ...deps,
      activeJob: async () =>
        task({
          provider: "codex",
          id: "11111111-1111-4111-8111-111111111111",
          state: "INTERRUPTED",
        }),
    },
    new Set(),
  );
  assert.match(
    interrupted.note,
    /run tig resume 11111111-1111-4111-8111-111111111111 and then tig work 11111111-1111-4111-8111-111111111111 to continue/,
  );
  const empty = await proposeOnce(
    ui([]).ui,
    { ...deps, openTasks: async () => [] },
    new Set(),
  );
  assert.equal(empty.outcome, "none");
  assert.match(empty.note, /no open requests from other users right now/);
  const lowOnly = await proposeOnce(
    ui([]).ui,
    {
      ...deps,
      signals: async () => ({
        codex: { signal: "low" as const, detail: "Codex 85%/40% used" },
      }),
    },
    new Set(),
  );
  assert.equal(lowOnly.outcome, "none");
  assert.match(
    lowOnly.note,
    /2 open requests from other users, but none fits the tools usable here \(Codex 85%\/40% used\)/,
  );
});

test("watch mode proposes only when a tool has usage to spare, stays quiet six hours after no, and keeps going after a job", async () => {
  let now = NOW;
  let spare = false;
  const ran: string[] = [];
  const sleeps: number[] = [];
  const controller = new AbortController();
  const t = ui(["no", "yes"]);
  const deps = {
    signals: async () => ({
      codex: {
        signal: (spare ? "spare" : "normal") as "spare" | "normal",
        detail: "Codex",
      },
    }),
    installed: async () => ["codex" as const],
    openTasks: async () => [task({ provider: "codex", title: "job" })],
    run: async (rec: { task: Task }) => {
      ran.push(rec.task.title);
    },
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
      if (sleeps.length === 1) spare = true; // usage frees up after the first check
      if (sleeps.length >= 5) controller.abort();
    },
    now: () => now,
  };
  const cycles = await watchAndWork(t.ui, deps, {
    everyMs: 600000,
    signal: controller.signal,
  });
  assert.equal(cycles, 5);
  // Check 1: not spare → quiet. Check 2: spare → proposed, "no" → quiet 6h.
  // Checks 3-5 fall inside the quiet period (10 min apart) → no prompt, no run.
  assert.equal(t.asked.length, 1);
  assert.deepEqual(ran, []);
  assert.match(t.said.at(-1)!, /stay quiet for six hours/);
  // The first quiet check explained itself once; identical reasons are not repeated.
  assert.equal(t.said.filter((m) => /no usage to spare yet/.test(m)).length, 1);
  assert.equal(DECLINE_SUPPRESSION_MS, 6 * 3600000);

  // After the quiet period, the next spare check proposes again; yes runs the job.
  const t2 = ui(["yes"]);
  let now2 = NOW;
  const c2 = new AbortController();
  const ran2: string[] = [];
  let n = 0;
  await watchAndWork(
    t2.ui,
    {
      ...deps,
      signals: async () => ({
        codex: { signal: "spare" as const, detail: "Codex" },
      }),
      run: async (rec: { task: Task }) => {
        ran2.push(rec.task.title);
      },
      sleep: async (ms: number) => {
        now2 += ms;
        if (++n >= 2) c2.abort();
      },
      now: () => now2,
    },
    { everyMs: 600000, signal: c2.signal },
  );
  assert.deepEqual(ran2, ["job"]);
});

test("watch mode prints each new notification once, in quiet cycles too, and keeps going when there is nothing to work on", async () => {
  // A requester with no local AI sits in --watch: every cycle is "none", the
  // loop never ends on its own, and the submitted result shows up exactly once
  // even though the inbox keeps listing it (mark-read failed or lagging).
  let now = NOW;
  const c = new AbortController();
  const t = ui([]);
  let cycles = 0;
  const seen = new Set<string>();
  const inbox = [
    {
      id: "n1",
      line: "08:10 · Your result is ready — review it → tig approve",
    },
  ];
  const noticeCalls: number[] = [];
  const deps = {
    signals: async () => ({}),
    installed: async () => [],
    openTasks: async () => [task({ provider: "codex", title: "job" })],
    run: async () => {},
    notices: async (terminal: Terminal) => {
      noticeCalls.push(cycles);
      if (cycles === 2) throw new Error("inbox unavailable"); // never ends the watch
      for (const n of inbox)
        if (!seen.has(n.id)) {
          seen.add(n.id);
          terminal.say(n.line);
        }
    },
    sleep: async (ms: number) => {
      now += ms;
      if (++cycles >= 4) c.abort();
    },
    now: () => now,
  };
  const n = await watchAndWork(t.ui, deps, {
    everyMs: 600000,
    signal: c.signal,
  });
  assert.equal(n, 4, "nothing to work on, yet the watch went on until Ctrl+C");
  assert.deepEqual(noticeCalls, [0, 1, 2, 3], "checked every cycle");
  assert.equal(t.asked.length, 0, "no proposal without a usable tool");
  assert.deepEqual(
    t.said.filter((m) => m.includes("Your result is ready")),
    ["08:10 · Your result is ready — review it → tig approve"],
    "printed once",
  );
  assert.equal(
    t.said.filter((m) => /no usage to spare yet/.test(m)).length,
    1,
    "the reason for not proposing is still said once",
  );
});

test("watch mode survives a failed job: the error and how to continue are shown once, the request is set aside, and the next cycle proposes another; --market still fails", async () => {
  const a = task({ provider: "codex", title: "A" });
  const b = task({
    provider: "codex",
    title: "B",
    createdAt: new Date(NOW - 7200000).toISOString(),
  });
  const spare = async () => ({
    codex: { signal: "spare" as const, detail: "Codex" },
  });
  // The claim is lost while the prompt waited (another worker took it): the watch
  // reports it, sets the request aside and proposes the next one on the next check.
  let now = NOW;
  const c = new AbortController();
  const ran: string[] = [];
  let n = 0;
  const t = ui(["yes", "yes"]);
  const lost = {
    signals: spare,
    installed: async () => ["codex" as const],
    openTasks: async () => [a, b],
    activeJob: async () => null,
    run: async (rec: { task: Task }) => {
      if (rec.task.id === a.id)
        throw new Error("This request is claimed and cannot be accepted.");
      ran.push(rec.task.title);
    },
    sleep: async (ms: number) => {
      now += ms;
      if (++n >= 2) c.abort();
    },
    now: () => now,
  };
  const cycles = await watchAndWork(t.ui, lost, {
    everyMs: 600000,
    signal: c.signal,
  });
  assert.equal(cycles, 2, "the loop went on after the failure");
  assert.deepEqual(ran, ["B"], "the next cycle proposed another request");
  assert.equal(t.asked.length, 2);
  const failure = t.said.filter((m) => m.includes('"A" was not finished'));
  assert.equal(failure.length, 1, "said once, with the next check");
  assert.match(
    failure[0],
    /^\d\d:\d\d · "A" was not finished: This request is claimed and cannot be accepted\. It is set aside; I'll keep watching for other requests\. Next check in 10 min/,
  );
  assert(
    !failure[0].includes("tig work"),
    "nothing to continue when not accepted",
  );

  // The failure comes after the claim (AI timeout, push error…): the note names
  // the id and `tig work <id>`, and so does every later check while it is held.
  let held: Task | null = null;
  const t2 = ui(["yes"]);
  let now2 = NOW;
  const c2 = new AbortController();
  let n2 = 0;
  await watchAndWork(
    t2.ui,
    {
      ...lost,
      activeJob: async () => held,
      run: async (rec: { task: Task }) => {
        held = { ...rec.task, state: "EXECUTING" };
        throw new Error("Codex timed out after 20 minutes");
      },
      sleep: async (ms: number) => {
        now2 += ms;
        if (++n2 >= 2) c2.abort();
      },
      now: () => now2,
    },
    { everyMs: 600000, signal: c2.signal },
  );
  assert.equal(t2.asked.length, 1, "a held job is not proposed over");
  assert.match(
    t2.said.find((m) => m.includes('"A" was not finished'))!,
    new RegExp(
      `"A" was not finished: Codex timed out after 20 minutes\\. It is accepted for you; run tig work ${a.id} to continue and submit it\\. Next check`,
    ),
  );
  assert.match(
    t2.said.at(-1)!,
    new RegExp(
      `already working on "A" \\(executing\\); run tig work ${a.id} to continue and submit it`,
    ),
  );

  // `tig work --market` (no keepGoing) still fails the process; Ctrl+C during a
  // watched job is the user's stop, not a job failure.
  const skipped = new Set<string>();
  await assert.rejects(
    proposeOnce(ui(["yes"]).ui, lost, skipped),
    /claimed and cannot be accepted/,
  );
  assert.equal(skipped.size, 0);
  await assert.rejects(
    proposeOnce(
      ui(["yes"]).ui,
      {
        ...lost,
        run: async () => {
          throw new Cancelled();
        },
      },
      new Set(),
      { keepGoing: true },
    ),
    Cancelled,
  );
});
