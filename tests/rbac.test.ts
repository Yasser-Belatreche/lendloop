import { describe, expect, test } from "vitest";
import { api } from "../convex/_generated/api";
import { plusDays, setup, signIn } from "./setup";

const drill = { name: "Cordless drill", category: "power tools" as const, condition: "good" as const, description: "Two batteries" };

describe("role-based access is enforced in Convex functions", () => {
  test("anonymous visitors see only name and category of available tools", async () => {
    const t = setup();
    const lender = await signIn(t, "Lina", "lina@lendloop.test");
    await lender.as.mutation(api.tools.create, drill);

    const pub = await t.query(api.tools.listPublic, {});
    expect(pub).toHaveLength(1);
    expect(Object.keys(pub[0]).sort()).toEqual(["_id", "category", "name"]);
    await expect(t.query(api.tools.list, {})).rejects.toThrow(/Sign in/);
    await expect(t.mutation(api.tools.create, drill)).rejects.toThrow(/Sign in/);
  });

  test("users edit and delete only their own listings; admins can remove any", async () => {
    const t = setup();
    const lina = await signIn(t, "Lina", "lina@lendloop.test");
    const omar = await signIn(t, "Omar", "omar@lendloop.test");
    const admin = await signIn(t, "Ada", "admin@lendloop.test");
    const toolId = await lina.as.mutation(api.tools.create, drill);

    await expect(omar.as.mutation(api.tools.update, { toolId, ...drill, name: "Mine now" })).rejects.toThrow(/owner/);
    await expect(omar.as.mutation(api.tools.remove, { toolId })).rejects.toThrow(/not allowed/);
    await admin.as.mutation(api.tools.remove, { toolId });
    expect(await t.query(api.tools.listPublic, {})).toHaveLength(0);
  });

  test("the first admin comes from a verified email in ADMIN_EMAILS, never from the client", async () => {
    const t = setup();
    const admin = await signIn(t, "Ada", "admin@lendloop.test");
    expect((await admin.as.query(api.users.me, {}))?.role).toBe("admin");

    const unverified = t.withIdentity({ subject: "x", email: "admin@lendloop.test", emailVerified: false, name: "X" });
    await unverified.mutation(api.users.store, {});
    expect((await unverified.query(api.users.me, {}))?.role).toBe("user");
  });

  test("only the lender answers a request, only the borrower cancels it", async () => {
    const t = setup();
    const lina = await signIn(t, "Lina", "lina@lendloop.test");
    const omar = await signIn(t, "Omar", "omar@lendloop.test");
    const sara = await signIn(t, "Sara", "sara@lendloop.test");
    const toolId = await lina.as.mutation(api.tools.create, drill);

    await expect(lina.as.mutation(api.loans.request, { toolId, startDate: plusDays(1), endDate: plusDays(2) })).rejects.toThrow(/own tool/);
    const loanId = await omar.as.mutation(api.loans.request, { toolId, startDate: plusDays(1), endDate: plusDays(2) });

    await expect(omar.as.mutation(api.loans.respond, { loanId, decision: "approve" })).rejects.toThrow(/lender/);
    await expect(sara.as.mutation(api.loans.respond, { loanId, decision: "approve" })).rejects.toThrow(/lender/);
    await expect(sara.as.mutation(api.loans.cancel, { loanId })).rejects.toThrow(/borrower/);
    await lina.as.mutation(api.loans.respond, { loanId, decision: "approve" });
    await expect(omar.as.mutation(api.loans.markReturned, { loanId })).rejects.toThrow(/lender/);
    await lina.as.mutation(api.loans.markReturned, { loanId });

    const [mine] = await omar.as.query(api.loans.myRequests, {});
    expect(mine.status).toBe("returned");
    expect(await sara.as.query(api.loans.myRequests, {})).toHaveLength(0);
    expect(await sara.as.query(api.loans.incoming, {})).toHaveLength(0);
  });

  test("overlapping approved loans are refused", async () => {
    const t = setup();
    const lina = await signIn(t, "Lina", "lina@lendloop.test");
    const omar = await signIn(t, "Omar", "omar@lendloop.test");
    const sara = await signIn(t, "Sara", "sara@lendloop.test");
    const toolId = await lina.as.mutation(api.tools.create, drill);
    const first = await omar.as.mutation(api.loans.request, { toolId, startDate: plusDays(1), endDate: plusDays(5) });
    const second = await sara.as.mutation(api.loans.request, { toolId, startDate: plusDays(3), endDate: plusDays(4) });
    await lina.as.mutation(api.loans.respond, { loanId: first, decision: "approve" });
    await expect(lina.as.mutation(api.loans.respond, { loanId: second, decision: "approve" })).rejects.toThrow(/overlaps/);
  });

  test("admin-only views and the Trusted Lender flag", async () => {
    const t = setup();
    const lina = await signIn(t, "Lina", "lina@lendloop.test");
    const admin = await signIn(t, "Ada", "admin@lendloop.test");

    await expect(lina.as.query(api.loans.all, {})).rejects.toThrow(/not allowed/);
    await expect(lina.as.query(api.users.listForAdmin, {})).rejects.toThrow(/not allowed/);
    await expect(lina.as.mutation(api.users.setTrustedLender, { userId: lina.id, trusted: true })).rejects.toThrow(/not allowed/);

    await admin.as.mutation(api.users.setTrustedLender, { userId: lina.id, trusted: true });
    expect((await lina.as.query(api.users.me, {}))?.trustedLender).toBe(true);
    expect(await admin.as.query(api.loans.all, {})).toEqual([]);
  });
});
