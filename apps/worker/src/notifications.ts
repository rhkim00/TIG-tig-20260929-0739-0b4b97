import { randomUUID } from "node:crypto";
import type { Tx } from "../../../packages/db/src/index.js";
export async function notifyEvent(tx: Tx, event: any) {
  if (
    ![
      "task.claimed",
      "task.submitted",
      "task.reopened",
      "settlement.paid",
      "settlement.refunded",
    ].includes(event.type)
  )
    return;
  const task = (
    await tx.query(
      "SELECT requester_id,worker_id,spec,reward FROM tasks WHERE id=$1",
      [event.aggregate_id],
    )
  ).rows[0];
  if (!task) return;
  const worker =
    event.payload.workerId ??
    (event.type.startsWith("settlement.") ? task.worker_id : null);
  const recipients =
    event.type === "task.claimed" || event.type === "task.submitted"
      ? [task.requester_id]
      : [task.requester_id, worker].filter(Boolean);
  const title = (
    {
      "task.claimed": "Your task was accepted",
      "task.submitted": "Your result is ready",
      "task.reopened": "Task available again",
      "settlement.paid": "Reward paid",
      "settlement.refunded": "Task refunded",
    } as Record<string, string>
  )[event.type]!;
  for (const user of new Set(recipients)) {
    const body =
      event.type === "task.submitted"
        ? "Open the result and review it within 48 hours."
        : event.type === "settlement.paid"
          ? `${task.reward} TIG was paid to the worker.`
          : event.type === "settlement.refunded"
            ? `${task.reward} TIG was restored to the requester.`
            : event.type === "task.reopened"
              ? "The previous execution permission ended. Check the latest task status."
              : "The worker has 10 minutes to start.";
    await tx.query(
      "INSERT INTO notifications(id,user_id,task_id,business_key,type,title,body,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(user_id,business_key) DO NOTHING",
      [
        randomUUID(),
        user,
        event.aggregate_id,
        event.id,
        event.type,
        title,
        body,
        event.created_at,
      ],
    );
  }
}
