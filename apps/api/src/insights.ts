import type { Tx } from "../../../packages/db/src/index.js";
import { insightReport } from "../../../packages/contracts/src/insights.js";
export const queryVersion = 1;
export function reportDay(now: Date) {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}
export async function collectInsights(
  tx: Tx,
  user: string,
  segment: "real" | "development",
  end: Date,
  generatedAt: Date,
  mode: "daily" | "preview",
) {
  const start = new Date(end.getTime() - 30 * 86400000);
  const sql = `WITH owned AS (
    SELECT t.*,p.repository FROM tasks t JOIN projects p ON p.id=t.project_id
    WHERE t.requester_id=$1 AND (t.development_fixture OR p.github_repo_id LIKE 'dev:%')=$4
  ), requested AS (SELECT * FROM owned WHERE created_at >= $2 AND created_at < $3),
  connected AS (SELECT l.project_id,l.project_type FROM project_links l JOIN projects p ON p.id=l.project_id WHERE l.user_id=$1 AND (p.github_repo_id LIKE 'dev:%')=$4),
  outcomes AS (SELECT s.* FROM settlements s JOIN owned t ON t.id=s.task_id WHERE s.created_at >= $2 AND s.created_at < $3),
  category_counts AS (SELECT spec->>'requestCategory' AS category,count(*)::int AS count FROM requested GROUP BY spec->>'requestCategory'),
  project_counts AS (SELECT r.project_id AS id,r.repository,coalesce(c.project_type,'unknown') AS "projectType",count(*)::int AS requests FROM requested r LEFT JOIN connected c ON c.project_id=r.project_id GROUP BY r.project_id,r.repository,c.project_type)
  SELECT (SELECT count(*)::int FROM requested) AS requested,
  (SELECT count(*)::int FROM connected) AS connected,
  (SELECT count(DISTINCT r.project_id)::int FROM requested r JOIN connected c ON c.project_id=r.project_id) AS active,
  (SELECT count(*)::int FROM outcomes WHERE kind='paid' AND reason='requester_approved') AS direct,
  (SELECT count(*)::int FROM outcomes WHERE kind='paid' AND reason='review_timeout') AS automatic,
  (SELECT count(*)::int FROM outcomes WHERE kind='refunded') AS refunds,
  (SELECT coalesce(sum(t.reward),0)::text FROM outcomes o JOIN owned t ON t.id=o.task_id WHERE o.kind='paid') AS paid,
  (SELECT coalesce(sum(t.reward),0)::text FROM outcomes o JOIN owned t ON t.id=o.task_id WHERE o.kind='refunded') AS restored,
  (SELECT coalesce(sum(t.reward),0)::text FROM settlements s JOIN tasks t ON t.id=s.task_id JOIN projects p ON p.id=t.project_id WHERE t.worker_id=$1 AND s.kind='paid' AND s.created_at >= $2 AND s.created_at < $3 AND (t.development_fixture OR p.github_repo_id LIKE 'dev:%')=$4) AS earned,
  coalesce((SELECT jsonb_agg(c ORDER BY c.count DESC,c.category) FROM category_counts c),'[]') AS categories,
  coalesce((SELECT jsonb_agg(p ORDER BY p.requests DESC,p.id) FROM project_counts p),'[]') AS projects`;
  const r = (await tx.query(sql, [user, start, end, segment === "development"]))
    .rows[0];
  return insightReport.parse({
    schemaVersion: 1,
    queryVersion,
    source: "server_verified",
    segment,
    mode,
    generatedAt: generatedAt.toISOString(),
    windowStart: start.toISOString(),
    windowEnd: end.toISOString(),
    requestedTasks: r.requested,
    connectedProjects: r.connected,
    activeConnectedProjects: r.active,
    directApprovals: r.direct,
    automaticPayments: r.automatic,
    refunds: r.refunds,
    paidTig: r.paid,
    refundedTig: r.restored,
    earnedTig: r.earned,
    categories: r.categories,
    projects: r.projects,
    coverage: {
      projectDenominator: "currently_linked_at_generation",
      outcomes: "settlements_in_window",
      qualityScore: null,
      events: "transaction_records",
      windowDays: 30,
    },
  });
}
export async function refreshInsights(tx: Tx, now: Date) {
  const day = reportDay(now);
  // Bound each tick. New users and interrupted batches are picked up on the next tick.
  const missing = (
    await tx.query(
      `SELECT u.id,s.segment FROM users u CROSS JOIN (VALUES ('real'),('development')) AS s(segment)
    WHERE NOT EXISTS(SELECT 1 FROM insight_snapshots i WHERE i.user_id=u.id AND i.report_day=$1::date AND i.segment=s.segment AND i.query_version=$2)
    ORDER BY u.id,s.segment LIMIT 20`,
      [day.toISOString().slice(0, 10), queryVersion],
    )
  ).rows;
  for (const row of missing) {
    const body = await collectInsights(
      tx,
      row.id,
      row.segment,
      day,
      now,
      "daily",
    );
    await tx.query(
      "INSERT INTO insight_snapshots VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
      [
        row.id,
        day.toISOString().slice(0, 10),
        row.segment,
        queryVersion,
        now,
        JSON.stringify(body),
      ],
    );
  }
  // Linked personal aggregates follow the one-year policy; these are not anonymized public statistics.
  await tx.query(
    "DELETE FROM insight_snapshots WHERE generated_at < $1::timestamptz - interval '1 year'",
    [now],
  );
  return missing.length;
}
