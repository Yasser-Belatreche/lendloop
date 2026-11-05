import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, type QueryCtx } from "./_generated/server";
import { forbidden, invalid, notFound, requireUser } from "./lib/auth";
import { todayUtc } from "./lib/dates";
import { category, condition } from "./schema";

const MAX = { name: 80, description: 500 };

function clean(args: { name: string; description: string }) {
  const name = args.name.trim();
  const description = args.description.trim();
  if (!name || name.length > MAX.name) throw invalid(`Name must be 1-${MAX.name} characters.`);
  if (description.length > MAX.description) throw invalid(`Description must be at most ${MAX.description} characters.`);
  return { name, description };
}

async function activeLoan(ctx: QueryCtx, toolId: Id<"tools">) {
  const today = todayUtc();
  const loans = await ctx.db
    .query("loans")
    .withIndex("by_tool", (q) => q.eq("toolId", toolId))
    .filter((q) => q.eq(q.field("status"), "approved"))
    .collect();
  return loans.find((l) => l.startDate <= today) ?? null;
}

async function withAvailability(ctx: QueryCtx, tool: Doc<"tools">) {
  const loan = await activeLoan(ctx, tool._id);
  return {
    _id: tool._id,
    name: tool.name,
    category: tool.category,
    condition: tool.condition,
    description: tool.description,
    ownerId: tool.ownerId,
    available: !loan,
    onLoanUntil: loan?.endDate ?? null,
  };
}

// Public, unauthenticated: name and category only. No owner, description or loans.
export const listPublic = query({
  args: {},
  handler: async (ctx) => {
    const tools = await ctx.db
      .query("tools")
      .filter((q) => q.eq(q.field("removedAt"), undefined))
      .order("desc")
      .take(200);
    const out = [];
    for (const t of tools) {
      if (!(await activeLoan(ctx, t._id))) out.push({ _id: t._id, name: t.name, category: t.category });
    }
    return out;
  },
});

export const list = query({
  args: { category: v.optional(category) },
  handler: async (ctx, args) => {
    const viewer = await requireUser(ctx);
    const base = args.category
      ? ctx.db.query("tools").withIndex("by_category", (q) => q.eq("category", args.category!))
      : ctx.db.query("tools");
    const tools = await base.filter((q) => q.eq(q.field("removedAt"), undefined)).order("desc").take(200);
    const owners = new Map<Id<"users">, Doc<"users"> | null>();
    const out = [];
    for (const t of tools) {
      if (!owners.has(t.ownerId)) owners.set(t.ownerId, await ctx.db.get(t.ownerId));
      const owner = owners.get(t.ownerId);
      out.push({
        ...(await withAvailability(ctx, t)),
        // Signed-in neighbors see the lender's first name and trust badge, never their email.
        ownerName: owner?.name ?? "Neighbor",
        ownerTrusted: owner?.trustedLender ?? false,
        mine: t.ownerId === viewer._id,
      });
    }
    return out;
  },
});

export const mine = query({
  args: {},
  handler: async (ctx) => {
    const viewer = await requireUser(ctx);
    const tools = await ctx.db
      .query("tools")
      .withIndex("by_owner", (q) => q.eq("ownerId", viewer._id))
      .filter((q) => q.eq(q.field("removedAt"), undefined))
      .order("desc")
      .collect();
    return Promise.all(tools.map((t) => withAvailability(ctx, t)));
  },
});

export const create = mutation({
  args: { name: v.string(), category, condition, description: v.string() },
  handler: async (ctx, args) => {
    const viewer = await requireUser(ctx);
    const { name, description } = clean(args);
    return await ctx.db.insert("tools", {
      ownerId: viewer._id,
      name,
      category: args.category,
      condition: args.condition,
      description,
    });
  },
});

export const update = mutation({
  args: { toolId: v.id("tools"), name: v.string(), category, condition, description: v.string() },
  handler: async (ctx, args) => {
    const viewer = await requireUser(ctx);
    const tool = await ctx.db.get(args.toolId);
    if (!tool || tool.removedAt) throw notFound("Tool");
    if (tool.ownerId !== viewer._id) throw forbidden("Only the owner can edit this listing.");
    const { name, description } = clean(args);
    await ctx.db.patch(args.toolId, { name, category: args.category, condition: args.condition, description });
  },
});

// Owners delete their own listings; admins can remove any listing. Soft delete keeps
// loan history intact; open requests on the tool are cancelled.
export const remove = mutation({
  args: { toolId: v.id("tools") },
  handler: async (ctx, { toolId }) => {
    const viewer = await requireUser(ctx);
    const tool = await ctx.db.get(toolId);
    if (!tool || tool.removedAt) throw notFound("Tool");
    if (tool.ownerId !== viewer._id && viewer.role !== "admin") throw forbidden();
    await ctx.db.patch(toolId, { removedAt: Date.now() });
    const open = await ctx.db
      .query("loans")
      .withIndex("by_tool", (q) => q.eq("toolId", toolId))
      .filter((q) => q.eq(q.field("status"), "requested"))
      .collect();
    for (const loan of open) await ctx.db.patch(loan._id, { status: "cancelled" });
  },
});
