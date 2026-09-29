import { z } from "zod";
import { category } from "./index.js";
const aggregateTig = z.string().regex(/^(0|[1-9]\d*)(\.\d{1,2})?$/);
export const insightSegment = z.enum(["real", "development"]);
export const insightReport = z.object({
  schemaVersion: z.literal(1),
  queryVersion: z.literal(1),
  source: z.literal("server_verified"),
  segment: insightSegment,
  mode: z.enum(["daily", "preview"]),
  generatedAt: z.iso.datetime(),
  windowStart: z.iso.datetime(),
  windowEnd: z.iso.datetime(),
  requestedTasks: z.number().int().nonnegative(),
  connectedProjects: z.number().int().nonnegative(),
  activeConnectedProjects: z.number().int().nonnegative(),
  directApprovals: z.number().int().nonnegative(),
  automaticPayments: z.number().int().nonnegative(),
  refunds: z.number().int().nonnegative(),
  paidTig: aggregateTig,
  refundedTig: aggregateTig,
  earnedTig: aggregateTig,
  categories: z.array(
    z.object({ category, count: z.number().int().nonnegative() }),
  ),
  projects: z.array(
    z.object({
      id: z.uuid(),
      repository: z.string(),
      projectType: z.string(),
      requests: z.number().int().nonnegative(),
    }),
  ),
  coverage: z.object({
    projectDenominator: z.literal("currently_linked_at_generation"),
    outcomes: z.literal("settlements_in_window"),
    qualityScore: z.null(),
    events: z.literal("transaction_records"),
    windowDays: z.literal(30),
  }),
});
export type InsightReport = z.infer<typeof insightReport>;
export const notificationView = z.object({
  id: z.uuid(),
  taskId: z.uuid(),
  type: z.string(),
  title: z.string(),
  body: z.string(),
  createdAt: z.iso.datetime(),
  readAt: z.iso.datetime().nullable(),
});
export const inboxView = z.object({
  notifications: z.array(notificationView),
  unreadCount: z.number().int().nonnegative(),
  nextCursor: z
    .object({ before: z.iso.datetime(), beforeId: z.uuid() })
    .nullable(),
});
export type Inbox = z.infer<typeof inboxView>;
