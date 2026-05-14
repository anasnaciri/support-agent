# Support Agent — Working Checklist

The single source of truth for **what's done**, **what's next**, and **what invariants must hold** in this repo. Architectural detail lives in [`master-plan.md`](./master-plan.md); this file is the running checklist on top of it.

**The agent reads this at the start of every session and updates it at the end of every session.** See [`AGENT.md`](./AGENT.md) for the working agreement.

---

## Current status

- **Phase 0 — Foundations:** partial (thin scaffold only — workspace compiles, no infra wired yet)
- **Phase 1 — Runtime spine:** not started
- **Phase 2+:** not started
- **Last checked:** 2026-05-14 — rechecked after Vitest setup started. `pnpm build` green across all 9 projects; `pnpm test` green with `packages/agent-core/test/ids.test.ts` (3 tests). Next: finish remaining Phase 0 foundation setup before Phase 1.

---

## Always-true invariants (never let these regress)

These come from master-plan §16, §20, and the "never moves earlier" list (lines 2635–2642). If you can't tick all of these, do not mark a session complete.

- [x] `agent-core` has zero imports from `services` / `tools` / `db` / `providers` (dependency rule, §16)
- [ ] `PermissionService` is consulted before every tool execution (§9). Until it exists, no tool may execute autonomously.
- [ ] Audit log writes share the transaction with case state changes (outbox pattern, §4)
- [ ] Case state machine guards every status transition (§10) — no raw `UPDATE cases SET status = …`
- [ ] Effect Service / Layer separation: Tags are abstract in `services`; Live impls live in `db` / `providers` / feature packages
- [x] `pnpm build` is green
- [x] `pnpm test` is green
- [ ] No `any`; `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` satisfied
- [ ] No secrets in git (`.env*` is gitignored except `.env.example`)

---

## Build / verify gates

Run these before declaring any task done:

- [x] `pnpm install` clean
- [x] `pnpm build` green across all 9 projects
- [x] `pnpm test` green
- [ ] CI runs install + build + test on PR (GitHub Actions not yet configured)

---

## Phase 0 — Foundations

**Goal:** empty platform that compiles and tests.

Done:
- [x] pnpm workspace (`pnpm-workspace.yaml`) + root `package.json`
- [x] `tsconfig.base.json` with strict mode, ESM, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, composite refs
- [x] Packages scaffolded: `agent-core`, `services`, `providers`, `tools`, `agents`, `db`, `plugins/sdk`
- [x] Apps scaffolded: `api`, `worker` (dashboard deferred to Phase 3)
- [x] `effect@3.x` installed in every workspace that needs it
- [x] Stack picks recorded in memory: Drizzle, pg-boss, Vercel AI SDK + OpenRouter, Resend
- [x] `.gitignore` + `.nvmrc`
- [x] `AGENT.md` (working agreement) + `CLAUDE.md` (symlink to AGENT.md) + `todo.md` (this file)
- [x] `git init` + initial commits (`7934265`, `b42ea2c`)
- [x] Root Vitest config + scripts (`vitest.config.ts`, `pnpm test`, `pnpm test:watch`) with initial `agent-core` ID tests

Pending (deferred from the thin-scaffold first pass):
- [x] `@effect/schema` set up — satisfied implicitly: in Effect 3.10+ the `Schema` namespace is exported from the main `effect` package (we verified `effect@3.21.2` exposes `Schema`, `Duration`, `Schedule`, `Effect`, `Data`). No separate `@effect/schema` install needed.
- [x] Drizzle installed in `packages/db` + migration runner wired (`drizzle-kit generate` + `drizzle-kit migrate`). Phase 1 minimum schema: `tenants`, `cases`, `case_state_transitions`, `audit_log`, `approvals` with all check constraints, FKs, and indexes from §11. Migration `0000_fixed_nocturne.sql` applied to docker Postgres; integration test (7/7 incl. round-trip + CHECK rejection) green. `customers` / `users` FKs deferred (kept as nullable UUIDs without FK) until those tables land.
- [ ] pg-boss installed in `apps/worker` + first connection test
- [ ] OpenTelemetry wiring with a local Tempo or Jaeger
- [ ] Auth scaffold: HMAC verification middleware for webhooks (OIDC for dashboard later)
- [x] Core types in `agent-core` from §17: 10 module files (`ids`, `payloads`, `case`, `agent`, `tool`, `approval`, `workflow`, `llm`, `event`, `errors`) re-exported via `index.ts`. All 9 branded IDs, full domain model, `Data.TaggedError` classes + union types. Pure types only — no Service Tags yet.
- [ ] Empty Live + Test Layer scaffolds for every Service Tag in §6
- [ ] Add smoke tests for the remaining packages/apps (`services`, `providers`, `tools`, `agents`, `db`, `plugins/sdk`, `api`, `worker`)
- [ ] CI workflow (GitHub Actions): install + build + test on PR
- [x] `.env.example` documenting required env vars (DB, OpenRouter, Resend, Google OAuth + Pub/Sub, Shopify, webhook HMAC, OTel)
- [x] `docker-compose.dev.yml` for local Postgres 16 (single `postgres` service with healthcheck and named volume)

---

## Phase 1 — Runtime spine

**Goal:** a workflow can move a case through states.

