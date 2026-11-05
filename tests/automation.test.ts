import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../convex/_generated/api";
import { sign, verify } from "../convex/lib/hmac";
import { SECRET, plusDays, setup, signIn, type T } from "./setup";

const drill = { name: "Cordless drill", category: "power tools" as const, condition: "good" as const, description: "" };

async function signedPost(t: T, path: string, body: unknown, opts: { secret?: string; ts?: number } = {}) {
  const raw = JSON.stringify(body);
  const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
  return t.fetch(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-lendloop-timestamp": ts,
      "x-lendloop-signature": await sign(opts.secret ?? SECRET, ts, raw),
    },
    body: raw,
  });
}

// An approved loan whose end date is already past, created directly in the DB.
async function overdueLoan(t: T) {
  const lina = await signIn(t, "Lina", "lina@lendloop.test");
  const omar = await signIn(t, "Omar", "omar@lendloop.test");
  const toolId = await lina.as.mutation(api.tools.create, drill);
  const loanId = await t.run((ctx) =>
    ctx.db.insert("loans", {
      toolId,
      ownerId: lina.id,
      borrowerId: omar.id,
      startDate: plusDays(-10),
      endDate: plusDays(-3),
      status: "approved",
    }),
  );
  return { loanId, lina, omar };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("HMAC signing", () => {
  test("verifies good signatures and rejects tampering, wrong secrets and replays", async () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = await sign(SECRET, ts, '{"a":1}');
    expect(await verify(SECRET, ts, sig, '{"a":1}')).toEqual({ ok: true });
    expect((await verify(SECRET, ts, sig, '{"a":2}')).ok).toBe(false);
    expect((await verify("other", ts, sig, '{"a":1}')).ok).toBe(false);
    expect((await verify(SECRET, ts, sig, '{"a":1}', Number(ts) + 3600)).ok).toBe(false);
    expect((await verify(undefined, ts, sig, '{"a":1}')).ok).toBe(false);
  });
});

describe("n8n -> Convex endpoints", () => {
  test("unsigned or stale requests are rejected before anything is read", async () => {
    const t = setup();
    await overdueLoan(t);
    const unsigned = await t.fetch("/n8n/overdue-loans", { method: "POST", body: JSON.stringify({ asOf: plusDays(0) }) });
    expect(unsigned.status).toBe(401);
    const wrongSecret = await signedPost(t, "/n8n/overdue-loans", { asOf: plusDays(0) }, { secret: "nope" });
    expect(wrongSecret.status).toBe(401);
    const stale = await signedPost(t, "/n8n/overdue-loans", { asOf: plusDays(0) }, { ts: Math.floor(Date.now() / 1000) - 3600 });
    expect(stale.status).toBe(401);
  });

  test("overdue loans expose only the fields a reminder needs", async () => {
    const t = setup();
    const { loanId } = await overdueLoan(t);
    const res = await signedPost(t, "/n8n/overdue-loans", { asOf: plusDays(0) });
    expect(res.status).toBe(200);
    const { loans } = await res.json();
    expect(loans).toEqual([
      {
        loanId,
        borrowerEmail: "omar@lendloop.test",
        borrowerName: "Omar",
        toolName: "Cordless drill",
        dueDate: plusDays(-3),
        daysOverdue: 3,
      },
    ]);
  });

  test("reminder write-backs are idempotent and a sent reminder is not fetched again that day", async () => {
    const t = setup();
    const { loanId, omar } = await overdueLoan(t);
    const body = { loanId, reminderDate: plusDays(0), status: "sent" };

    const first = await signedPost(t, "/n8n/reminders", body);
    const retry = await signedPost(t, "/n8n/reminders", body);
    expect(await first.json()).toEqual({ ok: true, created: true });
    expect(await retry.json()).toEqual({ ok: true, created: false });

    const events = await t.run((ctx) => ctx.db.query("automationEvents").collect());
    expect(events.filter((e) => e.kind === "overdue_reminder")).toHaveLength(1);

    const again = await (await signedPost(t, "/n8n/overdue-loans", { asOf: plusDays(0) })).json();
    expect(again.loans).toEqual([]);

    const [loan] = await omar.as.query(api.loans.myRequests, {});
    expect(loan.overdue).toBe(true);
    expect(loan.activity[0]).toMatchObject({ kind: "overdue_reminder", status: "sent" });
  });

  test("a late 'failed' duplicate never overwrites a 'sent' reminder", async () => {
    const t = setup();
    const { loanId } = await overdueLoan(t);
    await signedPost(t, "/n8n/reminders", { loanId, reminderDate: plusDays(0), status: "sent" });
    await signedPost(t, "/n8n/reminders", { loanId, reminderDate: plusDays(0), status: "failed" });
    const [event] = await t.run((ctx) => ctx.db.query("automationEvents").collect());
    expect(event.status).toBe("sent");
  });

  test("workflow errors from the n8n error workflow are recorded once per execution", async () => {
    const t = setup();
    const admin = await signIn(t, "Ada", "admin@lendloop.test");
    const err = { executionId: "42", workflow: "LendLoop - Overdue reminders", message: "Convex unreachable" };
    await signedPost(t, "/n8n/workflow-errors", err);
    await signedPost(t, "/n8n/workflow-errors", err);
    const health = await admin.as.query(api.automation.health, {});
    expect(health.workflowErrors).toHaveLength(1);
  });
});

