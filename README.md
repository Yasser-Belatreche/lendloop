# LendLoop

**Borrow what you need. Lend what you don't.**

A neighborhood tool-lending board. Neighbors list tools, request to borrow them for a date range, lenders approve or decline, and n8n handles the notifications and the daily overdue reminders.

Stack: Next.js 16 (App Router) · Clerk · Convex · n8n (self-hosted, Docker) · TypeScript.

---

## What's in the box

| Requirement | Where |
| --- | --- |
| Public page: tagline, read-only list (name + category only), "Sign in to lend or borrow" | `app/page.tsx`, `convex/tools.ts` → `listPublic` |
| List / edit / delete own tools; request a date range; approve / decline; mark returned | `components/`, `convex/tools.ts`, `convex/loans.ts` |
| All tools with availability, filter by category; My listings, My requests, Incoming requests | `components/Browse.tsx`, `components/Views.tsx` |
| Roles `admin` / `user`, enforced in Convex functions | `convex/lib/auth.ts`, every mutation/query; tests in `tests/rbac.test.ts` |
| Admin: remove any listing, view all loans, mark Trusted Lender | `Admin` tab, `loans.all`, `tools.remove`, `users.setTrustedLender` |
| n8n workflow 1: request notification (Convex → n8n webhook) | `n8n/workflows/request-notification.json`, `convex/loans.ts` + `convex/automation.ts` |
| n8n workflow 2: daily overdue reminders (n8n → Convex HTTP, write-back) | `n8n/workflows/overdue-reminders.json`, `convex/http.ts` |
| HMAC-signed payloads both directions | `convex/lib/hmac.ts`, Code nodes in each workflow |
| Idempotent write-backs | `automation.recordReminder` (unique key per loan per day), outbox keys |
| Retries + error workflow, no silent failures | outbox with backoff; n8n `retryOnFail`; `error-handler.json` → admin "Automation health" |
| Bonus: automation activity per loan ("Reminder sent 2 days ago") | `Activity` component on every loan card |

---

## Architecture

```
 Browser (Next.js + Clerk)                Convex                                   n8n (Docker)
 ─────────────────────────                ──────                                   ────────────
 useQuery / useMutation  ── JWT ──▶  queries & mutations
                                     (requireUser / requireAdmin)
                                          │ status change
                                          ▼
                                     outbox row (same transaction)
                                          │ scheduler
                                          ▼
                                     automation.deliver ── signed POST ──▶ Webhook ▶ verify HMAC + dedupe
                                       retries 10s,1m,5m,30m              ▶ build message ▶ notify (mock) ▶ 200
                                       then "failed" (admin can retry)

                                     HTTP /n8n/overdue-loans ◀── signed POST ── Schedule 09:00 UTC
                                     HTTP /n8n/reminders     ◀── signed POST ── per loan: remind ▶ write back
                                     HTTP /n8n/workflow-errors ◀─ signed POST ─ Error workflow (any failure)
```

**Why an outbox.** The notification is queued in the same Convex transaction as the status change. If the mutation fails, nothing is sent; if it commits, the notification will be attempted. Delivery runs in an action with exponential backoff (5 attempts), and a permanently failed delivery is shown to admins with a Retry button, instead of disappearing.

**Data model** (`convex/schema.ts`): `users` (role, trustedLender), `tools` (soft-deleted with `removedAt` so loan history survives), `loans` (`requested → approved | declined | cancelled`, `approved → returned`), `outbox` (webhook deliveries), `automationEvents` (activity shown in the UI, unique per idempotency key).

---

## Security and data-minimization decisions

- **Authorization lives in the backend.** Every Convex function resolves the caller from the Clerk JWT (`requireUser` / `requireAdmin`); ownership is checked on the record itself (`tool.ownerId`, `loan.ownerId`, `loan.borrowerId`). The UI hides buttons, but hiding is not the control. `tests/rbac.test.ts` calls the functions directly as other users and expects them to fail.
- **Roles are never client-controlled.** New users are `user`. The first admin(s) come from the `ADMIN_EMAILS` deployment variable, and only when Clerk reports the email as verified; later changes go through an internal mutation (`npx convex run users:setRole`), which clients cannot call.
- **The public page gets name and category only**: no owner, no description, no loan data. Signed-in neighbors see a lender's first name and Trusted Lender badge, never an email address.
- **Webhooks are signed both ways** with HMAC-SHA256 over `timestamp.rawBody`. The receiver rejects missing or bad signatures and timestamps older than 5 minutes (replay protection), compares in constant time, and parses the body only after verification.
- **Payloads carry only what the recipient needs.** The notification webhook sends the recipient's name and email, the tool name, the dates and the status. The overdue endpoint returns the borrower's name and email, the tool name, the due date and days overdue. The error report sends the workflow name, the execution id and the message, never business data.
- **Secrets stay out of code and exports.** Convex reads `LENDLOOP_WEBHOOK_SECRET` and `N8N_REQUEST_WEBHOOK_URL` from deployment env vars. n8n reads the same secret and `CONVEX_SITE_URL` from its container environment (`.env`, git-ignored). The exported workflow JSON contains only `$env.*` expressions. n8n's own credentials are encrypted with `N8N_ENCRYPTION_KEY`.
- **Idempotency.** Each reminder is keyed `reminder:<loanId>:<date>`, so an n8n retry updates the same row, a late "failed" never overwrites a "sent", and a reminded loan is not returned again the same day. Outbox rows are keyed `<loanId>:<event>`, and n8n also remembers recent `eventId`s, so a delivery retried after a lost response does not notify twice.
- **Input validation.** Lengths, enums and ISO dates are validated server-side; borrowing your own tool, overlapping approved loans and loans longer than 30 days are refused.
- **Headers.** `X-Frame-Options: DENY`, `nosniff`, and a strict referrer policy; `/app` is gated by Clerk in `proxy.ts`, and every Convex function authorizes again anyway.

