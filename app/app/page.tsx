"use client";

import { UserButton } from "@clerk/nextjs";
import { AuthLoading, Authenticated, Unauthenticated, useConvexAuth, useMutation, useQuery } from "convex/react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Browse } from "@/components/Browse";
import { Admin, Incoming, MyListings, MyRequests } from "@/components/Views";
import { api } from "@/convex/_generated/api";

const TABS = ["Browse", "My listings", "My requests", "Incoming requests"] as const;
type Tab = (typeof TABS)[number] | "Admin";

function useStoreUser() {
  const { isAuthenticated } = useConvexAuth();
  const store = useMutation(api.users.store);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!isAuthenticated) return;
    store().then(() => setReady(true));
  }, [isAuthenticated, store]);
  return ready;
}

function Board() {
  const ready = useStoreUser();
  const me = useQuery(api.users.me, ready ? {} : "skip");
  const [tab, setTab] = useState<Tab>("Browse");
  if (!ready || me === undefined) return <p className="muted">Loading…</p>;
  const isAdmin = me?.role === "admin";
  const tabs: Tab[] = isAdmin ? [...TABS, "Admin"] : [...TABS];

  return (
    <>
      <nav className="tabs">
        {tabs.map((t) => (
          <button key={t} className={t === tab ? "active" : undefined} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </nav>
      {tab === "Browse" && <Browse isAdmin={isAdmin} />}
      {tab === "My listings" && <MyListings />}
      {tab === "My requests" && <MyRequests />}
      {tab === "Incoming requests" && <Incoming />}
      {tab === "Admin" && isAdmin && <Admin />}
    </>
  );
}

export default function AppPage() {
  return (
    <main className="container">
      <header className="topbar">
        <Link href="/" className="brand">
          LendLoop
        </Link>
        <UserButton />
      </header>
      <AuthLoading>
        <p className="muted">Loading…</p>
      </AuthLoading>
      <Unauthenticated>
        <p>
          Please <Link href="/">sign in</Link> first.
        </p>
      </Unauthenticated>
      <Authenticated>
        <Board />
      </Authenticated>
    </main>
  );
}
