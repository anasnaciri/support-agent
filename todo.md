# Support Agent — Working Checklist

The single source of truth for **what's done**, **what's next**, and **what invariants must hold** in this repo. Architectural detail lives in [`master-plan.md`](./master-plan.md); this file is the running checklist on top of it.

**The agent reads this at the start of every session and updates it at the end of every session.** See [`AGENT.md`](./AGENT.md) for the working agreement.

---

## Current status

- **Phase 0 — Foundations:** ✅ done (2 items explicitly deferred to Phase 1 with reasoning recorded below)
- **Phase 1 — Runtime spine:** partial
- **Phase 2+:** not started
- **Last checked:** 2026-05-15 — Phase 2 progressing: `ShopifyService` Tag + Live (GraphQL Admin) + Test layer shipped with 4 methods (`getOrder`, `getCustomer`, `searchByEmail`, `getFulfillment`), `ShopifyCredentialStore` Tag with env-stub Live impl, `shopify.get_order` tool. Full Postgres-backed CI: 114 passed, 3 skipped. Next: DB-backed multi-tenant credential store, `shopify.get_customer` / `tracking.lookup` tools, then Gmail OAuth + Mailbox stack.

---

## Always-true invariants (never let these regress)

These come from master-plan §16, §20, and the "never moves earlier" list (lines 2635–2642). If you can't tick all of these, do not mark a session complete.

- [x] `agent-core` has zero imports from `services` / `tools` / `db` / `providers` (dependency rule, §16)
- [x] `PermissionService` is consulted before every tool execution (§9) in `AgentRuntime.handleEvent`; direct tool tests still invoke tools intentionally at the unit boundary.
- [x] Audit log writes share the transaction with case state changes (master-plan §4). Mechanism: `CurrentTxRef` FiberRef in `packages/db/src/db-client.ts` + `withTransaction(eff)` helper. The Live `CaseRepository`/`AuditLogService`/`ApprovalService` impls consult `CurrentTxRef` per call: if set, use the active Drizzle tx; otherwise use the bare client. `TransactionRunner` Tag in services with `TransactionRunnerLive` (real tx) and `TransactionRunnerPassthrough` (test layers). `AgentRuntime.handleEvent` composes the load/create + `event.received` audit pair AND each tool execution + `tool.invoked` audit pair AND the `final_message` transition + `case.resolved` audit pair inside `tx.run(...)`. The wider master-plan §4 spec (full tick atomic, including LLM-decision audits) is intentionally NOT applied — that would hold a SQL tx open during LLM responses. Tests: 3 unit-ish + 1 end-to-end via Live `AgentRuntime`. Rollback verified.
- [x] Case state machine guards every status transition (§10) — enforced by typing: `CaseRepository.update`'s patch type omits `status`, so the only path that mutates status is `transitionStatus`, which writes the `case_state_transitions` row in the same SQL transaction. No raw `UPDATE cases SET status = …` is reachable through the Tag.
- [ ] Effect Service / Layer separation: Tags are abstract in `services`; Live impls live in `db` / `providers` / feature packages
- [x] `pnpm build` is green
- [x] `pnpm test` is green
- [x] No `any`; `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` satisfied
- [x] No secrets in git (`.env*` is gitignored except `.env.example`)

---

## Build / verify gates

Run these before declaring any task done:

