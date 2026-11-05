import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { getViewer, notFound, requireAdmin } from "./lib/auth";

function adminEmails() {
  return (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

// Called by the client right after Clerk sign-in. Creates the user row on first
// sign-in; the role is never taken from the client. A verified email listed in the
// ADMIN_EMAILS deployment variable bootstraps the first admin(s).
export const store = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const email = identity.email?.toLowerCase();
    const existing = await getViewer(ctx);
    const name = identity.givenName ?? identity.name ?? email?.split("@")[0] ?? "Neighbor";
    if (existing) {
      if (existing.name !== name || existing.email !== email) {
        await ctx.db.patch(existing._id, { name, email });
      }
      return existing._id;
    }
    const isAdmin = !!email && identity.emailVerified === true && adminEmails().includes(email);
    return await ctx.db.insert("users", {
      tokenIdentifier: identity.tokenIdentifier,
      name,
      email,
      role: isAdmin ? "admin" : "user",
      trustedLender: false,
    });
  },
});

export const me = query({
  args: {},
  handler: async (ctx) => {
    const viewer = await getViewer(ctx);
    if (!viewer) return null;
    return { _id: viewer._id, name: viewer.name, role: viewer.role, trustedLender: viewer.trustedLender };
  },
});

export const listForAdmin = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const users = await ctx.db.query("users").collect();
    return users.map((u) => ({
      _id: u._id,
      name: u.name,
      email: u.email,
      role: u.role,
      trustedLender: u.trustedLender,
    }));
  },
});

export const setTrustedLender = mutation({
  args: { userId: v.id("users"), trusted: v.boolean() },
  handler: async (ctx, { userId, trusted }) => {
    await requireAdmin(ctx);
    const user = await ctx.db.get(userId);
    if (!user) throw notFound("User");
    await ctx.db.patch(userId, { trustedLender: trusted });
  },
});

// Not exposed to clients: `npx convex run users:setRole '{"email":"a@b.c","role":"admin"}'`
export const setRole = internalMutation({
  args: { email: v.string(), role: v.union(v.literal("admin"), v.literal("user")) },
  handler: async (ctx, { email, role }) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_email", (q) => q.eq("email", email.toLowerCase()))
      .unique();
    if (!user) throw notFound("User");
    await ctx.db.patch(user._id, { role });
  },
});
