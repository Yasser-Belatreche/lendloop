import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import { forbidden, invalid, notFound, requireAdmin, requireUser } from "./lib/auth";
import { isIsoDate, overlaps, todayUtc } from "./lib/dates";

const MAX_LOAN_DAYS = 30;

type LoanEvent = "loan.requested" | "loan.approved" | "loan.declined" | "loan.cancelled" | "loan.returned";

// Queue a signed webhook to n8n. The outbox row is written in the same transaction as
// the status change, so a notification is never lost or sent for a change that rolled back.
async function enqueueNotification(ctx: MutationCtx, loan: Doc<"loans">, event: LoanEvent) {
  const notifyOwner = event === "loan.requested" || event === "loan.cancelled";
  const recipient = await ctx.db.get(notifyOwner ? loan.ownerId : loan.borrowerId);
  const tool = await ctx.db.get(loan.toolId);
  if (!recipient?.email || !tool) return;
  const idempotencyKey = `${loan._id}:${event}`;
  const existing = await ctx.db
    .query("outbox")
    .withIndex("by_key", (q) => q.eq("idempotencyKey", idempotencyKey))
    .unique();
  if (existing) return;
  // Data minimization: only what the notification needs. No ids of other users,
  // no descriptions, no addresses.
  const payload = JSON.stringify({
    eventId: idempotencyKey,
    event,
    loanId: loan._id,
    recipient: { email: recipient.email, name: recipient.name, role: notifyOwner ? "lender" : "borrower" },
    tool: { name: tool.name },
    startDate: loan.startDate,
    endDate: loan.endDate,
    status: loan.status,
  });
  const outboxId = await ctx.db.insert("outbox", {
    loanId: loan._id,
    event,
    idempotencyKey,
    payload,
    status: "pending",
    attempts: 0,
  });
  await ctx.scheduler.runAfter(0, internal.automation.deliver, { outboxId });
}

async function loadLoan(ctx: QueryCtx, loanId: Id<"loans">) {
  const loan = await ctx.db.get(loanId);
  if (!loan) throw notFound("Loan");
  return loan;
}

async function setStatus(ctx: MutationCtx, loan: Doc<"loans">, patch: Partial<Doc<"loans">>, event: LoanEvent) {
  await ctx.db.patch(loan._id, patch);
  await enqueueNotification(ctx, { ...loan, ...patch }, event);
}

export const request = mutation({
  args: { toolId: v.id("tools"), startDate: v.string(), endDate: v.string() },
  handler: async (ctx, { toolId, startDate, endDate }) => {
    const viewer = await requireUser(ctx);
    const tool = await ctx.db.get(toolId);
    if (!tool || tool.removedAt) throw notFound("Tool");
    if (tool.ownerId === viewer._id) throw invalid("You can't borrow your own tool.");
    if (!isIsoDate(startDate) || !isIsoDate(endDate)) throw invalid("Dates must be YYYY-MM-DD.");
    if (startDate < todayUtc()) throw invalid("The start date is in the past.");
    if (endDate < startDate) throw invalid("The end date is before the start date.");
    const days = (Date.parse(endDate) - Date.parse(startDate)) / 86_400_000 + 1;
    if (days > MAX_LOAN_DAYS) throw invalid(`Loans are limited to ${MAX_LOAN_DAYS} days.`);

    const loans = await ctx.db.query("loans").withIndex("by_tool", (q) => q.eq("toolId", toolId)).collect();
    if (loans.some((l) => l.status === "approved" && overlaps(l.startDate, l.endDate, startDate, endDate))) {
      throw invalid("The tool is already lent out for part of those dates.");
    }
    if (loans.some((l) => l.status === "requested" && l.borrowerId === viewer._id)) {
      throw invalid("You already have an open request for this tool.");
    }
    const loanId = await ctx.db.insert("loans", {
      toolId,
      ownerId: tool.ownerId,
      borrowerId: viewer._id,
      startDate,
      endDate,
      status: "requested",
    });
    await enqueueNotification(ctx, (await ctx.db.get(loanId))!, "loan.requested");
    return loanId;
  },
});