- [x] `pnpm install` clean
- [x] `pnpm build` green across all 9 workspace projects
- [x] `pnpm test` green
- [x] CI runs install + build + test on PR

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
- [x] pg-boss installed in `apps/worker` + first connection test. `makeQueue({ databaseUrl, schema })` opens a connection, runs migrations into the configured schema, returns a started `PgBoss` instance. Worker entrypoint declares a `worker.heartbeat` queue and registers a handler. Integration test (uses a separate `pgboss_test` schema) sends and consumes a job — 1 test passing.
- [x] OpenTelemetry wiring — `startOtel({ serviceName, otlpEndpoint })` in `packages/services` wires `NodeSDK` + auto-instrumentations + `OTLPTraceExporter`. No-op when `OTEL_EXPORTER_OTLP_ENDPOINT` is unset, so tests and local runs aren't affected. Local Tempo/Jaeger setup deferred until we have something worth tracing.
- [x] Auth scaffold: HMAC verifier in `packages/services/src/hmac.ts` — `computeHmac`, `verifyWebhookSignature` (sha256/sha512), `verifySignedRequest` (timestamp-bound, replay-resistant with default 5-min tolerance), all using `crypto.timingSafeEqual`. 10 unit tests covering happy path + body tamper + wrong secret + malformed sig + replay window. Middleware integration in `apps/api` lands with the first webhook route (Phase 2). OIDC for dashboard deferred to Phase 3.
- [x] Core types in `agent-core` from §17: 10 module files (`ids`, `payloads`, `case`, `agent`, `tool`, `approval`, `workflow`, `llm`, `event`, `errors`) re-exported via `index.ts`. All 9 branded IDs, full domain model, `Data.TaggedError` classes + union types. Pure types only — no Service Tags yet.
- [~] Empty Live + Test Layer scaffolds for every Service Tag in §6 — **deferred to Phase 1**. Empty Tags rot before they're filled. Each Service Tag will be defined fully (interface + Test layer + Live layer skeleton) the moment Phase 1 needs it, starting with `CaseRepository` and `AuditLogService`.
- [~] Smoke tests for the other packages — **deferred**. `expect(true).toBe(true)` per empty package is noise that breaks when real exports land. Tests follow real code: `agent-core` (types), `db` (schema), `worker` (queue), and `services` (OTel + HMAC) all have tests because they have non-trivial code.
- [x] CI workflow (GitHub Actions): `.github/workflows/ci.yml` runs install + build + test on push to main and every PR. Spins up Postgres 16 as a service so integration tests have a real DB. Migrations applied before tests. `pnpm install --frozen-lockfile`, pnpm 9, node 20.
- [x] `.env.example` documenting required env vars (DB, OpenRouter, Resend, Google OAuth + Pub/Sub, Shopify, webhook HMAC, OTel)
- [x] `docker-compose.dev.yml` for local Postgres 16 (single `postgres` service with healthcheck and named volume)

---

## Phase 1 — Runtime spine

**Goal:** a workflow can move a case through states.

Current next slice: run Postgres-backed integration tests, then close the audit-in-same-transaction invariant.

