import React, { useEffect, useState } from "react";
import { request } from "./api.js";
import {
  insightReport,
  type InsightReport,
} from "../../../packages/contracts/src/insights.js";
const label = (s: string) =>
  (
    ({
      build: "New projects",
      feature: "Features",
      bug: "Bug fixes",
      refactor: "Refactoring",
      test: "Tests",
      review: "Code reviews",
      docs: "Documentation",
      setup: "Setup",
      other: "Other",
    }) as Record<string, string>
  )[s] ?? s;
const tig = (value: string) => {
  const [whole, fraction] = value.split(".");
  return (
    BigInt(whole!).toLocaleString() +
    (fraction && Number(fraction) ? "." + fraction : "")
  );
};
export function InsightsPanel({
  userId,
  development,
}: {
  userId: string;
  development: boolean;
}) {
  const [sample, setSample] = useState(false),
    [report, setReport] = useState<InsightReport | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    setReport(null);
    setLoading(true);
    setError("");
    const read = async () => {
      try {
        const data = await request(
          sample
            ? "/v1/insights?segment=development&preview=true"
            : "/v1/insights",
        );
        if (alive) {
          setReport(data.report ? insightReport.parse(data.report) : null);
          setError("");
        }
      } catch (e) {
        if (alive) setError((e as Error).message);
      } finally {
        if (alive) setLoading(false);
      }
    };
    void read();
    const timer = setInterval(() => void read(), 30000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [userId, sample]);
  return (
    <section className="insights-panel" aria-label="Your project insights">
      <div className="panel">
        <div className="section-heading">
          <div>
            <h2>Understand your work</h2>
            <p>
              Only your requests, projects and earned TIG. No other user’s
              project details.
            </p>
          </div>
        </div>
        {development && (
          <label className="sample-toggle">
            <input
              type="checkbox"
              checked={sample}
              onChange={(e) => setSample(e.target.checked)}
            />
            Show live sample activity
          </label>
        )}
        <p>
          {sample
            ? "Live development preview · Sample activity is excluded from real reports."
            : "Updated daily · Last 30 days through 00:00 UTC. Today’s activity appears in the next daily report."}
        </p>
      </div>
      {error && (
        <p role="alert" className="alert">
          {error}
        </p>
      )}
      {loading && <p role="status">Loading insights…</p>}
      {!loading && !error && !report && (
        <div className="panel empty">
          <h3>Your first report is on its way</h3>
          <p>
            The background worker prepares your daily report. This page will
            refresh automatically.
          </p>
        </div>
      )}
      {report && (
        <>
          <div className="insight-stats">
            <div className="stat-card">
              <span className="card-label">TASKS REQUESTED</span>
              <strong className="stat-number">{report.requestedTasks}</strong>
              <p>Posted during this 30-day window</p>
            </div>
            <div className="stat-card">
              <span className="card-label">PROJECTS USING TOKENISGOLD</span>
              <strong className="stat-number">
                {report.activeConnectedProjects} / {report.connectedProjects}
              </strong>
              <p>Currently connected projects with a request in this window</p>
            </div>
            <div className="stat-card">
              <span className="card-label">TIG EARNED</span>
              <strong className="stat-number">{tig(report.earnedTig)}</strong>
              <p>Rewards paid to you during this window</p>
            </div>
          </div>
          <div className="insight-columns">
            <section className="panel">
              <h2>What you ask for</h2>
              {report.categories.length ? (
                report.categories.map((c) => (
                  <div className="category-row" key={c.category}>
                    <div>
                      <span>{label(c.category)}</span>
                      <strong>
                        {c.count} / {report.requestedTasks}
                      </strong>
                    </div>
                    <meter
                      min={0}
                      max={report.requestedTasks || 1}
                      value={c.count}
                      aria-label={`${label(c.category)} requests`}
                    />
                  </div>
                ))
              ) : (
                <p>
                  No requests in this period. Your first task will start the
                  story.
                </p>
              )}
            </section>
            <section className="panel">
              <h2>How tasks were settled</h2>
              <dl className="outcome-list">
                <div>
                  <dt>Direct approvals</dt>
                  <dd>{report.directApprovals}</dd>
                </div>
                <div>
                  <dt>Automatic payments</dt>
                  <dd>{report.automaticPayments}</dd>
                </div>
                <div>
                  <dt>Refunds</dt>
                  <dd>{report.refunds}</dd>
                </div>
                <div>
                  <dt>TIG paid for your requests</dt>
                  <dd>{tig(report.paidTig)}</dd>
                </div>
                <div>
                  <dt>TIG restored to you</dt>
                  <dd>{tig(report.refundedTig)}</dd>
                </div>
              </dl>
              <p>
                Settlements during this period may belong to earlier requests.
                Automatic payment does not mean quality was approved.
              </p>
            </section>
          </div>
          <section className="panel">
            <h2>Your projects</h2>
            {report.projects.length ? (
              report.projects.map((p) => (
                <div className="insight-project" key={p.id}>
                  <div>
                    <strong>{p.repository}</strong>
                    <small>{p.projectType.replaceAll("_", " ")}</small>
                  </div>
                  <span>
                    {p.requests} {p.requests === 1 ? "request" : "requests"}
                  </span>
                </div>
              ))
            ) : (
              <p>No project activity yet.</p>
            )}
          </section>
          <p className="insight-provenance">
            {new Date(report.windowStart).toLocaleDateString()} –{" "}
            {new Date(report.windowEnd).toLocaleDateString()} (end exclusive) ·
            Generated {new Date(report.generatedAt).toLocaleString()} ·
            Transaction records · Query v{report.queryVersion}. Project usage
            refers to your connected projects, not the GitHub market.
          </p>
        </>
      )}
    </section>
  );
}