// Only the tool's owner can approve or decline, and only while the request is open.
export const respond = mutation({
  args: { loanId: v.id("loans"), decision: v.union(v.literal("approve"), v.literal("decline")) },
  handler: async (ctx, { loanId, decision }) => {
    const viewer = await requireUser(ctx);
    const loan = await loadLoan(ctx, loanId);
    if (loan.ownerId !== viewer._id) throw forbidden("Only the lender can answer this request.");
    if (loan.status !== "requested") throw invalid("This request is no longer open.");
    if (decision === "decline") return setStatus(ctx, loan, { status: "declined" }, "loan.declined");

    const others = await ctx.db.query("loans").withIndex("by_tool", (q) => q.eq("toolId", loan.toolId)).collect();
    if (others.some((l) => l.status === "approved" && overlaps(l.startDate, l.endDate, loan.startDate, loan.endDate))) {
      throw invalid("Another approved loan overlaps these dates.");
    }
    await setStatus(ctx, loan, { status: "approved" }, "loan.approved");
  },
});

export const cancel = mutation({
  args: { loanId: v.id("loans") },
  handler: async (ctx, { loanId }) => {
    const viewer = await requireUser(ctx);
    const loan = await loadLoan(ctx, loanId);
    if (loan.borrowerId !== viewer._id) throw forbidden("Only the borrower can cancel this request.");
    if (loan.status !== "requested") throw invalid("Only open requests can be cancelled.");
    await setStatus(ctx, loan, { status: "cancelled" }, "loan.cancelled");
  },
});

// The lender confirms the tool came back.
export const markReturned = mutation({
  args: { loanId: v.id("loans") },
  handler: async (ctx, { loanId }) => {
    const viewer = await requireUser(ctx);
    const loan = await loadLoan(ctx, loanId);
    if (loan.ownerId !== viewer._id) throw forbidden("Only the lender can mark a loan as returned.");
    if (loan.status !== "approved") throw invalid("Only approved loans can be returned.");
    await setStatus(ctx, loan, { status: "returned", returnedAt: Date.now() }, "loan.returned");
  },
});

async function present(ctx: QueryCtx, loans: Doc<"loans">[], viewerId: Id<"users"> | null) {
  const today = todayUtc();
  return Promise.all(
    loans.map(async (l) => {
      const [tool, owner, borrower, events] = await Promise.all([
        ctx.db.get(l.toolId),
        ctx.db.get(l.ownerId),
        ctx.db.get(l.borrowerId),
        ctx.db.query("automationEvents").withIndex("by_loan", (q) => q.eq("loanId", l._id)).order("desc").take(5),
      ]);
      return {
        _id: l._id,
        toolName: tool?.name ?? "Removed tool",
        lenderName: owner?.name ?? "Neighbor",
        borrowerName: borrower?.name ?? "Neighbor",
        startDate: l.startDate,
        endDate: l.endDate,
        status: l.status,
        overdue: l.status === "approved" && l.endDate < today,
        isLender: l.ownerId === viewerId,
        isBorrower: l.borrowerId === viewerId,
        activity: events.map((e) => ({ kind: e.kind, status: e.status, at: e.at })),
      };
    }),
  );
}

export const myRequests = query({
  args: {},
  handler: async (ctx) => {
    const viewer = await requireUser(ctx);
    const loans = await ctx.db
      .query("loans")
      .withIndex("by_borrower", (q) => q.eq("borrowerId", viewer._id))
      .order("desc")
      .take(100);
    return present(ctx, loans, viewer._id);
  },
});

export const incoming = query({
  args: {},
  handler: async (ctx) => {
    const viewer = await requireUser(ctx);
    const loans = await ctx.db
      .query("loans")
      .withIndex("by_owner", (q) => q.eq("ownerId", viewer._id))
      .order("desc")
      .take(100);
    return present(ctx, loans, viewer._id);
  },
});

export const all = query({
  args: {},
  handler: async (ctx) => {
    const viewer = await requireAdmin(ctx);
    const loans = await ctx.db.query("loans").order("desc").take(200);
    return present(ctx, loans, viewer._id);
  },
});
