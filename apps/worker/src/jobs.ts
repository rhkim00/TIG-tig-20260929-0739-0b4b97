import { type DB, transaction } from "../../../packages/db/src/index.js";
import { grantDue } from "../../api/src/domain.js";
import { lifecycleDue } from "../../api/src/lifecycle.js";
import { notifyEvent } from "./notifications.js";
import { refreshInsights } from "../../api/src/insights.js";
export async function tick(db: DB, now = new Date()) {
  // A report or inbox failure must not roll back a due financial settlement.
  const financial = await transaction(db, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(709005)");
    return {
      grants: await grantDue(tx, now),
      expired: await lifecycleDue(tx, now),
    };
  });
  const events = await transaction(db, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(709007)");
    const rows = (
      await tx.query(
        "SELECT * FROM outbox WHERE published_at IS NULL ORDER BY created_at,id LIMIT 100 FOR UPDATE SKIP LOCKED",
      )
    ).rows;
    for (const e of rows) {
      await tx.query(
        "INSERT INTO operational_events VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
        [e.id, e.type, e.payload, e.created_at],
      );
      await notifyEvent(tx, e);
      await tx.query("UPDATE outbox SET published_at=$2 WHERE id=$1", [
        e.id,
        now,
      ]);
    }
    await tx.query("DELETE FROM oauth_states WHERE expires_at<$1", [now]);
    await tx.query("DELETE FROM sessions WHERE expires_at<$1", [now]);
    await tx.query("DELETE FROM pairings WHERE expires_at<$1", [now]);
    await tx.query(
      "DELETE FROM notifications WHERE created_at < $1::timestamptz - interval '1 year'",
      [now],
    );
    return rows.length;
  });
  const insights = await transaction(db, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(709008)");
    return refreshInsights(tx, now);
  });
  return { ...financial, events, insights };
}
