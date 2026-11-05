import { ConvexError } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

type Ctx = QueryCtx | MutationCtx;

// Every protected function goes through one of these helpers, so access rules live
// in the backend and the UI only mirrors them.

export async function getViewer(ctx: Ctx): Promise<Doc<"users"> | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;
  return await ctx.db
    .query("users")
    .withIndex("by_token", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier))
    .unique();
}

export async function requireUser(ctx: Ctx): Promise<Doc<"users">> {
  const viewer = await getViewer(ctx);
  if (!viewer) throw new ConvexError({ code: "UNAUTHENTICATED", message: "Sign in first." });
  return viewer;
}

export async function requireAdmin(ctx: Ctx): Promise<Doc<"users">> {
  const viewer = await requireUser(ctx);
  if (viewer.role !== "admin") throw forbidden();
  return viewer;
}

export function forbidden(message = "You are not allowed to do this.") {
  return new ConvexError({ code: "FORBIDDEN", message });
}

export function notFound(what: string) {
  return new ConvexError({ code: "NOT_FOUND", message: `${what} not found.` });
}

export function invalid(message: string) {
  return new ConvexError({ code: "INVALID", message });
}
