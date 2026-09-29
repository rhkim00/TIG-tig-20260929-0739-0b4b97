import Fastify, { type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import staticFiles from "@fastify/static";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import {
  projectSchema,
  taskSpec,
  observationSchema,
  usageSignal,
  POLICY_VERSION,
  money,
  cents,
} from "../../../packages/contracts/src/index.js";
import {
  type DB,
  DomainError,
  hash,
  transaction,
  idempotent,
  upsertUser,
} from "../../../packages/db/src/index.js";
import { cancelTask, publish, uploadArtifact, viewTask } from "./domain.js";
import { verifyGitRequest, artifactLayout } from "./request-publication.js";
import { githubClient, type GitHub } from "./github.js";
import { openapi } from "../../../packages/contracts/src/openapi.js";
import type { Config } from "./config.js";
import {
  claimBody,
  executionBody,
  submitBody,
  versionBody,
} from "../../../packages/contracts/src/lifecycle.js";
import {
  claimTask,
  executionAction,
  submitResult,
  reviewTask,
  createFixture,
} from "./lifecycle.js";
import { collectInsights, reportDay, queryVersion } from "./insights.js";
import { insightSegment } from "../../../packages/contracts/src/insights.js";
const opaque = () => randomBytes(32).toString("base64url");
const idSchema = z.object({ id: z.uuid() });
// X-Tig-Capabilities: space/comma separated feature names a CLI can handle
// (e.g. "request-tree"). Browsers and old CLIs send none.
export function clientCapabilities(req: FastifyRequest) {
  const raw = req.headers["x-tig-capabilities"];
  return new Set(
    (Array.isArray(raw) ? raw.join(" ") : (raw ?? ""))
      .split(/[\s,]+/)
      .filter(Boolean),
  );
}
export async function buildApp(
  config: Config,
  db: DB,
  github: GitHub = githubClient(config),
  rateLimitKey?: (request: FastifyRequest) => string,
) {
  if (
    config.devMode &&
    (config.production ||
      !["localhost", "127.0.0.1", "::1"].includes(
        new URL(config.origin).hostname,
      ) ||
      !["localhost", "127.0.0.1", "::1"].includes(config.host))
  )
    throw new Error("Unsafe development mode");
  const app = Fastify({
    logger: false,
    bodyLimit: 1_200_000,
    trustProxy: false,
  });
  await app.register(cookie);
  await app.register(rateLimit, {
    max: 600,
    timeWindow: "1 minute",
    ...(rateLimitKey ? { keyGenerator: rateLimitKey } : {}),
  });
  app.addHook("onSend", async (_req, reply, payload) => {
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer")
      .header("Cache-Control", "no-store");
    if (config.production)
      reply.header(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      );
    return payload;
  });
  app.setErrorHandler(
    (error: Error & { statusCode?: number; code?: string }, request, reply) => {
      const validation = error instanceof z.ZodError;
      const status =
        error instanceof DomainError
          ? error.status
          : validation
            ? 422
            : error.statusCode && error.statusCode < 500
              ? error.statusCode
              : 500;
      reply.code(status).send({
        code:
          error instanceof DomainError
            ? error.code
            : validation
              ? "INVALID_INPUT"
              : status < 500
                ? "REQUEST_REJECTED"
                : "INTERNAL_ERROR",
        message:
          error instanceof DomainError
            ? error.message
            : validation
              ? "Some fields are missing or invalid."
              : status < 500
                ? "This request could not be accepted."
                : "The request could not be completed.",
        retryable: status >= 500,
        requestId: request.id,
      });
    },
  );
  async function actor(
    req: FastifyRequest,
    mutation = false,
    browserOnly = false,
  ): Promise<string> {
    const bearer = req.headers.authorization?.match(
      /^Bearer ([A-Za-z0-9_-]{40,128})$/,
    )?.[1];
    if (bearer && !browserOnly) {
      const device = (
        await db.query(
          "SELECT user_id FROM devices WHERE token_hash=$1 AND revoked_at IS NULL",
          [hash(bearer)],
        )
      ).rows[0];
      if (device) return device.user_id;
    }
    const session = req.cookies.tig_session;
    if (!session)
      throw new DomainError("SIGN_IN_REQUIRED", "Sign in to continue.", 401);
    if (mutation && req.headers.origin !== config.origin)
      throw new DomainError(
        "ORIGIN_REJECTED",
        "Reload this page and try again.",
        403,
      );
    const row = (
      await db.query(
        "SELECT user_id FROM sessions WHERE token_hash=$1 AND expires_at>now()",
        [hash(session)],
      )
    ).rows[0];
    if (!row)
      throw new DomainError("SIGN_IN_REQUIRED", "Sign in to continue.", 401);
    return row.user_id;
  }
  const cookieOptions = {
    path: "/",
    httpOnly: true,
    sameSite: "lax" as const,
    secure: config.production,
  };
  async function makeSession(githubId: string, login: string) {
    const token = opaque();
    const user = await transaction(db, async (tx) => {
      const user = await upsertUser(tx, githubId, login);
      await tx.query(
        "INSERT INTO sessions VALUES($1,$2,now()+interval '7 days')",
        [hash(token), user.id],
      );
      return user;
    });
    return { token, user };
  }
  app.get("/v1/openapi.json", async () => openapi);
  app.get("/health", async () => {
    await db.query("SELECT 1");
    return { status: "ok" };
  });
  app.get("/v1/config", async () => ({
    name: "Tokenisgold",
    development: config.devMode,
    githubSignIn: !!(config.githubClientId && config.githubClientSecret),
    policyVersion: POLICY_VERSION,
    executionEnabled: false,
    developmentTransactions: config.devMode,
    // Git requests can be accepted and submitted as unverified local trials.
    localTrialSubmission: config.localTrial,
  }));
  app.get(
    "/auth/github",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (_req, reply) => {
      if (!config.githubClientId || !config.githubClientSecret)
        throw new DomainError(
          "OAUTH_NOT_CONFIGURED",
          "GitHub sign-in is not configured for this installation.",
          503,
        );
      const state = opaque(),
        verifier = opaque();
      await db.query(
        "INSERT INTO oauth_states VALUES($1,$2,now()+interval '10 minutes')",
        [hash(state), verifier],
      );
      reply.setCookie("tig_oauth", state, { ...cookieOptions, maxAge: 600 });
      const url = new URL("https://github.com/login/oauth/authorize");
      url.search = new URLSearchParams({
        client_id: config.githubClientId,
        redirect_uri: `${config.origin}/auth/github/callback`,
        state,
        scope: "read:user",
        code_challenge: randomHashBase64(verifier),
        code_challenge_method: "S256",
      }).toString();
      return reply.redirect(url.href);
    },
  );
  app.get("/auth/github/callback", async (req, reply) => {
    const { state, code } = z
      .object({
        state: z.string().min(30).max(100),
        code: z.string().min(1).max(300),
      })
      .parse(req.query);
    if (req.cookies.tig_oauth !== state)
      throw new DomainError(
        "OAUTH_STATE",
        "Sign-in expired. Start again.",
        401,
      );
    const row = (
      await db.query(
        "DELETE FROM oauth_states WHERE state_hash=$1 AND expires_at>now() RETURNING verifier",
        [hash(state)],
      )
    ).rows[0];
    if (!row)
      throw new DomainError(
        "OAUTH_STATE",
        "Sign-in expired. Start again.",
        401,
      );
    const identity = await github.identity(code, row.verifier);
    const session = await makeSession(identity.id, identity.login);
    reply
      .clearCookie("tig_oauth", cookieOptions)
      .setCookie("tig_session", session.token, {
        ...cookieOptions,
        maxAge: 7 * 86400,
      });
    return reply.redirect("/");
  });
  if (config.devMode)
    app.post("/v1/dev/sign-in", async (req, reply) => {
      if (
        !["127.0.0.1", "::1"].includes(req.ip) ||
        req.headers.origin !== config.origin
      )
        throw new DomainError(
          "DEV_LOCAL_ONLY",
          "Development sign-in is local only.",
          403,
        );
      const { persona } = z
        .object({ persona: z.enum(["requester", "worker"]) })
        .strict()
        .parse(req.body);
      const session = await makeSession(`dev:${persona}`, `demo-${persona}`);
      reply.setCookie("tig_session", session.token, {
        ...cookieOptions,
        maxAge: 7 * 86400,
      });
      return { user: session.user };
    });
  app.post("/v1/auth/logout", async (req, reply) => {
    const user = await actor(req, true, true);
    const result = await idempotent(
      db,
      user,
      "logout",
      req.headers["idempotency-key"],
      {},
      async (tx) => {
        await tx.query(
          "DELETE FROM sessions WHERE token_hash=$1 AND user_id=$2",
          [hash(req.cookies.tig_session!), user],
        );
        return { ok: true };
      },
    );
    reply.clearCookie("tig_session", cookieOptions);
    return result;
  });
  app.get("/v1/me", async (req) => {
    const user = await actor(req);
    const row = (
      await db.query(
        "SELECT id,login,optional_analytics FROM users WHERE id=$1",
        [user],
      )
    ).rows[0];
    return {
      id: row.id,
      login: row.login,
      optionalProductAnalytics: row.optional_analytics,
      policyVersion: POLICY_VERSION,
    };
  });
  app.patch("/v1/me/data-settings", async (req) => {
    const user = await actor(req, true);
    const body = z
      .object({ optionalProductAnalytics: z.boolean() })
      .strict()
      .parse(req.body);
    return idempotent(
      db,
      user,
      "data-settings",
      req.headers["idempotency-key"],
      body,
      async (tx) => {
        await tx.query("UPDATE users SET optional_analytics=$2 WHERE id=$1", [
          user,
          body.optionalProductAnalytics,
        ]);
        return body;
      },
    );
  });
  app.get("/v1/wallet", async (req) => {
    const user = await actor(req);
    const rows = (
      await db.query(
        "SELECT kind,sum(balance)::text AS balance FROM ledger_accounts WHERE user_id=$1 GROUP BY kind",
        [user],
      )
    ).rows;
    return {
      available: rows.find((r) => r.kind === "available")?.balance ?? "0.00",
      escrow: rows.find((r) => r.kind === "escrow")?.balance ?? "0.00",
    };
  });
  app.get("/v1/wallet/entries", async (req) => {
    const user = await actor(req);
    return {
      entries: (
        await db.query(
          "SELECT t.id,t.reason,t.created_at,e.delta::text AS amount,a.kind FROM ledger_entries e JOIN ledger_transactions t ON t.id=e.tx_id JOIN ledger_accounts a ON a.id=e.account_id WHERE a.user_id=$1 ORDER BY t.created_at DESC,e.id DESC LIMIT 100",
          [user],
        )
      ).rows,
    };
  });
  app.get("/v1/projects", async (req) => {
    const user = await actor(req);
    return {
      projects: (
        await db.query(
          'SELECT p.id,p.repository,p.canonical_url AS url,l.project_type AS "projectType",l.stack FROM projects p JOIN project_links l ON l.project_id=p.id WHERE l.user_id=$1 ORDER BY p.repository',
          [user],
        )
      ).rows,
    };
  });
  app.post("/v1/projects", async (req) => {
    const user = await actor(req, true),
      body = projectSchema.parse(req.body);
    const repo = await github.repository(body.repository);
    return idempotent(
      db,
      user,
      "projects",
      req.headers["idempotency-key"],
      body,
      async (tx) => {
        const row = (
          await tx.query(
            "INSERT INTO projects(id,github_repo_id,repository,canonical_url,fork_parent_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT(github_repo_id) DO UPDATE SET repository=excluded.repository,canonical_url=excluded.canonical_url,observed_at=now() RETURNING id,repository,canonical_url AS url",
            [randomUUID(), repo.id, repo.repository, repo.url, repo.forkParent],
          )
        ).rows[0];
        await tx.query(
          "INSERT INTO project_links VALUES($1,$2,$3,$4) ON CONFLICT(user_id,project_id) DO UPDATE SET project_type=excluded.project_type,stack=excluded.stack",
          [user, row.id, body.projectType, JSON.stringify(body.stack)],
        );
        return { ...row, projectType: body.projectType, stack: body.stack };
      },
    );
  });
  app.post("/v1/artifacts", async (req) => {
    const user = await actor(req, true);
    return idempotent(
      db,
      user,
      "artifacts",
      req.headers["idempotency-key"],
      req.body,
      (tx) => uploadArtifact(tx, user, req.body),
    );
  });
  app.post("/v1/tasks", async (req) => {
    const user = await actor(req, true),
      body = taskSpec.parse(req.body);
    // Retry cached transactions before network verification: a successful post remains replayable after a repository is renamed/deleted.
    return idempotent(
      db,
      user,
      "tasks",
      req.headers["idempotency-key"],
      body,
      async (tx) => {
        const project = (
          await tx.query(
            "SELECT p.* FROM projects p JOIN project_links l ON l.project_id=p.id WHERE p.id=$1 AND l.user_id=$2",
            [body.projectId, user],
          )
        ).rows[0];
        if (!project)
          throw new DomainError(
            "PROJECT_NOT_FOUND",
            "Connect this public repository first.",
            404,
          );
        const repo = await github.repository(project.repository);
        if (repo.id !== project.github_repo_id)
          throw new DomainError(
            "REPOSITORY_CHANGED",
            "Reconnect the repository before posting.",
            409,
          );
        await github.commit(repo.repository, body.baseCommit);
        if (body.gitRequest)
          await verifyGitRequest(tx, user, body, repo.repository, github);
        return publish(tx, user, body, new Date());
      },
    );
  });
  app.get("/v1/tasks", async (req) => {
    const user = await actor(req);
    const query = z
      .object({ mine: z.enum(["true", "false"]).optional() })
      .parse(req.query);
    const rows = (
      await db.query(
        query.mine === "true"
          ? "SELECT * FROM tasks WHERE requester_id=$1 OR worker_id=$1 ORDER BY created_at DESC LIMIT 100"
          : "SELECT * FROM tasks WHERE state='OPEN' AND execution_deadline_at>now() ORDER BY created_at DESC LIMIT 100",
        query.mine === "true" ? [user] : [],
      )
    ).rows;
    return { tasks: rows.map(viewTask) };
  });
  app.get("/v1/tasks/:id", async (req) => {
    const user = await actor(req),
      { id } = idSchema.parse(req.params);
    const row = (await db.query("SELECT * FROM tasks WHERE id=$1", [id]))
      .rows[0];
    if (
      !row ||
      (row.requester_id !== user &&
        row.worker_id !== user &&
        row.state !== "OPEN")
    )
      throw new DomainError("TASK_NOT_FOUND", "Task not found.", 404);
    const participant = row.requester_id === user || row.worker_id === user;
    const artifactIds = participant
      ? [row.artifact_id, row.submission?.artifactId].filter(Boolean)
      : [];
    const artifacts = artifactIds.length
      ? (
          await db.query(
            "SELECT id,base_commit,summary,files,deleted_paths,manifest_hash FROM artifacts WHERE id=ANY($1::uuid[])",
            [artifactIds],
          )
        ).rows
      : [];
    return {
      ...viewTask(row),
      ...(participant || row.development_fixture
        ? { scope: row.spec.scope, acceptanceChecks: row.spec.acceptanceChecks }
        : {}),
      // Branch/commit and layout let the web and CLI describe where the request
      // lives without widening taskView; derived from the visible artifact.
      ...(participant && row.spec.gitRequest
        ? {
            gitRequest: row.spec.gitRequest,
            layout: artifactLayout(
              artifacts.find((a) => a.id === row.artifact_id)?.files,
            ),
          }
        : {}),
      submission: participant ? row.submission : null,
      artifacts,
    };
  });
  if (config.devMode)
    app.post("/v1/dev/tasks", async (req) => {
      const user = await actor(req, true);
      const body = z
        .object({
          rewardTig: money.refine((v) => cents(v) > 0n && cents(v) <= 300000n),
        })
        .strict()
        .parse(req.body);
      return idempotent(
        db,
        user,
        "dev/tasks",
        req.headers["idempotency-key"],
        body,
        (tx) => createFixture(tx, user, body.rewardTig, new Date()),
      );
    });
  app.post("/v1/tasks/:id/claim", async (req) => {
    const user = await actor(req, true),
      { id } = idSchema.parse(req.params),
      body = claimBody.parse(req.body);
    return idempotent(
      db,
      user,
      `tasks/${id}/claim`,
      req.headers["idempotency-key"],
      body,
      async (tx) => {
        const row = (
          await tx.query(
            "SELECT t.development_fixture, (t.spec->'gitRequest') IS NOT NULL AS git_request, (SELECT f->>'content' FROM artifacts a, jsonb_array_elements(a.files) f WHERE a.id=t.artifact_id AND f->>'path'='request.json' LIMIT 1) AS request_json FROM tasks t WHERE t.id=$1",
            [id],
          )
        ).rows[0];
        if (!row)
          throw new DomainError("TASK_NOT_FOUND", "Task not found.", 404);
        // Development mode accepts the fixed exercise and Git requests (local-trial
        // submission, unverified execution). Plain JSON-handoff tasks stay closed.
        if (
          !(config.devMode && row.development_fixture) &&
          !(config.localTrial && row.git_request)
        )
          throw new DomainError(
            "RUNNER_NOT_READY",
            "Real AI execution is not enabled yet. Use a local test task to try the transaction flow.",
            503,
          );
        // A tree-layout request has no code/ mirror; an old CLI would claim it and
        // then fail after start (locking the task for 30 min). Refuse before claiming.
        if (
          row.git_request &&
          artifactLayout(
            row.request_json
              ? [{ path: "request.json", content: row.request_json }]
              : null,
          ) === "tree" &&
          !clientCapabilities(req).has("request-tree")
        )
          throw new DomainError(
            "CLIENT_UPGRADE_REQUIRED",
            "Update tig to work on this request: it is published as a whole-project branch.",
            409,
          );
        return claimTask(tx, user, id, body.expectedVersion, new Date());
      },
    );
  });
  for (const action of ["start", "heartbeat", "interrupt", "resume"])
    app.post(`/v1/tasks/:id/${action}`, async (req) => {
      const user = await actor(req, true),
        { id } = idSchema.parse(req.params),
        body = executionBody.parse(req.body);
      if (!config.localTrial)
        throw new DomainError(
          "RUNNER_NOT_READY",
          "Execution is not enabled.",
          503,
        );
      return idempotent(
        db,
        user,
        `tasks/${id}/${action}`,
        req.headers["idempotency-key"],
        body,
        (tx) => executionAction(tx, user, id, body, action, new Date()),
      );
    });
  app.post("/v1/tasks/:id/submit", async (req) => {
    const user = await actor(req, true),
      { id } = idSchema.parse(req.params),
      body = submitBody.parse(req.body);
    if (!config.localTrial)
      throw new DomainError(
        "RUNNER_NOT_READY",
        "Execution is not enabled.",
        503,
      );
    return idempotent(
      db,
      user,
      `tasks/${id}/submit`,
      req.headers["idempotency-key"],
      body,
      async (tx) => {
        if (body.gitResult) {
          // The result branch must be readable by the requester: public repository,
          // and the declared commit must really exist there.
          const repo = await github.repository(body.gitResult.repository);
          await github.commit(repo.repository, body.gitResult.commit);
        }
        return submitResult(tx, user, id, body, new Date());
      },
    );
  });
  for (const action of ["approve", "issue"] as const)
    app.post(`/v1/tasks/:id/${action}`, async (req) => {
      const user = await actor(req, true),
        { id } = idSchema.parse(req.params),
        body = versionBody.parse(req.body);
      return idempotent(
        db,
        user,
        `tasks/${id}/${action}`,
        req.headers["idempotency-key"],
        body,
        (tx) =>
          reviewTask(tx, user, id, body.expectedVersion, action, new Date()),
      );
    });

  app.post("/v1/tasks/:id/cancel", async (req) => {
    const user = await actor(req, true),
      { id } = idSchema.parse(req.params),
      body = z
        .object({ expectedVersion: z.number().int().positive() })
        .strict()
        .parse(req.body);
    return idempotent(
      db,
      user,
      `tasks/${id}/cancel`,
      req.headers["idempotency-key"],
      body,
      (tx) => cancelTask(tx, user, id, body.expectedVersion),
    );
  });

  app.get("/v1/notifications", async (req) => {
    const user = await actor(req);
    const q = z
      .object({
        before: z.iso.datetime().optional(),
        beforeId: z.uuid().optional(),
      })
      .refine((v) => Boolean(v.before) === Boolean(v.beforeId))
      .parse(req.query);
    return transaction(db, async (tx) => {
      const rows = (
        await tx.query(
          'SELECT id,task_id AS "taskId",type,title,body,created_at AS "createdAt",read_at AS "readAt" FROM notifications WHERE user_id=$1 AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::uuid)) ORDER BY created_at DESC,id DESC LIMIT 51',
          [user, q.before ?? null, q.beforeId ?? null],
        )
      ).rows;
      const more = rows.length > 50,
        shown = rows.slice(0, 50),
        last = shown.at(-1);
      const unread = (
        await tx.query(
          "SELECT count(*)::int n FROM notifications WHERE user_id=$1 AND read_at IS NULL",
          [user],
        )
      ).rows[0].n;
      return {
        notifications: shown,
        unreadCount: unread,
        nextCursor: more
          ? { before: last.createdAt.toISOString(), beforeId: last.id }
          : null,
      };
    });
  });
  app.post("/v1/notifications/:id/read", async (req) => {
    const user = await actor(req, true),
      { id } = idSchema.parse(req.params);
    z.object({}).strict().parse(req.body);
    return idempotent(
      db,
      user,
      `notifications/${id}/read`,
      req.headers["idempotency-key"],
      {},
      async (tx) => {
        const row = (
          await tx.query(
            'UPDATE notifications SET read_at=coalesce(read_at,now()) WHERE id=$1 AND user_id=$2 RETURNING id,read_at AS "readAt"',
            [id, user],
          )
        ).rows[0];
        if (!row)
          throw new DomainError(
            "NOTIFICATION_NOT_FOUND",
            "Notification not found.",
            404,
          );
        return row;
      },
    );
  });
  app.get("/v1/insights", async (req) => {
    const user = await actor(req),
      q = z
        .object({
          segment: insightSegment.default("real"),
          preview: z.enum(["true", "false"]).default("false"),
        })
        .strict()
        .parse(req.query);
    if (q.preview === "true") {
      if (!config.devMode || q.segment !== "development")
        throw new DomainError(
          "PREVIEW_NOT_AVAILABLE",
          "Live preview is only available for development sample data.",
          403,
        );
      return transaction(db, async (tx) => ({
        pending: false,
        report: await collectInsights(
          tx,
          user,
          q.segment,
          new Date(),
          new Date(),
          "preview",
        ),
      }));
    }
    const day = reportDay(new Date()).toISOString().slice(0, 10);
    const row = (
      await db.query(
        "SELECT body FROM insight_snapshots WHERE user_id=$1 AND segment=$2 AND query_version=$3 AND report_day<=$4 ORDER BY report_day DESC LIMIT 1",
        [user, q.segment, queryVersion, day],
      )
    ).rows[0];
    return { pending: !row, report: row?.body ?? null };
  });
  app.get("/v1/tasks/:id/result", async (req, reply) => {
    const user = await actor(req),
      { id } = idSchema.parse(req.params);
    const row = (
      await db.query(
        "SELECT t.id,t.submission,a.base_commit,a.summary,a.manifest_hash,a.files,a.deleted_paths FROM tasks t JOIN artifacts a ON a.id=(t.submission->>'artifactId')::uuid WHERE t.id=$1 AND (t.requester_id=$2 OR t.worker_id=$2)",
        [id, user],
      )
    ).rows[0];
    if (!row)
      throw new DomainError(
        "RESULT_NOT_FOUND",
        "No submitted result is available to this account.",
        404,
      );
    reply.header(
      "Content-Disposition",
      `attachment; filename="tokenisgold-result-${id}.json"`,
    );
    return {
      schemaVersion: 1,
      taskId: id,
      report: row.submission.report,
      checks: row.submission.checks,
      execution: row.submission.execution,
      artifact: {
        baseCommit: row.base_commit,
        summary: row.summary,
        manifestHash: row.manifest_hash,
        files: row.files,
        deletedPaths: row.deleted_paths,
      },
    };
  });
  app.get("/v1/devices", async (req) => {
    const user = await actor(req);
    return {
      devices: (
        await db.query(
          "SELECT id,name,created_at,revoked_at FROM devices WHERE user_id=$1 ORDER BY created_at DESC",
          [user],
        )
      ).rows,
    };
  });
  app.post(
    "/v1/device-authorizations",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req) => {
      const { name } = z
          .object({ name: z.string().trim().min(1).max(80) })
          .strict()
          .parse(req.body),
        secret = opaque(),
        code = randomBytes(6).toString("hex").toUpperCase();
      await db.query(
        "INSERT INTO pairings(device_hash,user_code,name,expires_at) VALUES($1,$2,$3,now()+interval '10 minutes')",
        [hash(secret), code, name],
      );
      return {
        deviceCode: secret,
        userCode: code,
        verificationUri: `${config.origin}/?connect=${code}`,
        expiresIn: 600,
        interval: 5,
      };
    },
  );
  app.post("/v1/device-authorizations/approve", async (req) => {
    const user = await actor(req, true, true);
    const body = z
      .object({ userCode: z.string().regex(/^[A-F0-9]{12}$/) })
      .strict()
      .parse(req.body);
    return idempotent(
      db,
      user,
      "pair-approve",
      req.headers["idempotency-key"],
      body,
      async (tx) => {
        const pairing = (
          await tx.query(
            "SELECT * FROM pairings WHERE user_code=$1 AND expires_at>now() AND consumed_at IS NULL FOR UPDATE",
            [body.userCode],
          )
        ).rows[0];
        if (!pairing || pairing.user_id)
          throw new DomainError(
            "PAIRING_EXPIRED",
            "This code has expired or was already connected.",
            409,
          );
        await tx.query("UPDATE pairings SET user_id=$1 WHERE user_code=$2", [
          user,
          body.userCode,
        ]);
        return { approved: true, name: pairing.name };
      },
    );
  });
  app.post(
    "/v1/device-authorizations/token",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (req) => {
      const { deviceCode } = z
        .object({ deviceCode: z.string().min(40).max(128) })
        .strict()
        .parse(req.body);
      return transaction(db, async (tx) => {
        const pairing = (
          await tx.query(
            "SELECT * FROM pairings WHERE device_hash=$1 AND expires_at>now() AND consumed_at IS NULL FOR UPDATE",
            [hash(deviceCode)],
          )
        ).rows[0];
        if (!pairing)
          throw new DomainError(
            "PAIRING_EXPIRED",
            "Start device connection again.",
            410,
          );
        if (!pairing.user_id) return { status: "pending" };
        const token = opaque(),
          id = randomUUID();
        await tx.query(
          "INSERT INTO devices(id,user_id,name,token_hash) VALUES($1,$2,$3,$4)",
          [id, pairing.user_id, pairing.name, hash(token)],
        );
        await tx.query(
          "UPDATE pairings SET consumed_at=now() WHERE device_hash=$1",
          [hash(deviceCode)],
        );
        return { status: "connected", token, deviceId: id };
      });
    },
  );
  app.post("/v1/devices/:id/revoke", async (req) => {
    const user = await actor(req, true, true),
      { id } = idSchema.parse(req.params);
    return idempotent(
      db,
      user,
      `devices/${id}/revoke`,
      req.headers["idempotency-key"],
      {},
      async (tx) => {
        const row = await tx.query(
          "UPDATE devices SET revoked_at=coalesce(revoked_at,now()) WHERE id=$1 AND user_id=$2 RETURNING id",
          [id, user],
        );
        if (!row.rowCount)
          throw new DomainError("DEVICE_NOT_FOUND", "Device not found.", 404);
        return { revoked: true };
      },
    );
  });
  app.post("/v1/subscription-observations", async (req) => {
    const user = await actor(req, true),
      body = observationSchema.parse(req.body);
    return idempotent(
      db,
      user,
      "observations",
      req.headers["idempotency-key"],
      body,
      async (tx) => {
        await tx.query(
          "INSERT INTO observations VALUES($1,$2,$3,now()) ON CONFLICT(user_id,provider) DO UPDATE SET body=excluded.body,observed_at=excluded.observed_at",
          [user, body.provider, JSON.stringify(body)],
        );
        return { recorded: true, verification: "pending", grantIssued: false };
      },
    );
  });
  app.get("/v1/connections", async (req) => {
    const user = await actor(req),
      rows = (
        await db.query(
          "SELECT provider,body,observed_at FROM observations WHERE user_id=$1",
          [user],
        )
      ).rows;
    const entitlements = (
      await db.query(
        "SELECT e.provider,e.status,e.verified_until,e.first_verified_at,p.plan_id,p.monthly_usd FROM entitlements e JOIN plan_prices p ON e.price_id=p.id WHERE e.user_id=$1",
        [user],
      )
    ).rows;
    return {
      connections: ["codex", "claude"].map((provider) => {
        const row = rows.find((r) => r.provider === provider),
          e = entitlements.find((r) => r.provider === provider);
        const fresh =
          row && Date.now() - new Date(row.observed_at).getTime() < 10 * 60000;
        return {
          provider,
          planId: row?.body.planId ?? e?.plan_id ?? null,
          source: row?.body.source ?? "unknown",
          signal: fresh ? usageSignal(row.body.windows) : "unknown",
          observedAt: row?.observed_at ?? null,
          verification:
            e && new Date(e.verified_until) > new Date() ? e.status : "pending",
          nextGrantAt: e
            ? new Date(
                new Date(e.first_verified_at).getTime() +
                  (Math.floor(
                    (Date.now() - new Date(e.first_verified_at).getTime()) /
                      (7 * 86400000),
                  ) +
                    1) *
                    7 *
                    86400000,
              ).toISOString()
            : null,
        };
      }),
    };
  });
  if (existsSync(resolve("apps/web/dist/index.html"))) {
    await app.register(staticFiles, {
      root: resolve("apps/web/dist"),
      wildcard: false,
    });
    app.setNotFoundHandler((req, reply) => {
      if (
        req.method === "GET" &&
        !req.url.startsWith("/v1/") &&
        !req.url.startsWith("/auth/")
      )
        return reply.sendFile("index.html");
      return reply.code(404).send({
        code: "NOT_FOUND",
        message: "Route not found.",
        retryable: false,
        requestId: req.id,
      });
    });
  }
  return app;
}
function randomHashBase64(value: string) {
  return Buffer.from(hash(value), "hex").toString("base64url");
}
