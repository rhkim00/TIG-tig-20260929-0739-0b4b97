import React, { useEffect, useState } from "react";
import { request } from "./api.js";
import {
  inboxView,
  type Inbox,
} from "../../../packages/contracts/src/insights.js";
export function InboxPanel({
  userId,
  onOpen,
  onRead,
}: {
  userId: string;
  onOpen: (id: string) => Promise<void>;
  onRead: () => Promise<void>;
}) {
  const [inbox, setInbox] = useState<Inbox | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    const read = async () => {
      try {
        const value = inboxView.parse(await request("/v1/notifications"));
        if (alive) {
          setInbox((old) =>
            old && old.notifications.length > 50
              ? {
                  ...value,
                  notifications: [
                    ...value.notifications,
                    ...old.notifications.filter(
                      (n) =>
                        !value.notifications.some((fresh) => fresh.id === n.id),
                    ),
                  ],
                  nextCursor: old.nextCursor,
                }
              : value,
          );
          setError("");
        }
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    };
    void read();
    const timer = setInterval(() => {
      if (!document.hidden) void read();
    }, 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [userId]);
  async function loadMore() {
    if (!inbox?.nextCursor) return;
    setBusy(true);
    try {
      const params = new URLSearchParams(inbox.nextCursor);
      const next = inboxView.parse(
        await request(`/v1/notifications?${params}`),
      );
      setInbox({
        ...next,
        notifications: [...inbox.notifications, ...next.notifications].filter(
          (v, i, a) => a.findIndex((n) => n.id === v.id) === i,
        ),
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function mark(id: string) {
    await request(`/v1/notifications/${id}/read`, {});
    setInbox((old) =>
      old
        ? {
            ...old,
            unreadCount: Math.max(
              0,
              old.unreadCount -
                Number(old.notifications.some((n) => n.id === id && !n.readAt)),
            ),
            notifications: old.notifications.map((n) =>
              n.id === id
                ? { ...n, readAt: n.readAt ?? new Date().toISOString() }
                : n,
            ),
          }
        : old,
    );
    await onRead();
  }
  async function open(id: string, task: string) {
    setBusy(true);
    setError("");
    try {
      await onOpen(task);
      await mark(id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel inbox-panel" aria-label="Task notifications">
      <div className="section-heading">
        <div>
          <h2>Your task updates</h2>
          <p>
            Results, payments and refunds. Open an update to see what needs your
            attention.
          </p>
        </div>
        <span className="pill">{inbox?.unreadCount ?? 0} unread</span>
      </div>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {!inbox && !error && <p role="status">Loading updates…</p>}
      {inbox && !inbox.notifications.length && (
        <div className="empty">
          <h3>You’re all caught up</h3>
          <p>
            When someone accepts your task or submits a result, it will appear
            here.
          </p>
        </div>
      )}
      {inbox?.notifications.map((n) => (
        <article
          key={n.id}
          className={`notification-row ${n.readAt ? "" : "unread"}`}
        >
          <div>
            <span className="eyebrow">
              {n.readAt ? "UPDATE" : "NEW UPDATE"}
            </span>
            <h3>{n.title}</h3>
            <p>{n.body}</p>
            <small>{new Date(n.createdAt).toLocaleString()}</small>
          </div>
          <div className="notification-actions">
            <button
              className="button secondary small"
              disabled={busy}
              onClick={() => void open(n.id, n.taskId)}
            >
              Open task
            </button>
            {!n.readAt && (
              <button
                className="text-link"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void mark(n.id)
                    .catch((e) => setError(e.message))
                    .finally(() => setBusy(false));
                }}
              >
                Mark read
              </button>
            )}
          </div>
        </article>
      ))}
      {inbox?.nextCursor && (
        <button
          className="button secondary"
          disabled={busy}
          onClick={() => void loadMore()}
        >
          Load older updates
        </button>
      )}
      <p className="inbox-note">
        These are in-app updates. Email delivery is not connected yet.
      </p>
    </section>
  );
}