- [x] `CaseRepository` Tag + `CaseRepositoryLive` (Postgres/Drizzle) + `CaseRepositoryTest` (in-memory). Interface: `create`, `getById`, `findByThreadId`, `update`, `transitionStatus`. Status changes flow only through `transitionStatus`, which writes a `case_state_transitions` row in the same SQL transaction and supports optimistic `expectedFromStatus` checks (→ `CaseStateConflict`). `update`'s patch type excludes `status` at compile time so callers cannot bypass the transition path. Errors: `CaseNotFound`, `CaseStateConflict`, `CaseRepositoryDbError`. Tests: 6 unit (Test layer) + 3 integration (Live + Postgres).
- [x] `AuditLogService` Tag + `AuditLogServiceLive` + `AuditLogServiceTest`. Interface: `record(entry)` returns the persisted row with assigned id + occurredAt, `forCase(caseId, { limit, afterId })` returns ordered entries with cursor-style pagination. Errors: `AuditLogDbError`. Tests: 4 unit + 2 integration. **Note:** the cross-service audit-in-transaction invariant is still pending — it'll be enforced when `AgentRuntime.handleEvent` composes `CaseRepository.transitionStatus` and `AuditLogService.record` inside a single `db.transaction(...)` boundary.
- [x] `EventBus` Tag + Live (pg-boss-backed). Abstract Tag in `packages/services/src/event-bus.ts`; `EventBusFromWorkflowQueue` publishes to `WorkflowQueue`; pg-boss Live in `apps/worker/src/event-bus-live.ts`; unit test covers delegation and Postgres-gated integration test covers publish → consume through pg-boss.
- [x] `WorkflowQueue` Tag + Live. Abstract Tag + in-memory FIFO Test layer in `packages/services/src/workflow-queue.ts`; pg-boss Live in `apps/worker/src/workflow-queue-live.ts` creates a `key_strict_fifo` queue, uses per-event singleton keys (`case:*`, `thread:*`, `order:*`, or `event:*`), revives Date payload fields on consume, and exposes consumer shutdown. Tests: 2 unit + 1 Postgres-gated integration.
- [x] `AgentRegistry` Tag in `agent-core` + `AgentRegistryDefault` (Ref-backed) + `AgentRegistryWith(configs)` (pre-registered). Methods: `register`, `resolve`, `tryResolve`, `all`. Errors: `AgentAlreadyRegistered`, `UnknownAgent`. First real config: `support-triage` in `packages/agents/src/support-triage.ts` — OpenRouter `anthropic/claude-3.5-sonnet`, prompt declares 5 categories (`where_is_order`, `missing_package`, `damaged_product`, `refund_request`, `general_inquiry`), tools limited to the Phase 1 trivial set (`case.update_status`, `case.update_context`). 7 + 3 unit tests; defensive assertion locks the tool list until intentionally widened.
- [x] `ToolRegistry` + `defineTool` helper (§8). `defineTool` is a typed-identity helper that preserves `Tool<I, O>` inference. `ToolRegistry` Tag in `agent-core` with default `ToolRegistryDefault` layer (Ref-backed in-memory map) and `ToolRegistryWith(tools)` for pre-registered layers. Methods: `register`, `get`, `tryGet`, `schemasFor` (uses `effect`'s `JSONSchema.make` to derive LLM-facing JSON Schemas from Effect Schemas), `all`. Errors: `ToolAlreadyRegistered`, `UnknownTool`. 10 unit tests.
- [x] `PermissionService` Tag in `agent-core` + `PermissionServiceDefault` layer. Pure function: `check({ tenantId, agent, tool, payload }) → "allow" | "ask" | "deny"`. Decision order is `agent.permissionOverrides[tool.name] ?? tool.defaultPermission`. Tenant-level policy rules and conditional rules (e.g. amount thresholds) are deferred to Phase 4 — the Tag interface stays stable; the Default layer will swap for a Live layer that also consults `PolicyService`. 6 unit tests.
- [x] `ApprovalService` Tag + `ApprovalServiceLive` (Drizzle) + `ApprovalServiceTest`. Interface: `create` (always starts in `pending`), `getById`, `approve` (optionally with `approvedInput` for edit-and-approve), `reject` (with `decisionReason`), `listPending(tenantId)`. State transitions use optimistic concurrency: `approve`/`reject` only succeed if the row is `pending`; double-decision returns `ApprovalStateConflict`. Live impl runs the SELECT-FOR-UPDATE + UPDATE in one tx. Errors: `ApprovalNotFound`, `ApprovalStateConflict`, `ApprovalServiceDbError`. 7 unit + 3 integration tests. Expiry sweep (`timer.expired` driven) is deferred — the `expiresAt` column is written on create, but nothing reads it yet.
- [x] `AgentRuntime.handleEvent` — Phase 1 tick loop from §5 / §18. Supports create/load case for `ticket.created` and case-scoped resume events, resolves agent + tools, calls scripted `LLMService`, audits event/LLM/tool steps, checks `PermissionService` before tool execution, creates approvals for `ask`, executes `allow` tools, handles handoff, final message, and `max_turns_exceeded`. Phase 1 limitations: `email.received` lookup-by-thread and `tracking.changed` lookup-by-order return `Failed`; customer/supplier wait actions return human takeover until those workflows land.
- [x] Trivial tools: `case.update_status`, `case.update_context`. Both defined via `defineTool` in `packages/tools/src/case/`. They depend on `CaseRepository` (provided by the runtime's Layer). `case.update_status` wraps `transitionStatus` (carrying through `expectedFromStatus` + `reason`); `case.update_context` reads + shallow-merges named hint fields (`classification`, `identifiedOrderId`, `identifiedCustomerId`, `notes`) plus an `extra: Record<string, unknown>` escape hatch. Repository errors are mapped to `ToolOutputInvalid` with `issues: [<TaggedErrorName>]` at the tool boundary so the LLM gets a structured failure. 7 unit tests (transition happy path, optimistic conflict mapped to ToolOutputInvalid, schema decode, context merge, extra-keys merge, case-not-found, ToolRegistry schemasFor integration).
- [x] Trivial agent: `support-triage` config + scripted runtime test classifies context and updates status using only `case.update_context` / `case.update_status`.
- [x] End-to-end test: scripted synthetic event path in `apps/worker/test/agent-runtime.e2e.test.ts` covers `ticket.created` / `customer.replied` → case → audit entries → `resolved`.

---

## Phase 2 — First real integration

**Goal:** the agent can answer "where is my order?"

- [x] `LLMService` Tag landed early in Phase 1 (`packages/services/src/llm-service.ts`) so `AgentRuntime` can be developed and tested deterministically against a scripted layer. `LLMServiceScripted(decisions[])` pops one decision per call. `LLMServiceFromFn((req, {callIndex}) => ...)` for branching test logic. 4 unit tests.
- [x] `LLMServiceLive` (Vercel AI SDK + OpenRouter) in `packages/providers/src/llm-service-live.ts`. Maps `ToolCallingRequest` → AI SDK `generateText` in single-step mode (the runtime drives the tool-call loop itself). Translates our `ChatMessage` union onto `ModelMessage[]`, wraps each tool's JSON Schema with `jsonSchema()` so the SDK doesn't try to introspect them as Zod, and reads `result.toolCalls[0]` (→ `tool_call`) or `result.text` (→ `final_message`). Error mapping: `statusCode === 429 || ≥500` → `ProviderUnavailable`; "context length" / "maximum context" → `ContextTooLarge`; "safety" / "content policy" / "blocked by" → `SafetyBlocked`; "invalid tool" / "tool_use" → `InvalidToolCall`; everything else → `NetworkError`. Config Tag `LLMConfig` in `packages/services` (interface only); `LLMConfigFromEnv` factory in providers reads `OPENROUTER_API_KEY` (+ optional `OPENROUTER_BASE_URL` / `OPENROUTER_SITE_URL` / `OPENROUTER_SITE_NAME`) and fails the Layer build if the key is missing. 8 unit tests using `vi.mock("ai")` + `vi.mock("@openrouter/ai-sdk-provider")` to assert request mapping + decision mapping + error mapping without any real network call.
- [ ] Wire `LLMServiceLive` + `AgentRuntimeDefault` + all Live repos + `EventBusPgBossLive` into the worker entrypoint so a real `email.received` / `ticket.created` event drives a case through resolution. (Currently the worker is the Phase-0 heartbeat scaffold; the AgentRuntime consumer wiring is its own task — needs Postgres + OpenRouter + permission service all live at once and a real event source, which is Gmail OAuth.)
- [x] `ShopifyService` Tag + `ShopifyServiceLive` (GraphQL Admin) + `ShopifyServiceTest`. Methods: `getOrder`, `getCustomer`, `searchByEmail`, `getFulfillment`. Live impl: `fetch` against `/admin/api/${apiVersion}/graphql.json` (single-call per method, full field set returned). Error mapping: 401/403 → `ShopifyAuthFailed`, 429 → `ShopifyRateLimited`, 5xx + GraphQL `errors[]` → `NetworkError`, null `data.order` / null `data.customer` → `OrderNotFound` / `CustomerNotFound`. GID coercion: plain ids auto-wrapped as `gid://shopify/{Order|Customer}/${id}`. Status enum coercion: lowercases Shopify's UPPER_SNAKE display statuses and accepts known values only (falls back to null for unknown). Domain types in `agent-core/src/shopify.ts` (intentionally narrow — not the full Admin schema). Credential store: `ShopifyCredentialStore` Tag in services with `ShopifyCredentialStoreStatic(map)` + `ShopifyCredentialStoreAny(creds)` for tests; `ShopifyCredentialStoreFromEnv` in providers reads `SHOPIFY_TEST_SHOP_DOMAIN` + `SHOPIFY_TEST_ACCESS_TOKEN` (+ optional `SHOPIFY_API_VERSION`, defaults `2025-01`). DB-backed multi-tenant store deferred to a later slice. HTTP indirection via `ShopifyHttp` Tag (`ShopifyHttpLive` wraps `fetch`; `ShopifyHttpFromFn` lets tests pin responses without `vi.stubGlobal`). 11 provider unit tests (all 4 methods + 4 error branches) + 3 tool tests.
- [ ] Shopify API access review prep: keep MVP scopes to `read_orders` + `read_customers`; treat `read_all_orders` as optional and only request it if we need orders older than Shopify's default 60-day window. If requested, document the support-use justification and remember it must be approved by Shopify and used alongside `read_orders`.
- [ ] Shopify protected customer data minimization: before review, reduce GraphQL fields to the minimum needed for the first support workflow. Start with protected fields `Email` and `Name`; add `Phone` / `Address` only when a concrete feature requires them and the protected-customer-data request covers them.
- [ ] Shopify protected customer data readiness: write the privacy policy / data protection details covering purpose, fields collected, retention, subprocessors, storage region, access/deletion process, and evidence for encryption in transit/at rest, encrypted backups, dev/prod separation, staff access controls + MFA, access logs, and incident response.
- [ ] Shopify mandatory compliance webhooks for App Store distribution: configure and implement `customers/data_request`, `customers/redact`, and `shop/redact` with HMAC verification, 200-series ACKs, and a workflow to fulfill data access/redaction within Shopify's required window.
- [ ] `MailboxService` Tag (the tenant's connected mailbox) with `GmailMailboxLive` — covers both reading inbound and sending threaded replies through the same OAuth credential. Microsoft Graph Live deferred to a later phase.
- [ ] `PlatformMailService` Tag + Live (Resend) — for platform-originated mail only (manager invites, approval-link emails, billing). Never used for customer replies.
- [ ] Google OAuth flow for tenants to connect their Gmail mailbox; refresh-token storage per tenant (encrypted at rest)
- [ ] OAuth scope: `https://www.googleapis.com/auth/gmail.modify` (read + send + thread modify, no delete)
- [ ] Gmail watch + Pub/Sub topic + push-notification webhook to receive new-message events
- [ ] Webhook handler: Gmail push → fetch message via API → normalize → `email.received` domain event
- [ ] Outbound send via `users.messages.send` with `threadId` set so replies land in the original thread and the merchant's Sent folder
- [x] Tool: `shopify.get_order` (`packages/tools/src/shopify/get-order.ts`). Wraps `ShopifyService.getOrder`; flattens the response onto a tool-output shape that's smaller than the full domain type (line items minus variant title, fulfillments with the tracking sub-object). Maps any `ShopifyError` (`OrderNotFound`, `ShopifyAuthFailed`, `ShopifyAuthMissing`, `ShopifyRateLimited`, `NetworkError`, `CustomerNotFound`) to `ToolOutputInvalid` with `issues: [<tag>]` at the tool boundary so the LLM sees structured failures. Risk: read; defaultPermission: allow; sideEffectClass: none.
- [ ] Tools: `shopify.get_customer`, `tracking.lookup`, `email.reply` (tenant mailbox, in-thread), `email.ask_customer` (tenant mailbox)
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
