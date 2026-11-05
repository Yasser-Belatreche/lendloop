"use client";

import { ConvexError } from "convex/values";
import { useState } from "react";

export const CATEGORIES = ["power tools", "hand tools", "garden", "kitchen", "camping", "cleaning", "other"] as const;
export const CONDITIONS = ["like new", "good", "fair", "worn"] as const;
export type Category = (typeof CATEGORIES)[number];
export type Condition = (typeof CONDITIONS)[number];

export function errorMessage(e: unknown) {
  if (e instanceof ConvexError && typeof e.data === "object" && e.data && "message" in e.data) {
    return String((e.data as { message: string }).message);
  }
  return "Something went wrong. Please try again.";
}

// Runs a mutation, shows a friendly error and disables the button while pending.
export function useAction<A extends unknown[]>(fn: (...args: A) => Promise<unknown>) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (...args: A) => {
    setPending(true);
    setError(null);
    try {
      await fn(...args);
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setPending(false);
    }
  };
  return { run, pending, error };
}

const STATUS_LABEL: Record<string, string> = {
  requested: "Requested",
  approved: "Approved",
  declined: "Declined",
  cancelled: "Cancelled",
  returned: "Returned",
};

export function StatusPill({ status, overdue }: { status: string; overdue?: boolean }) {
  if (overdue) return <span className="pill danger">Overdue</span>;
  return <span className={`pill status-${status}`}>{STATUS_LABEL[status] ?? status}</span>;
}

export function timeAgo(ms: number) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

const ACTIVITY_LABEL: Record<string, string> = {
  request_notification: "Notification",
  overdue_reminder: "Reminder",
  workflow_error: "Workflow error",
};

export function Activity({ items }: { items: { kind: string; status: string; at: number }[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="activity">
      {items.map((a, i) => (
        <li key={i} className={a.status === "failed" ? "failed" : undefined}>
          {ACTIVITY_LABEL[a.kind] ?? a.kind} {a.status} {timeAgo(a.at)}
        </li>
      ))}
    </ul>
  );
}