- [ ] `CaseRepository` Tag + `CaseRepositoryLive` (Postgres/Drizzle) + `CaseRepositoryTest` (in-memory)
- [ ] `AuditLogService` Tag + Live
- [ ] `EventBus` Tag + Live (pg-boss-backed)
- [ ] `WorkflowQueue` Tag + Live
- [ ] `AgentRegistry` — loads TS configs from `packages/agents`
- [ ] `ToolRegistry` + `defineTool` helper (§8)
- [ ] `PermissionService` Tag + Live (static rules first; conditional rules in Phase 4)
- [ ] `ApprovalService` Tag + Live (create, resolve, expire)
- [ ] `AgentRuntime.handleEvent` — the tick loop from §5 / §18
- [ ] Trivial tools: `case.update_status`, `case.update_context`
- [ ] Trivial agent: `support-triage` (classifies and updates context only)
- [ ] End-to-end test: synthetic `ticket.created` event → case row → audit entries → `resolved`

---

## Phase 2 — First real integration

**Goal:** the agent can answer "where is my order?"

- [ ] `LLMService` Tag + Live wrapping Vercel AI SDK + OpenRouter (see memory `llm-abstraction`)
- [ ] `ShopifyService` Live: `getCustomer`, `getOrder`, `getFulfillment`, `searchByEmail`
- [ ] `MailboxService` Tag (the tenant's connected mailbox) with `GmailMailboxLive` — covers both reading inbound and sending threaded replies through the same OAuth credential. Microsoft Graph Live deferred to a later phase.
- [ ] `PlatformMailService` Tag + Live (Resend) — for platform-originated mail only (manager invites, approval-link emails, billing). Never used for customer replies.
- [ ] Google OAuth flow for tenants to connect their Gmail mailbox; refresh-token storage per tenant (encrypted at rest)
- [ ] OAuth scope: `https://www.googleapis.com/auth/gmail.modify` (read + send + thread modify, no delete)
- [ ] Gmail watch + Pub/Sub topic + push-notification webhook to receive new-message events
- [ ] Webhook handler: Gmail push → fetch message via API → normalize → `email.received` domain event
- [ ] Outbound send via `users.messages.send` with `threadId` set so replies land in the original thread and the merchant's Sent folder
- [ ] Tools: `shopify.get_customer`, `shopify.get_order`, `tracking.lookup`, `email.reply` (tenant mailbox, in-thread), `email.ask_customer` (tenant mailbox)
- [ ] Agents: `support-triage`, `order-status-agent`
- [ ] Manual happy path: send a real email, watch a case resolve

---

## Phase 3 — Dashboard

**Goal:** a manager can see and act on cases.

- [ ] `apps/dashboard` — Next.js (deferred during Phase 0 scaffold)
- [ ] Auth (OIDC)
- [ ] Today view, case list, case detail with timeline
- [ ] Approval list + detail with Approve / Edit & Approve / Reject / Take Over
- [ ] SSE for live case-detail updates
- [ ] Command endpoints wired (`/approvals/:id/approve`, etc.)

---

## Phase 4 — Safety & policy

- [ ] Conditional permission rules (e.g. `refund.create` amount thresholds)
- [ ] Per-tenant policy overrides via dashboard
- [ ] Slack approval channel (interactive buttons)
- [ ] Signed email approval links
- [ ] PII redaction in audit log and OTel traces
- [ ] Cost tracking per case / agent / tenant
- [ ] Hard turn budget enforced; `max_turns_exceeded → human_takeover` path tested

---

## Phase 5 — More categories

- [ ] Agents: `missing-package-agent`, `damaged-product-agent`, `refund-review-agent`
- [ ] Tools: `supplier.add_sheet_row` (Google Sheets plugin), `refund.recommend`, `refund.create`
- [ ] Evidence upload (object storage), photo handling
- [ ] `TimerService` Tag + Live; `timer.expired` event
- [ ] Replay/test mode for agents against historical cases
- [ ] Second inbound provider: Microsoft Graph (Outlook / M365) — OAuth flow, subscription webhooks, normalization into the same `email.received` event

---

## Phase 6 — Provider abstraction in production

Most of this is absorbed by the Vercel AI SDK + OpenRouter choice (see memory `llm-abstraction`). Remaining work:

- [ ] Per-tenant model routing config (tenant picks a model string; LLMService passes through)
- [ ] Fallback chains (`Effect.orElse` between two `generateModel(...)` calls)
- [ ] Cost dashboard per model / provider

---

## Phase 7 — Plugin SDK & first plugin

- [ ] `definePlugin` SDK in `packages/plugins/sdk` + loader
- [ ] Slack plugin (richer than just approvals)
- [ ] ShipStation or one supplier-specific plugin as a proof
- [ ] Plugin Settings UI in dashboard

---

## Phase 8 — Hardening

- [ ] Load testing (10k cases/day per tenant)
- [ ] Chaos testing (provider down, DB failover, queue lag)
- [ ] SOC 2 audit-trail polish
- [ ] Incident playbooks
- [ ] On-call runbook
- [ ] Tenant onboarding checklist + setup wizard

---

## Working agreement (for the agent)

1. **Start every session by reading this file.** It tells you where things stand.
2. **Verify before ticking.** Don't check a box unless you ran the command (`pnpm build`, a test, a grep) that proves it.
3. **Update at end of session.** Tick what you did, add boxes for what you discovered, move items between phases if order changed.
4. **Record divergences.** If you deviate from `master-plan.md` (e.g. picked a different library, changed a contract), note it here and save a memory.
5. **Don't end with a broken build.** If `pnpm build` fails, fix it before stopping.
