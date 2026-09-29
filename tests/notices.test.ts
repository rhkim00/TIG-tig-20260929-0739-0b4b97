import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  MAX_NOTICES,
  NoticeBoard,
  nextCommand,
  noticeLine,
  startWithNotices,
  type Notice,
} from "../apps/cli/src/notices.js";

// Anchored to today, because noticeLine prints HH:MM for today and MM-DD HH:MM
// for anything older: a fixed calendar date passes until that date is yesterday.
// Local noon keeps the hour-ago and minutes-ago fixtures below on this same day.
const NOW = new Date().setHours(12, 0, 0, 0);
function notice(over: Partial<Notice> = {}): Notice {
  return {
    id: randomUUID(),
    taskId: "3f2a1b4c-0000-4000-8000-000000000001",
    type: "task.submitted",
    title: "Your result is ready",
    body: "Open the result and review it within 48 hours.",
    createdAt: new Date(NOW).toISOString(),
    readAt: null,
    ...over,
  };
}
function fakeApi(unread: Notice[]) {
  const calls: string[] = [];
  const api = async (path: string, options: any = {}) => {
    calls.push(path);
    if (path === "/v1/notifications")
      return {
        notifications: [...unread].sort(
          (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
        ),
        unreadCount: unread.filter((n) => !n.readAt).length,
        nextCursor: null,
      };
    const m = path.match(/^\/v1\/notifications\/([^/]+)\/read$/);
    if (m) {
      assert.deepEqual(options.body, {});
      assert.equal(options.key, `notice-read:${m[1]}`);
      return { id: m[1], readAt: new Date(NOW).toISOString() };
    }
    throw new Error(`unexpected ${path}`);
  };
  return { api: api as any, calls };
}
const ui = () => {
  const said: string[] = [];
  return { said, say: (m: string) => said.push(m) };
};

test("each notification is one line with the command that continues, per type", () => {
  const id = "3f2a1b4c-0000-4000-8000-000000000001";
  // Requester: a submitted result is reviewed and approved.
  assert.equal(
    nextCommand({ type: "task.submitted", taskId: id }),
    `tig task ${id} · tig approve ${id} --yes`,
  );
  // Worker (and requester): payment shows in the wallet.
  assert.equal(
    nextCommand({ type: "settlement.paid", taskId: id }),
    "tig status",
  );
  assert.equal(
    nextCommand({ type: "task.approved", taskId: id }),
    "tig status",
  );
  // Refund / issue: read the task.
  assert.equal(
    nextCommand({ type: "settlement.refunded", taskId: id }),
    `tig task ${id}`,
  );
  assert.equal(
    nextCommand({ type: "task.issue", taskId: id }),
    `tig task ${id}`,
  );
  // Reopened / expired: the request can be worked again.
  assert.equal(
    nextCommand({ type: "task.reopened", taskId: id }),
    `tig work ${id}`,
  );
  assert.equal(
    nextCommand({ type: "task.expired", taskId: id }),
    `tig work ${id}`,
  );
  // Accepted and anything unknown: read the task.
  assert.equal(
    nextCommand({ type: "task.claimed", taskId: id }),
    `tig task ${id}`,
  );
  assert.equal(
    nextCommand({ type: "something.new", taskId: id }),
    `tig task ${id}`,
  );
  const line = noticeLine(
    notice({
      type: "settlement.paid",
      title: "Reward paid",
      body: "50 TIG was paid to the worker.",
    }),
  );
  assert.match(
    line,
    /^\d\d:\d\d · Reward paid — 50 TIG was paid to the worker\. → tig status$/,
  );
});

test("only unread notices are printed, oldest first, and exactly those are marked read", async () => {
  const older = notice({
    type: "task.claimed",
    title: "Your task was accepted",
    body: "The worker has 10 minutes to start.",
    createdAt: new Date(NOW - 3600000).toISOString(),
  });
  const newer = notice();
  const read = notice({
    type: "settlement.paid",
    title: "Reward paid",
    body: "old",
    readAt: new Date(NOW - 86400000).toISOString(),
  });
  const { api, calls } = fakeApi([newer, read, older]);
  const board = new NoticeBoard({ api });
  const t = ui();
  const shown = await board.show(t);
  assert.deepEqual(
    shown.map((n) => n.id),
    [older.id, newer.id],
    "chronological, read ones skipped",
  );
  assert.equal(t.said.length, 2);
  assert.match(
    t.said[0],
    /Your task was accepted — The worker has 10 minutes to start\. → tig task /,
  );
  assert.match(
    t.said[1],
    /Your result is ready — .* → tig task .* · tig approve .* --yes$/,
  );
  assert.deepEqual(calls, [
    "/v1/notifications",
    `/v1/notifications/${older.id}/read`,
    `/v1/notifications/${newer.id}/read`,
  ]);
  // Nothing new: silent, and no read calls.
  const quiet = ui();
  assert.deepEqual(await board.show(quiet), []);
  assert.deepEqual(quiet.said, []);
  assert.deepEqual(calls.slice(3), ["/v1/notifications"]);
});

test("a notice is printed once per process even when marking it read failed; inbox errors are silent", async () => {
  const n = notice();
  let reads = 0;
  const board = new NoticeBoard({
    api: (async (path: string) => {
      if (path === "/v1/notifications")
        return { notifications: [n], unreadCount: 1, nextCursor: null };
      reads++;
      throw new Error("REQUEST_FAILED: read endpoint down");
    }) as any,
  });
  const t = ui();
  assert.equal((await board.show(t)).length, 1);
  assert.equal(
    (await board.show(t)).length,
    0,
    "the server still lists it; not repeated",
  );
  assert.equal(t.said.length, 1);
  assert.equal(
    reads,
    1,
    "never marked read twice; never marked read without printing",
  );
  // Not connected / offline: nothing said, nothing thrown.
  const offline = new NoticeBoard({
    api: async () => {
      throw new Error(
        "Connect this device first: tig connect --origin <website>",
      );
    },
  });
  const o = ui();
  assert.deepEqual(await offline.show(o), []);
  assert.deepEqual(o.said, []);
});

test("at most ten (the newest) are shown, the rest are pointed to tig inbox and stay unread", async () => {
  const many = Array.from({ length: 13 }, (_, i) =>
    notice({
      title: `update ${i}`,
      createdAt: new Date(NOW - (13 - i) * 60000).toISOString(),
    }),
  );
  const { api, calls } = fakeApi(many);
  const t = ui();
  const shown = await new NoticeBoard({ api }).show(t);
  assert.equal(MAX_NOTICES, 10);
  assert.equal(shown.length, 10);
  assert.match(t.said[0], /update 3 —/);
  assert.match(t.said[9], /update 12 —/);
  assert.equal(t.said[10], "3 older updates: tig inbox");
  assert.equal(calls.filter((c) => c.endsWith("/read")).length, 10);
  for (const skipped of many.slice(0, 3))
    assert(!calls.includes(`/v1/notifications/${skipped.id}/read`));
});

test("tig prints what happened since last time before the requester wizard starts", async () => {
  const order: string[] = [];
  const { api } = fakeApi([notice()]);
  const result = await startWithNotices(
    new NoticeBoard({ api }),
    { say: (m) => order.push(`notice: ${m}`) },
    async () => {
      order.push("wizard");
      return "done";
    },
  );
  assert.equal(result, "done");
  assert.equal(order.length, 2);
  assert.match(order[0], /^notice: \d\d:\d\d · Your result is ready/);
  assert.equal(order[1], "wizard");
  // Offline: the wizard still runs (it will offer to connect).
  const alone: string[] = [];
  await startWithNotices(
    new NoticeBoard({
      api: async () => {
        throw new Error("not connected");
      },
    }),
    { say: (m) => alone.push(m) },
    async () => alone.push("wizard"),
  );
  assert.deepEqual(alone, ["wizard"]);
});
