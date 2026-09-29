// Both sides of a transaction are told in their terminal what happened to it
// (P-053: telling is not accepting). The server keeps one notification per user
// and event (apps/worker/src/notifications.ts); this module prints the unread ones
// as one line each with the command that continues, and marks read only what it
// printed. Everything here is best effort: an inbox that cannot be read never
// stops the wizard or the watch.
import { z } from "zod";
import { notificationView } from "../../../packages/contracts/src/insights.js";
import type { api } from "./client.js";
import { terminalText, type Terminal } from "./terminal.js";

export type Notice = z.infer<typeof notificationView>;
export type NoticeApi = typeof api;
export interface NoticeDeps {
  api: NoticeApi;
  now?: () => number;
}
// The most recent unread items are shown (oldest first); older ones stay in tig inbox.
export const MAX_NOTICES = 10;
const inbox = z.object({ notifications: z.array(notificationView) });

// The command that continues the transaction, derived from the event type only
// (the notice carries no role: a reopened task is worked, a paid one is checked
// in the wallet, everything else is read with tig task).
export function nextCommand(notice: Pick<Notice, "type" | "taskId">) {
  const kind = notice.type.split(".").pop() ?? notice.type;
  if (kind === "submitted")
    return `tig task ${notice.taskId} · tig approve ${notice.taskId} --yes`;
  if (kind === "paid" || kind === "approved") return "tig status";
  if (kind === "reopened" || kind === "expired")
    return `tig work ${notice.taskId}`;
  // claimed, refunded, issue and anything new: read the task.
  return `tig task ${notice.taskId}`;
}
// HH:MM for today; older updates carry their date so a backlog reads in order.
const clock = (iso: string, now = new Date()) => {
  const at = new Date(iso);
  const time = at.toTimeString().slice(0, 5);
  return at.toDateString() === now.toDateString()
    ? time
    : `${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")} ${time}`;
};
export const noticeLine = (notice: Notice) =>
  `${clock(notice.createdAt)} · ${notice.title} — ${notice.body} → ${nextCommand(notice)}`;

// Chronological order for reading; the server lists newest first.
const byAge = (a: Notice, b: Notice) =>
  Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id);

// One board per process: an id printed once is never printed again, even when
// marking it read failed and the server still lists it as unread.
export class NoticeBoard {
  private seen = new Set<string>();
  constructor(private deps: NoticeDeps) {}
  // Print unread, not-yet-shown notices (newest MAX_NOTICES, oldest first), then
  // mark exactly those read. Silent when there is nothing; never throws.
  async show(ui: Pick<Terminal, "say">): Promise<Notice[]> {
    let unread: Notice[];
    try {
      unread = inbox
        .parse(await this.deps.api("/v1/notifications"))
        .notifications.filter((n) => !n.readAt && !this.seen.has(n.id))
        .sort(byAge);
    } catch {
      return []; // not connected, offline, or an unexpected shape: say nothing
    }
    const shown = unread.slice(-MAX_NOTICES);
    for (const notice of shown) {
      this.seen.add(notice.id);
      ui.say(noticeLine(notice));
    }
    if (unread.length > shown.length)
      ui.say(`${unread.length - shown.length} older updates: tig inbox`);
    for (const notice of shown)
      try {
        await this.deps.api(`/v1/notifications/${notice.id}/read`, {
          body: {},
          key: `notice-read:${notice.id}`,
        });
      } catch {
        /* still unread on the server; this process will not repeat it */
      }
    return shown;
  }
}

// What happened since last time, before the wizard continues.
export async function startWithNotices<T>(
  board: NoticeBoard,
  ui: Pick<Terminal, "say">,
  run: () => Promise<T>,
): Promise<T> {
  await board.show(ui);
  return run();
}
// Same indentation as RequestTerminal.say, for a command that has no terminal yet.
export const consoleNotices: Pick<Terminal, "say"> = {
  say: (message) =>
    process.stdout.write(
      "  " + terminalText(message).replaceAll("\n", "\n  ") + "\n",
    ),
};
