"use client";

import { SignInButton } from "@clerk/nextjs";
import { Authenticated, Unauthenticated, useQuery } from "convex/react";
import Link from "next/link";
import { api } from "@/convex/_generated/api";

export default function Home() {
  const tools = useQuery(api.tools.listPublic);

  return (
    <main className="container">
      <header className="hero">
        <h1>LendLoop</h1>
        <p className="tagline">Borrow what you need. Lend what you don&apos;t.</p>
        <Unauthenticated>
          <SignInButton mode="modal" forceRedirectUrl="/app">
            <button className="primary">Sign in to lend or borrow</button>
          </SignInButton>
        </Unauthenticated>
        <Authenticated>
          <Link className="button primary" href="/app">
            Open your board
          </Link>
        </Authenticated>
      </header>

      <section>
        <h2>Available in the neighborhood</h2>
        {tools === undefined ? (
          <p className="muted">Loading…</p>
        ) : tools.length === 0 ? (
          <p className="muted">No tools listed yet. Be the first to lend one.</p>
        ) : (
          <ul className="grid">
            {tools.map((t) => (
              <li key={t._id} className="card">
                <strong>{t.name}</strong>
                <span className="pill">{t.category}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