---

## Local setup

Prerequisites: Node 20+, Docker, a Clerk account and a Convex account (both have free tiers).

```bash
npm install
```

### 1. Clerk
1. Create an application in Clerk and copy the keys into `.env.local` (see `.env.example`).
2. Enable the **Convex** integration in the Clerk dashboard (or create a JWT template named `convex`) and copy its issuer URL (Frontend API URL).

### 2. Convex
```bash
npx convex dev            # first run: log in, create the project; writes NEXT_PUBLIC_CONVEX_URL to .env.local
npx convex env set CLERK_JWT_ISSUER_DOMAIN https://<your-slug>.clerk.accounts.dev
npx convex env set ADMIN_EMAILS you@example.com
npx convex env set LENDLOOP_WEBHOOK_SECRET "$(openssl rand -hex 32)"
npx convex env set N8N_REQUEST_WEBHOOK_URL https://<public-n8n-url>/webhook/lendloop-request
```
`npx convex dev` keeps running, pushes functions and regenerates `convex/_generated`.

### 3. n8n
Create `.env` next to `docker-compose.yml`:
```
N8N_ENCRYPTION_KEY=<openssl rand -hex 32>
LENDLOOP_WEBHOOK_SECRET=<same value as in Convex>
CONVEX_SITE_URL=https://<your-deployment>.convex.site
N8N_PUBLIC_URL=https://<your-tunnel>/      # optional, for webhooks from Convex cloud
```
```bash
docker compose up -d
npm run n8n:import        # imports the three workflows (stops n8n briefly: SQLite is single-writer)
```
Open http://localhost:5678, create the owner account, then **activate** "Request notification" and "Overdue reminders" (the error handler is linked from their settings and doesn't need activating). Convex cloud has to reach the webhook: expose port 5678 with a tunnel (`ngrok http 5678`) and use that URL in `N8N_REQUEST_WEBHOOK_URL`.

On Windows Git Bash, prefix docker commands with `MSYS_NO_PATHCONV=1` so `/workflows` isn't rewritten into a Windows path.

### 4. Run
```bash
npm run dev               # http://localhost:3000
```

### Tests
```bash
npm test                  # 14 tests: role checks, signatures, replay/staleness, idempotency, outbox retries
npm run typecheck
```
The tests run the real Convex functions in memory with `convex-test`; no deployment needed.

### Trying the automations
- Request a tool as one user, then look at the n8n execution log: the "Send notification (mock)" node prints the message, and the loan card shows "Notification sent just now".
- For reminders, approve a loan, then in the Convex dashboard set its `endDate` to a past date and run "Overdue reminders" manually in n8n. The borrower's card shows "Overdue" and "Reminder sent just now"; run it again and nothing is sent twice.
- Stop n8n and request a tool: the delivery retries, then shows under Admin → Automation health with a Retry button.

---

## Environment variables

| Name | Where | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_CONVEX_URL` | `.env.local` | Convex client URL |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` | `.env.local` | Clerk |
| `CLERK_JWT_ISSUER_DOMAIN` | Convex env | validates Clerk JWTs |
| `ADMIN_EMAILS` | Convex env | verified emails that start as admin |
| `LENDLOOP_WEBHOOK_SECRET` | Convex env **and** n8n `.env` | HMAC shared secret |
| `N8N_REQUEST_WEBHOOK_URL` | Convex env | n8n webhook for request notifications |
| `CONVEX_SITE_URL` | n8n `.env` | base URL of the Convex HTTP actions |
| `N8N_ENCRYPTION_KEY` | n8n `.env` | encrypts n8n credentials at rest |

---

## What I would change for production

- **Real delivery channel.** Replace the mock nodes with Send Email (SMTP or a provider such as Postmark/SES) using an n8n credential; add per-user notification preferences and an unsubscribe link.
- **Secret rotation.** Accept two secrets during rotation (`current`, `previous`) and add a key id header; rotate on a schedule.
- **n8n hardening.** Run with Postgres instead of SQLite, queue mode with workers, the official task runners in their own container, TLS behind a reverse proxy, basic auth/SSO on the editor, and IP allow-listing for the webhook path. Store the dedupe set in a real store (Redis/Postgres) instead of workflow static data.
- **Observability.** Alerts on failed outbox rows and on error-workflow reports (Sentry or Datadog); structured logs with the loan id and execution id as correlation ids; a dashboard for delivery latency.
- **Scale.** Paginate lists (Convex `paginate`), denormalize availability onto `tools` instead of computing it per request, and add rate limits on requests per user.
- **Auditability.** An append-only audit log of admin actions (removals, Trusted Lender changes, role changes) with who, what and when.
- **Time zones.** Store the user's time zone and send reminders in local morning hours; today everything is UTC.
- **Clerk webhooks.** Sync user deletions and email changes from Clerk (svix-verified webhook) so data is removed when a user deletes their account.
- **E2E tests.** Playwright runs against a preview deployment, plus a contract test that replays the exported n8n workflows against a test Convex deployment in CI.

---

## Notes

- `convex/_generated` is committed so the project typechecks before your first `npx convex dev`. That command regenerates it.
- Built with an AI-assisted workflow (Claude Code), as the brief allows.
