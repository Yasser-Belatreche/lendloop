import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { httpAction, type ActionCtx } from "./_generated/server";
import { isIsoDate } from "./lib/dates";
import { verify } from "./lib/hmac";

// Endpoints called by n8n. Every request must carry a fresh HMAC signature over the
// raw body; anything else gets 401 before the body is parsed.

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function signed(handler: (ctx: ActionCtx, body: Record<string, unknown>) => Promise<Response>) {
  return httpAction(async (ctx, req) => {
    const raw = await req.text();
    const check = await verify(
      process.env.LENDLOOP_WEBHOOK_SECRET,
      req.headers.get("x-lendloop-timestamp"),
      req.headers.get("x-lendloop-signature"),
      raw,
    );
    if (!check.ok) return json(401, { error: "unauthorized" });
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return json(400, { error: "invalid json" });
    }
    if (!body || typeof body !== "object") return json(400, { error: "invalid body" });
    return handler(ctx, body as Record<string, unknown>);
  });
}

const http = httpRouter();

http.route({
  path: "/n8n/overdue-loans",
  method: "POST",
  handler: signed(async (ctx, body) => {
    const asOf = String(body.asOf ?? "");
    if (!isIsoDate(asOf)) return json(400, { error: "asOf must be YYYY-MM-DD" });
    const loans = await ctx.runQuery(internal.automation.overdueLoans, { asOf });
    return json(200, { asOf, loans });
  }),
});

http.route({
  path: "/n8n/reminders",
  method: "POST",
  handler: signed(async (ctx, body) => {
    const { loanId, reminderDate, status, detail } = body;
    if (typeof loanId !== "string" || typeof reminderDate !== "string" || !isIsoDate(reminderDate)) {
      return json(400, { error: "loanId and reminderDate (YYYY-MM-DD) are required" });
    }
    if (status !== "sent" && status !== "failed") return json(400, { error: "status must be sent or failed" });
    try {
      const result = await ctx.runMutation(internal.automation.recordReminder, {
        loanId: loanId as Id<"loans">,
        reminderDate,
        status,
        detail: typeof detail === "string" ? detail.slice(0, 300) : undefined,
      });
      if (!result.ok) return json(404, { error: result.reason });
      // 200 for both first write and replay: retries are safe and n8n doesn't need to care.
      return json(200, { ok: true, created: result.created });
    } catch {
      return json(400, { error: "invalid loanId" });
    }
  }),
});

http.route({
  path: "/n8n/workflow-errors",
  method: "POST",
  handler: signed(async (ctx, body) => {
    const executionId = String(body.executionId ?? "");
    if (!executionId) return json(400, { error: "executionId is required" });
    await ctx.runMutation(internal.automation.recordWorkflowError, {
      executionId,
      workflow: String(body.workflow ?? "unknown"),
      message: String(body.message ?? "unknown error"),
    });
    return json(200, { ok: true });
  }),
});

export default http;
