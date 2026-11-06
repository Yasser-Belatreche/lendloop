import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { requireAdmin } from "./lib/auth";
import { daysBetween } from "./lib/dates";
import { sign } from "./lib/hmac";

export const MAX_ATTEMPTS = 5;
const BACKOFF_MS = [10_000, 60_000, 5 * 60_000, 30 * 60_000];

// ---------- Convex -> n8n: request notifications (outbox + retries) ----------

export const getOutbox = internalQuery({
  args: { outboxId: v.id("outbox") },
  handler: (ctx, { outboxId }) => ctx.db.get(outboxId),
});

export const deliver = internalAction({
  args: { outboxId: v.id("outbox") },
  handler: async (ctx, { outboxId }) => {
    const row = await ctx.runQuery(internal.automation.getOutbox, { outboxId });
    if (!row || row.status !== "pending") return;
    const url = process.env.N8N_REQUEST_WEBHOOK_URL;
    const secret = process.env.LENDLOOP_WEBHOOK_SECRET;
    try {
      if (!url || !secret) throw new Error("N8N_REQUEST_WEBHOOK_URL or LENDLOOP_WEBHOOK_SECRET is not set");
      const timestamp = String(Math.floor(Date.now() / 1000));
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-lendloop-timestamp": timestamp,
          "x-lendloop-signature": await sign(secret, timestamp, row.payload),
          "x-lendloop-event-id": row.idempotencyKey,
        },
        body: row.payload,
      });
      if (!res.ok) throw new Error(`n8n responded ${res.status}`);
      await ctx.runMutation(internal.automation.markDelivered, { outboxId });
    } catch (e) {
      await ctx.runMutation(internal.automation.markAttemptFailed, {
        outboxId,
        error: e instanceof Error ? e.message.slice(0, 300) : "unknown error",
      });
    }
  },
});

export const markDelivered = internalMutation({
  args: { outboxId: v.id("outbox") },
  handler: async (ctx, { outboxId }) => {
    const row = await ctx.db.get(outboxId);
    if (!row || row.status === "delivered") return;
    await ctx.db.patch(outboxId, {
      status: "delivered",
      attempts: row.attempts + 1,
      deliveredAt: Date.now(),
      lastError: undefined,
    });
    await recordEvent(ctx, {
      loanId: row.loanId,
      kind: "request_notification",
      status: "sent",
      idempotencyKey: `notify:${row.idempotencyKey}`,
      detail: row.event,
    });
  },
});

export const markAttemptFailed = internalMutation({
  args: { outboxId: v.id("outbox"), error: v.string() },
  handler: async (ctx, { outboxId, error }) => {
    const row = await ctx.db.get(outboxId);
    if (!row || row.status !== "pending") return;
    const attempts = row.attempts + 1;
    if (attempts >= MAX_ATTEMPTS) {
      // Give up loudly: the admin view lists failed deliveries and they can be retried.
      await ctx.db.patch(outboxId, { status: "failed", attempts, lastError: error });
      await recordEvent(ctx, {
        loanId: row.loanId,
        kind: "request_notification",
        status: "failed",
        idempotencyKey: `notify:${row.idempotencyKey}`,
        detail: error,
      });
      return;
    }
    await ctx.db.patch(outboxId, { attempts, lastError: error });
    await ctx.scheduler.runAfter(BACKOFF_MS[attempts - 1], internal.automation.deliver, { outboxId });
  },
});

// ---------- n8n -> Convex: overdue loans and reminder write-backs ----------

export const overdueLoans = internalQuery({
  args: { asOf: v.string() },
  handler: async (ctx, { asOf }) => {
    const loans = await ctx.db
      .query("loans")
      .withIndex("by_status_end", (q) => q.eq("status", "approved").lt("endDate", asOf))
      .take(500);
    const out = [];
    for (const loan of loans) {
      const key = reminderKey(loan._id, asOf);
      const already = await ctx.db
        .query("automationEvents")
        .withIndex("by_key", (q) => q.eq("idempotencyKey", key))
        .unique();
      if (already?.status === "sent") continue;
      const [borrower, tool] = await Promise.all([ctx.db.get(loan.borrowerId), ctx.db.get(loan.toolId)]);
      if (!borrower?.email) continue;
      // Only the fields the reminder needs.
      out.push({
        loanId: loan._id,
        borrowerEmail: borrower.email,
        borrowerName: borrower.name,
        toolName: tool?.name ?? "a tool",
        dueDate: loan.endDate,
        daysOverdue: daysBetween(loan.endDate, asOf),
      });
    }
    return out;
  },
});