describe("Convex -> n8n request notifications", () => {
  test("a request is delivered once, signed, with only the needed fields", async () => {
    vi.useFakeTimers();
    const t = setup();
    const calls: { headers: Headers; body: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        calls.push({ headers: new Headers(init.headers), body: String(init.body) });
        return new Response("ok", { status: 200 });
      }),
    );
    const lina = await signIn(t, "Lina", "lina@lendloop.test");
    const omar = await signIn(t, "Omar", "omar@lendloop.test");
    const toolId = await lina.as.mutation(api.tools.create, drill);
    await omar.as.mutation(api.loans.request, { toolId, startDate: plusDays(1), endDate: plusDays(2) });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(calls).toHaveLength(1);
    const payload = JSON.parse(calls[0].body);
    expect(payload.recipient).toEqual({ email: "lina@lendloop.test", name: "Lina", role: "lender" });
    expect(Object.keys(payload).sort()).toEqual(["endDate", "event", "eventId", "loanId", "recipient", "startDate", "status", "tool"]);
    const ok = await verify(SECRET, calls[0].headers.get("x-lendloop-timestamp"), calls[0].headers.get("x-lendloop-signature"), calls[0].body);
    expect(ok).toEqual({ ok: true });

    const [loan] = await omar.as.query(api.loans.myRequests, {});
    expect(loan.status).toBe("requested");
    const [incoming] = await lina.as.query(api.loans.incoming, {});
    expect(incoming.activity[0]).toMatchObject({ kind: "request_notification", status: "sent" });
  });

  test("failed deliveries retry with backoff, then surface as failed for the admin", async () => {
    vi.useFakeTimers();
    const t = setup();
    const fetchMock = vi.fn(async () => new Response("down", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const admin = await signIn(t, "Ada", "admin@lendloop.test");
    const lina = await signIn(t, "Lina", "lina@lendloop.test");
    const omar = await signIn(t, "Omar", "omar@lendloop.test");
    const toolId = await lina.as.mutation(api.tools.create, drill);
    await omar.as.mutation(api.loans.request, { toolId, startDate: plusDays(1), endDate: plusDays(2) });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(fetchMock).toHaveBeenCalledTimes(5);
    const health = await admin.as.query(api.automation.health, {});
    expect(health.failedDeliveries).toHaveLength(1);
    expect(health.failedDeliveries[0]).toMatchObject({ event: "loan.requested", attempts: 5, lastError: "n8n responded 503" });
  });
});
