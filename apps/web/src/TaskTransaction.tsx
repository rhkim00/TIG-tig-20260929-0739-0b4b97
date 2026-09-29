import React, { useCallback, useEffect, useState } from "react";
import { downloadJson } from "./download.js";
import { request } from "./api.js";
import type { TaskView } from "../../../packages/contracts/src/index.js";
import { fixtureContent } from "../../../packages/contracts/src/lifecycle.js";
// Detail-endpoint fields beyond taskView (participants only); index.ts is unchanged.
export type RequestLocation = {
  repository: string;
  branch: string;
  sourceCommit: string;
  requestPath: string;
};
export type TaskDetail = TaskView & {
  scope: string;
  acceptanceChecks: string[];
  submission: any;
  artifacts: any[];
  gitRequest?: RequestLocation | null;
  layout?: "bundle" | "tree" | null;
};
// Tree layout: the branch root is the whole project, so name the branch and the
// pinned commit (from requestUrl) instead of promising a code/ bundle.
export function requestLinkText(
  task: Pick<TaskDetail, "gitRequest" | "layout" | "requestUrl">,
) {
  const commit = task.requestUrl?.match(/\/blob\/([a-f0-9]{40})\//)?.[1];
  if (task.layout === "tree" && task.gitRequest)
    return `Request branch ${task.gitRequest.branch}${commit ? ` @ ${commit.slice(0, 7)}` : ""} — whole project tree, request.md at root`;
  return "View request.md & code on GitHub";
}
// A submission may mirror only report.md when the change set does not fit the
// platform artifact; the review surface is then the pull request, or — when
// `gh pr create` failed and no open pull request was found — the result branch
// and commit the row above already names. Deleted paths are mirrored even when
// no file content is, so they are named here instead of being called nothing.
export function resultFilesNote(
  files: { path: string }[] | undefined,
  gitResult:
    | { branch?: string; commit?: string; pullRequestUrl?: string | null }
    | null
    | undefined,
  deletedPaths?: string[] | null,
) {
  if (!files || !gitResult) return null;
  if (files.length !== 1 || files[0].path !== "report.md") return null;
  const where = gitResult.pullRequestUrl
    ? "the pull request"
    : gitResult.branch && gitResult.commit
      ? `branch ${gitResult.branch} at commit ${gitResult.commit.slice(0, 7)}`
      : "the result branch above";
  const deleted = deletedPaths?.length ?? 0;
  const mirrored = deleted
    ? `report.md and ${deleted} deleted file${deleted === 1 ? "" : "s"} are`
    : "only report.md is";
  return `Changed files are in ${where}; ${mirrored} mirrored here.`;
}
async function sha(value: string) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  ]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
}
export function TaskTransaction({
  id,
  userId,
  onChange,
}: {
  id: string;
  userId: string;
  onChange: () => Promise<void>;
}) {
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  const [content, setContent] = useState(fixtureContent);
  const refresh = useCallback(async () => {
    setTask(await request(`/v1/tasks/${id}`));
  }, [id]);
  useEffect(() => {
    let active = true;
    const read = async () => {
      try {
        const value = await request(`/v1/tasks/${id}`);
        if (active) setTask(value);
      } catch (e) {
        if (active) setError((e as Error).message);
      }
    };
    void read();
    const timer = setInterval(() => void read(), 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [id]);
  async function act(action: string, extra: Record<string, unknown> = {}) {
    if (!task) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await request(`/v1/tasks/${id}/${action}`, {
        expectedVersion: task.version,
        ...extra,
      });
      setNotice(
        result.state === "PAID"
          ? "Reward paid. This task is closed."
          : result.state === "REFUNDED"
            ? "All TIG restored to the requester. This task is closed."
            : action === "submit"
              ? "Result submitted. The requester has 48 hours to review."
              : "Task updated.",
      );
      await refresh();
      await onChange();
    } catch (e) {
      setError((e as Error).message);
      await refresh().catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  async function submit() {
    if (!task) return;
    try {
      const files = [
        {
          path: "wallet-labels.json",
          content,
          sha256: await sha(content),
          source: "tracked",
        },
      ];
      const entries = files.map(({ path, sha256, source }) => ({
        path,
        sha256,
        source,
      }));
      // Server canonical serialization sorts object keys.
      const canonical = JSON.stringify(
        entries.map((e) => ({
          path: e.path,
          sha256: e.sha256,
          source: e.source,
        })),
      );
      await act("submit", {
        generation: task.generation,
        report:
          "Updated the three wallet labels for the local transaction exercise. No AI provider was called.",
        artifact: {
          baseCommit: task.artifacts[0].base_commit,
          summary: "Local test result: updated the requested wallet labels.",
          files,
          deletedPaths: [],
          manifestHash: await sha(canonical),
        },
      });
    } catch (e) {
      setError((e as Error).message);
    }
  }
  if (!task)
    return error ? (
      <div role="alert">
        <p>{error}</p>
        <button
          className="button secondary"
          onClick={() =>
            void refresh()
              .then(() => setError(""))
              .catch((e) => setError(e.message))
          }
        >
          Try again
        </button>
      </div>
    ) : (
      <p role="status">Loading task…</p>
    );
  const owner = task.requesterId === userId,
    worker = task.workerId === userId;
  return (
    <div className="transaction-panel">
      <div className="detail-meta">
        <span className="pill">
          {task.state.replaceAll("_", " ").toLowerCase()}
        </span>
        <strong>{Number(task.rewardTig).toLocaleString()} TIG</strong>
      </div>
      <p>{task.scope}</p>
      {task.requestUrl && (
        <p>
          <a href={task.requestUrl} target="_blank" rel="noopener noreferrer">
            {requestLinkText(task)}
          </a>
        </p>
      )}
      <p className="info-box">
        {task.developmentFixture
          ? "Local test: sample TIG, a JSON file update, and real server checks. No AI subscription usage."
          : "Real AI execution is pending runner verification."}
      </p>
      <details>
        <summary>Requirements & timing</summary>
        <ul>
          {(task.acceptanceChecks ?? []).map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
        <p>Complete by {new Date(task.executionDeadlineAt).toLocaleString()}</p>
        {task.phaseDueAt && (
          <p>Start / resume by {new Date(task.phaseDueAt).toLocaleString()}</p>
        )}
        <p>
          Requested: {task.aiRequirement.provider} · {task.aiRequirement.model}{" "}
          · {task.aiRequirement.effort} ({task.aiRequirement.source})
        </p>
      </details>
      {task.reviewDueAt && (
        <p>
          Review by{" "}
          <strong>{new Date(task.reviewDueAt).toLocaleString()}</strong>. No
          response within 48 hours pays the worker automatically.
        </p>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {task.state === "OPEN" && !owner && (
        <button
          className="button primary"
          disabled={busy || !task.developmentFixture}
          onClick={() => void act("claim", { consent: "accept_this_task" })}
        >
          Yes, accept this task
        </button>
      )}
      {worker && task.state === "CLAIMED" && (
        <button
          className="button primary"
          disabled={busy}
          onClick={() => void act("start", { generation: task.generation })}
        >
          Start local test
        </button>
      )}
      {worker && task.state === "EXECUTING" && (
        <div className="form-stack">
          <label>
            Result file: wallet-labels.json
            <textarea
              aria-label="Result file"
              rows={6}
              value={content}
              onChange={(e) => setContent(e.target.value)}
            />
          </label>
          <p>
            The sample result is filled in. Edit it to try a failed check, or
            submit it as shown.
          </p>
          <div className="transaction-actions">
            <button
              className="button primary"
              disabled={busy}
              onClick={() => void submit()}
            >
              Submit result
            </button>
            <button
              className="button secondary"
              disabled={busy}
              onClick={() =>
                void act("interrupt", { generation: task.generation })
              }
            >
              Pause task
            </button>
          </div>
        </div>
      )}
      {worker && task.state === "INTERRUPTED" && (
        <button
          className="button primary"
          disabled={busy}
          onClick={() => void act("resume", { generation: task.generation })}
        >
          Resume task
        </button>
      )}
      {task.submission && (
        <section>
          <div className="result-heading">
            <h3>Submitted result</h3>
            <button
              className="button secondary small"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setError("");
                void request(`/v1/tasks/${id}/result`)
                  .then((value) =>
                    downloadJson(value, `tokenisgold-result-${id}.json`),
                  )
                  .catch((e) => setError(e.message))
                  .finally(() => setBusy(false));
              }}
            >
              Download result
            </button>
          </div>
          <p>{task.submission.report}</p>
          {/* Checks come from the server record; nothing here is invented client-side. */}
          <ul className="check-list">
            {(task.submission.checks ?? []).map(
              (c: {
                name: string;
                status: string;
                source: string;
                reason?: string;
              }) => (
                <li key={c.name}>
                  <strong>
                    {c.status === "passed"
                      ? "Passed"
                      : c.status === "not_run"
                        ? "Not run"
                        : c.status}
                  </strong>
                  {" · "}
                  {c.name}
                  {" · "}
                  {c.source === "server_verified"
                    ? "verified by Tokenisgold"
                    : "reported by the worker — not verified"}
                  {c.reason ? ` — ${c.reason}` : ""}
                </li>
              ),
            )}
          </ul>
          <p>
            AI execution: not verified
            {task.submission.execution?.provider
              ? ` · worker reported ${task.submission.execution.provider}${task.submission.execution.requestedModel ? ` / ${task.submission.execution.requestedModel}` : ""}`
              : ""}
          </p>
          {task.submission.gitResult && (
            <p>
              Result in Git:{" "}
              <a
                href={
                  task.submission.gitResult.pullRequestUrl ??
                  `https://github.com/${task.submission.gitResult.repository}/tree/${task.submission.gitResult.branch}`
                }
                target="_blank"
                rel="noreferrer"
              >
                {task.submission.gitResult.pullRequestUrl
                  ? "open the pull request"
                  : `${task.submission.gitResult.repository} · ${task.submission.gitResult.branch}`}
              </a>{" "}
              · commit {task.submission.gitResult.commit.slice(0, 7)} ·
              approving here pays TIG; merging is your separate decision.
            </p>
          )}
          {task.artifacts
            .filter((a) => a.id === task.submission.artifactId)
            .map((a) => {
              const deleted: string[] = a.deleted_paths ?? [];
              const note = resultFilesNote(
                a.files,
                task.submission.gitResult,
                deleted,
              );
              return (
                <details key={a.id} open>
                  <summary>View submitted files</summary>
                  {note && <p>{note}</p>}
                  {deleted.length > 0 && (
                    <p>Deleted in this result: {deleted.join(", ")}</p>
                  )}
                  {a.files.map((f: any) => (
                    <div key={f.path}>
                      <strong>{f.path}</strong>
                      <pre>{f.content}</pre>
                    </div>
                  ))}
                </details>
              );
            })}
        </section>
      )}
      {owner && task.state === "AWAITING_REVIEW" && (
        <div className="transaction-actions review-actions">
          <button
            className="button primary"
            disabled={busy}
            onClick={() => void act("approve")}
          >
            Approve & pay {Number(task.rewardTig).toLocaleString()} TIG
          </button>
          <button
            className="button secondary"
            disabled={busy}
            onClick={() => void act("issue")}
          >
            Report an issue & refund
          </button>
          <p>
            Reporting an issue closes this task and restores your full reward.
            Applying code to your project is a separate action.
          </p>
        </div>
      )}
      {["PAID", "REFUNDED"].includes(task.state) && (
        <p>
          This task is closed.{" "}
          {task.state === "PAID"
            ? "The reward is in the worker’s wallet."
            : "The full reward was returned to the requester."}
        </p>
      )}
    </div>
  );
}