export function reminderKey(loanId: string, date: string) {
  return `reminder:${loanId}:${date}`;
}

type EventInput = {
  loanId?: import("./_generated/dataModel").Id<"loans">;
  kind: "request_notification" | "overdue_reminder" | "workflow_error";
  status: "sent" | "failed";
  idempotencyKey: string;
  detail?: string;
};

// Upsert by idempotency key: a retried write-back updates the same row, and a
// "sent" row is never downgraded to "failed" by a late duplicate.
async function recordEvent(ctx: import("./_generated/server").MutationCtx, input: EventInput) {
  const existing = await ctx.db
    .query("automationEvents")
    .withIndex("by_key", (q) => q.eq("idempotencyKey", input.idempotencyKey))
    .unique();
  if (existing) {
    if (existing.status === "sent") return { created: false, id: existing._id };
    await ctx.db.patch(existing._id, { status: input.status, detail: input.detail, at: Date.now() });
    return { created: false, id: existing._id };
  }
  const id = await ctx.db.insert("automationEvents", { ...input, at: Date.now() });
  return { created: true, id };
}

export const recordReminder = internalMutation({
  args: {
    loanId: v.id("loans"),
    reminderDate: v.string(),
    status: v.union(v.literal("sent"), v.literal("failed")),
    detail: v.optional(v.string()),
  },
  handler: async (ctx, { loanId, reminderDate, status, detail }) => {
    const loan = await ctx.db.get(loanId);
    if (!loan) return { ok: false as const, reason: "unknown loan" };
    const result = await recordEvent(ctx, {
      loanId,
      kind: "overdue_reminder",
      status,
      idempotencyKey: reminderKey(loanId, reminderDate),
      detail,
    });
    return { ok: true as const, created: result.created };
  },
});

export const recordWorkflowError = internalMutation({
  args: { executionId: v.string(), workflow: v.string(), message: v.string() },
  handler: async (ctx, { executionId, workflow, message }) => {
    await recordEvent(ctx, {
      kind: "workflow_error",
      status: "failed",
      idempotencyKey: `n8n-error:${executionId}`,
      detail: `${workflow}: ${message}`.slice(0, 500),
    });
  },
});

// ---------- Admin visibility ----------

export const retryDelivery = mutation({
  args: { outboxId: v.id("outbox") },
  handler: async (ctx, { outboxId }) => {
    await requireAdmin(ctx);
    const row = await ctx.db.get(outboxId);
    if (!row || row.status !== "failed") return;
    await ctx.db.patch(outboxId, { status: "pending", attempts: 0, lastError: undefined });
    await ctx.scheduler.runAfter(0, internal.automation.deliver, { outboxId });
  },
});

export const health = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const failedDeliveries = await ctx.db.query("outbox").withIndex("by_status", (q) => q.eq("status", "failed")).take(50);
    const pending = await ctx.db.query("outbox").withIndex("by_status", (q) => q.eq("status", "pending")).take(50);
    const workflowErrors = await ctx.db
      .query("automationEvents")
      .withIndex("by_kind", (q) => q.eq("kind", "workflow_error"))
      .order("desc")
      .take(20);
    return {
      pending: pending.length,
      failedDeliveries: failedDeliveries.map((r) => ({
        _id: r._id,
        event: r.event,
        attempts: r.attempts,
        lastError: r.lastError ?? null,
      })),
      workflowErrors: workflowErrors.map((e) => ({ _id: e._id, detail: e.detail ?? "", at: e.at })),
    };
  },
});
