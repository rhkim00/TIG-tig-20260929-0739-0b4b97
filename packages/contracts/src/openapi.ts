import { z } from "zod";
import {
  taskSpec,
  taskView,
  artifactSchema,
  projectSchema,
  observationSchema,
  walletView,
  errorView,
} from "./index.js";
import {
  claimBody,
  executionBody,
  submitBody,
  versionBody,
} from "./lifecycle.js";
import { insightReport, inboxView } from "./insights.js";
const schemas = {
  InsightReport: insightReport,
  Inbox: inboxView,
  ClaimInput: claimBody,
  ExecutionInput: executionBody,
  SubmitInput: submitBody,
  ReviewInput: versionBody,
  TaskSpec: taskSpec,
  Task: taskView,
  Handoff: artifactSchema,
  ProjectInput: projectSchema,
  Observation: observationSchema,
  Wallet: walletView,
  Error: errorView,
};
const schema = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const paths: Record<string, Record<string, unknown>> = {};
function endpoint(
  path: string,
  method: string,
  summary: string,
  input?: string,
  output?: unknown,
) {
  const mutation = ["post", "patch", "delete"].includes(method);
  paths[path] ??= {};
  paths[path][method] = {
    summary,
    security: [{ session: [] }, { device: [] }],
    parameters: [
      ...(path.includes("{id}")
        ? [
            {
              in: "path",
              name: "id",
              required: true,
              schema: { type: "string", format: "uuid" },
            },
          ]
        : []),
      ...(mutation
        ? [
            {
              in: "header",
              name: "Idempotency-Key",
              required: true,
              schema: { type: "string", minLength: 8, maxLength: 128 },
            },
          ]
        : []),
    ],
    ...(input
      ? {
          requestBody: {
            required: true,
            content: { "application/json": { schema: schema(input) } },
          },
        }
      : {}),
    responses: {
      "200": {
        description: "Successful result",
        content: {
          "application/json": { schema: output ?? { type: "object" } },
        },
      },
      ...Object.fromEntries(
        [401, 403, 404, 409, 422, 500, 503].map((code) => [
          code,
          {
            description: "Request error",
            content: { "application/json": { schema: schema("Error") } },
          },
        ]),
      ),
    },
  };
}
endpoint(
  "/v1/tasks",
  "post",
  "Publish the handoff and reserve TIG atomically",
  "TaskSpec",
  schema("Task"),
);
endpoint(
  "/v1/tasks",
  "get",
  "List open tasks or the current user’s tasks",
  undefined,
  {
    type: "object",
    properties: { tasks: { type: "array", items: schema("Task") } },
  },
);
endpoint(
  "/v1/tasks/{id}",
  "get",
  "Read task scope; artifacts and submission require participant access",
  undefined,
  schema("Task"),
);
endpoint(
  "/v1/tasks/{id}/cancel",
  "post",
  "Cancel an unclaimed task and restore all TIG",
);
endpoint(
  "/v1/artifacts",
  "post",
  "Upload an explicitly selected handoff",
  "Handoff",
);
endpoint(
  "/v1/projects",
  "post",
  "Link a public GitHub repository",
  "ProjectInput",
);
endpoint("/v1/projects", "get", "List linked projects");
endpoint(
  "/v1/subscription-observations",
  "post",
  "Store allowlisted observations without issuing TIG",
  "Observation",
);
endpoint(
  "/v1/wallet",
  "get",
  "Get exact available and escrow balances",
  undefined,
  schema("Wallet"),
);
endpoint("/v1/wallet/entries", "get", "Get ledger movements");
endpoint("/v1/me", "get", "Get the signed-in user and privacy preference");
endpoint("/v1/me/data-settings", "patch", "Set optional product analytics");
endpoint(
  "/v1/connections",
  "get",
  "Read connection provenance and usage status",
);
endpoint("/v1/devices", "get", "List paired devices");
endpoint(
  "/v1/devices/{id}/revoke",
  "post",
  "Revoke a device with browser reauthorization",
);
endpoint(
  "/v1/tasks/{id}/claim",
  "post",
  "Accept only this task (development fixture until runner validation)",
  "ClaimInput",
  schema("Task"),
);
for (const action of ["start", "heartbeat", "interrupt", "resume"])
  endpoint(
    `/v1/tasks/{id}/${action}`,
    "post",
    `Execution: ${action}`,
    "ExecutionInput",
    schema("Task"),
  );
endpoint(
  "/v1/tasks/{id}/submit",
  "post",
  "Validate artifact and begin 48-hour review (development fixture)",
  "SubmitInput",
  schema("Task"),
);
for (const action of ["approve", "issue"])
  endpoint(
    `/v1/tasks/{id}/${action}`,
    "post",
    `Review: ${action}`,
    "ReviewInput",
    schema("Task"),
  );
endpoint(
  "/v1/notifications",
  "get",
  "Read your paginated inbox; before/beforeId cursor",
  undefined,
  schema("Inbox"),
);
endpoint(
  "/v1/notifications/{id}/read",
  "post",
  "Mark only your notification read",
);
endpoint(
  "/v1/insights",
  "get",
  "Your daily 30-day report; real/development segments. Development-only sample preview",
);
endpoint(
  "/v1/tasks/{id}/result",
  "get",
  "Download result JSON; participants only, no apply or execution",
);
export const openapi = {
  openapi: "3.1.0",
  info: {
    title: "Tokenisgold foundation API",
    version: "0.1.0",
    description:
      "Day 1–4 foundation plus transactional claims, review and settlement. Development fixtures enable two-person tests; real AI execution remains disabled. See docs/contracts/lifecycle.md.",
  },
  paths,
  components: {
    securitySchemes: {
      session: { type: "apiKey", in: "cookie", name: "tig_session" },
      device: { type: "http", scheme: "bearer" },
    },
    schemas: Object.fromEntries(
      Object.entries(schemas).map(([name, s]) => {
        const { $schema, ...json } = z.toJSONSchema(s);
        return [name, json];
      }),
    ),
  },
};
