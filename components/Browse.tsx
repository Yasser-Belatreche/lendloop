"use client";

import { useMutation, useQuery } from "convex/react";
import { useState } from "react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { CATEGORIES, type Category, useAction } from "./ui";

function today() {
  return new Date().toISOString().slice(0, 10);
}

function RequestForm({ toolId, onDone }: { toolId: Id<"tools">; onDone: () => void }) {
  const request = useMutation(api.loans.request);
  const [startDate, setStart] = useState(today());
  const [endDate, setEnd] = useState(today());
  const send = useAction(() => request({ toolId, startDate, endDate }));
  return (
    <form
      className="inline-form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (await send.run()) onDone();
      }}
    >
      <input type="date" value={startDate} min={today()} onChange={(e) => setStart(e.target.value)} required />
      <span>to</span>
      <input type="date" value={endDate} min={startDate} onChange={(e) => setEnd(e.target.value)} required />
      <button className="primary" disabled={send.pending}>
        Send request
      </button>
      {send.error && <p className="error">{send.error}</p>}
    </form>
  );
}

export function Browse({ isAdmin }: { isAdmin: boolean }) {
  const [category, setCategory] = useState<Category | "">("");
  const tools = useQuery(api.tools.list, category ? { category } : {});
  const remove = useMutation(api.tools.remove);
  const [requesting, setRequesting] = useState<Id<"tools"> | null>(null);
  const [sent, setSent] = useState<Id<"tools"> | null>(null);

  return (
    <section>
      <div className="toolbar">
        <h2>All tools</h2>
        <select value={category} onChange={(e) => setCategory(e.target.value as Category | "")} aria-label="Filter by category">
          <option value="">All categories</option>
          {CATEGORIES.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </div>
      {tools === undefined ? (
        <p className="muted">Loading…</p>
      ) : tools.length === 0 ? (
        <p className="muted">Nothing here yet.</p>
      ) : (
        <ul className="list">
          {tools.map((t) => (
            <li key={t._id} className="card">
              <div className="card-head">
                <strong>{t.name}</strong>
                <span className="pill">{t.category}</span>
                {t.available ? (
                  <span className="pill status-approved">Available</span>
                ) : (
                  <span className="pill status-requested">On loan until {t.onLoanUntil}</span>
                )}
              </div>
              <p className="muted">
                {t.condition} · lent by {t.mine ? "you" : t.ownerName}
                {t.ownerTrusted && <span className="badge">Trusted Lender</span>}
              </p>
              {t.description && <p>{t.description}</p>}
              <div className="actions">
                {!t.mine && requesting !== t._id && (
                  <button onClick={() => setRequesting(t._id)}>{sent === t._id ? "Request sent ✓" : "Request to borrow"}</button>
                )}
                {isAdmin && !t.mine && (
                  <button className="danger" onClick={() => confirmRemove(t.name) && remove({ toolId: t._id })}>
                    Remove listing
                  </button>
                )}
              </div>
              {requesting === t._id && (
                <RequestForm
                  toolId={t._id}
                  onDone={() => {
                    setRequesting(null);
                    setSent(t._id);
                  }}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function confirmRemove(name: string) {
  return window.confirm(`Remove "${name}" from LendLoop?`);
}
