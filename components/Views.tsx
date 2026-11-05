"use client";

import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { ToolForm } from "./ToolForm";
import { Activity, StatusPill, timeAgo, useAction } from "./ui";

export function MyListings() {
  const tools = useQuery(api.tools.mine);
  const remove = useMutation(api.tools.remove);
  const [editing, setEditing] = useState<Id<"tools"> | null>(null);
  const del = useAction((toolId: Id<"tools">) => remove({ toolId }));

  return (
    <section className="two-col">
      <div>
        <h2>List a tool</h2>
        <ToolForm />
      </div>
      <div>
        <h2>My listings</h2>
        {del.error && <p className="error">{del.error}</p>}
        {tools === undefined ? (
          <p className="muted">Loading…</p>
        ) : tools.length === 0 ? (
          <p className="muted">You haven&apos;t listed anything yet.</p>
        ) : (
          <ul className="list">
            {tools.map((t) => (
              <li key={t._id} className="card">
                {editing === t._id ? (
                  <ToolForm initial={t} onDone={() => setEditing(null)} />
                ) : (
                  <>
                    <div className="card-head">
                      <strong>{t.name}</strong>
                      <span className="pill">{t.category}</span>
                      {!t.available && <span className="pill status-requested">On loan until {t.onLoanUntil}</span>}
                    </div>
                    <p className="muted">{t.condition}</p>
                    <div className="actions">
                      <button onClick={() => setEditing(t._id)}>Edit</button>
                      <button
                        className="danger"
                        disabled={del.pending}
                        onClick={() => window.confirm(`Delete "${t.name}"?`) && del.run(t._id)}
                      >
                        Delete
                      </button>
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

type LoanRow = NonNullable<ReturnType<typeof useQuery<typeof api.loans.incoming>>>[number];

function LoanCard({ loan, children }: { loan: LoanRow; children?: React.ReactNode }) {
  return (
    <li className="card">
      <div className="card-head">
        <strong>{loan.toolName}</strong>
        <StatusPill status={loan.status} overdue={loan.overdue} />
      </div>
      <p className="muted">
        {loan.startDate} → {loan.endDate} · {loan.isLender ? `borrower: ${loan.borrowerName}` : `lender: ${loan.lenderName}`}
      </p>
      <Activity items={loan.activity} />
      {children && <div className="actions">{children}</div>}
    </li>
  );
}

export function MyRequests() {
  const loans = useQuery(api.loans.myRequests);
  const cancel = useMutation(api.loans.cancel);
  const act = useAction((loanId: Id<"loans">) => cancel({ loanId }));
  return (
    <section>
      <h2>My requests</h2>
      {act.error && <p className="error">{act.error}</p>}
      {loans === undefined ? (
        <p className="muted">Loading…</p>
      ) : loans.length === 0 ? (
        <p className="muted">You haven&apos;t asked to borrow anything yet.</p>
      ) : (
        <ul className="list">
          {loans.map((l) => (
            <LoanCard key={l._id} loan={l}>
              {l.status === "requested" && (
                <button disabled={act.pending} onClick={() => act.run(l._id)}>
                  Cancel request
                </button>
              )}
            </LoanCard>
          ))}
        </ul>
      )}
    </section>
  );
}

export function Incoming() {
  const loans = useQuery(api.loans.incoming);
  const respond = useMutation(api.loans.respond);
  const returned = useMutation(api.loans.markReturned);
  const act = useAction(async (kind: "approve" | "decline" | "return", loanId: Id<"loans">) => {
    if (kind === "return") await returned({ loanId });
    else await respond({ loanId, decision: kind });
  });
  return (
    <section>
      <h2>Incoming requests</h2>
      {act.error && <p className="error">{act.error}</p>}
      {loans === undefined ? (
        <p className="muted">Loading…</p>
      ) : loans.length === 0 ? (
        <p className="muted">No one has asked for your tools yet.</p>
      ) : (
        <ul className="list">
          {loans.map((l) => (
            <LoanCard key={l._id} loan={l}>
              {l.status === "requested" && (
                <>
                  <button className="primary" disabled={act.pending} onClick={() => act.run("approve", l._id)}>
                    Approve
                  </button>
                  <button disabled={act.pending} onClick={() => act.run("decline", l._id)}>
                    Decline
                  </button>
                </>
              )}
              {l.status === "approved" && (
                <button disabled={act.pending} onClick={() => act.run("return", l._id)}>
                  Mark as returned
                </button>
              )}
            </LoanCard>
          ))}
        </ul>
      )}
    </section>
  );
}

export function Admin() {
  const loans = useQuery(api.loans.all);
  const users = useQuery(api.users.listForAdmin);
  const health = useQuery(api.automation.health);
  const setTrusted = useMutation(api.users.setTrustedLender);
  const retry = useMutation(api.automation.retryDelivery);

  return (
    <section className="stack">
      <div>
        <h2>Automation health</h2>
        {health && (
          <div className="card">
            <p>
              Pending notifications: <strong>{health.pending}</strong> · Failed deliveries:{" "}
              <strong>{health.failedDeliveries.length}</strong> · Workflow errors: <strong>{health.workflowErrors.length}</strong>
            </p>
            {health.failedDeliveries.map((f) => (
              <p key={f._id} className="error">
                {f.event} failed after {f.attempts} attempts: {f.lastError}{" "}
                <button onClick={() => retry({ outboxId: f._id })}>Retry</button>
              </p>
            ))}
            {health.workflowErrors.map((w) => (
              <p key={w._id} className="error">
                {w.detail} ({timeAgo(w.at)})
              </p>
            ))}
          </div>
        )}
      </div>

      <div>
        <h2>Neighbors</h2>
        <ul className="list">
          {users?.map((u) => (
            <li key={u._id} className="card row-between">
              <span>
                <strong>{u.name}</strong> <span className="muted">{u.email}</span> {u.role === "admin" && <span className="pill">admin</span>}
                {u.trustedLender && <span className="badge">Trusted Lender</span>}
              </span>
              <button onClick={() => setTrusted({ userId: u._id, trusted: !u.trustedLender })}>
                {u.trustedLender ? "Remove Trusted Lender" : "Mark Trusted Lender"}
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div>
        <h2>All loans</h2>
        <ul className="list">
          {loans?.map((l) => (
            <LoanCard key={l._id} loan={l} />
          ))}
        </ul>
      </div>
    </section>
  );
}
