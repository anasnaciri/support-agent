# Codebase audit — 2026-06-10

Full five-area audit (API security, connectors/providers, runtime/worker logic, dashboard/admin UX+security, DB layer). Each item is a finding to fix; check it off only after verifying with a test or command. Findings are grouped by severity, with a suggested fix order at the bottom.

---

## Critical — money and silent customer-facing failure

- [ ] **C1. Transient LLM errors permanently drop the event; case sticks forever.**
  `packages/services/src/agent-runtime.ts:1190-1198` `catchAllCause` converts every error (OpenRouter 503, network blip, malformed tool call) into `{type:"Failed", retryable:false}`, and `apps/worker/src/index.ts:71-83` treats that as job *success*. The `retryLimit: 5` in `apps/worker/src/workflow-queue-live.ts:49` is dead code — nothing ever throws.
  **Fix:** let retryable errors fail the job so pg-boss retries with backoff; transition to `human_takeover` on exhaustion via a dead-letter consumer. At minimum honor the existing `retryable` field in the worker.

- [ ] **C2. Approval resume is not idempotent — retry can double-execute a refund or customer email.**
  `agent-runtime.ts:442-525` never checks approval status / case status and records no execution marker; pg-boss is at-least-once (crash or >900s job expiry → re-run). The dedup the code *claims* exists, doesn't:
  - `refund.create` description (`packages/tools/src/shopify/refund.ts:39,59-67`) claims `(caseId, callId)` execution-tying — no such mechanism anywhere (`Tool.idempotencyKey` at `packages/agent-core/src/tool.ts:82` has zero consumers; `shopify-service-live.ts:854-967` ignores the key it's passed).
  - `conversation.reply` description claims draftId send-dedup — none of the three connectors implement it (`packages/providers/src/gmail-conversation-live.ts:218-279` sends unconditionally; same for Graph and IMAP/SMTP).
  **Fix:** persist an executed-marker keyed by `(caseId, callId)` in the tool's tx, short-circuit on it; implement real draftId dedup in connectors; fix the lying tool descriptions immediately even before the mechanisms.

- [ ] **C3. Duplicate webhook deliveries run full duplicate agent ticks.**
  Pub/Sub and Graph are at-least-once; `apps/api/src/gmail-webhook.ts:337` delegates dedup downstream, but downstream (`agent-runtime.ts:393-414`) only correlates by threadId and runs another complete tick. With replies on auto, each duplicate = a fresh LLM call with a fresh draftId → second reply to the customer. The Gmail cursor-expiry reseed (`gmail-webhook.ts:443-470`) can replay **50 historical messages**.
  **Fix:** processed-message dedup — unique index on `(tenantId, provider, messageId)` consulted at the top of the tick.

---

## Security — high

- [ ] **S1. SSRF guard defeated by DNS rebinding.**
  `packages/providers/src/url-fetch-live.ts:150-152` validates the hostname via `dns.lookup`, then calls `fetch` which does its own unpinned DNS resolution — attacker DNS answers public-IP for the check, `169.254.169.254` for the fetch. Reachable by any authenticated merchant via `POST /dashboard/knowledge` / resync → cloud-metadata credentials.
  **Fix:** pin — connect to the validated literal IP (custom undici Agent with pinned `lookup`) preserving the original `Host` header; same per redirect hop.

- [ ] **S2. Approval/reject email links mutate state on GET — email scanners can decide approvals.**
  `apps/api/src/server.ts:4390-4404` + `apps/api/src/approval-endpoints.ts:87-146`: Outlook SafeLinks / Mimecast / Gmail prefetch follow links → silently approve a refund before the manager opens the email (manager then sees "already decided").
  **Fix:** GET renders a confirmation page with a same-token POST form; only the POST mutates.

- [ ] **S3. Approval tokens: 7-day bearer, no recipient binding, action not in the HMAC.**
  `packages/services/src/approval-tokens.ts:46-56` (TTL), `agent-runtime.ts:1074-1082` (approve/reject share one token; the action is path-only — edit the path on a reject link and you can approve).
  **Fix:** shorten TTL substantially; bind the action into the signed body; consider recipient binding.

- [ ] **S4. Graph webhook fails open and refreshes the OAuth token before auth.**
  `apps/api/src/graph-webhook.ts:219-227`: `clientState` is the only auth on `/webhooks/conversations/outlook/:tenantId` and the check is **skipped entirely** when `MICROSOFT_GRAPH_WEBHOOK_SECRET` is unset (optional config). Even when set, the handler resolves + refreshes the tenant's token (rotating the refresh token) at `graph-webhook.ts:152-217` *before* validating `clientState` — unauthenticated refresh-churn/DoS against any guessable tenant id; no rate limiting.
  **Fix:** fail closed when unset; validate `clientState` before any token work; per-subscription clientState bound to the path tenant; verify notification `subscriptionId` against the tenant's recorded subscription.

- [ ] **S5. Reflected XSS on the public `/installed` page.**
  `apps/api/src/server.ts:3006-3048`: `?shop=` only length-checked, never escaped, interpolated into HTML; base64 `host` param breaks out of an href attribute despite the `admin.shopify.com/` prefix check. Unauthenticated.
  **Fix:** entity-escape both; validate `shop` with `isValidShopDomain`; add CSP on HTML routes.

## Security — medium

- [ ] **S6. Secrets in URL query strings land in request logs (no pino redaction).**
  Logger config `server.ts:4119-4134` has no `redact`; Fastify logs `req.url` per request. Leaks: the global long-lived Gmail push token (`/webhooks/conversations/gmail?token=`), 7-day approval tokens, 10-min install grants.
  **Fix:** pino `redact` / log route path only; move the Gmail push token to an `Authorization` header (and prefer per-tenant tokens).

- [ ] **S7. IMAP/SMTP TLS downgradeable — app password capturable by MITM.**
  `apps/api/src/imap-connect.ts:48-66`, `packages/providers/src/imap-smtp.ts:148-181,248-264`: `secure:false` default for port 587 = *opportunistic* STARTTLS, no `requireTLS`, no `tls.minVersion`, `secure:false` settable with no floor.
  **Fix:** `requireTLS: true` on nodemailer + equivalent enforcement on imapflow; refuse insecure configs; set `tls.minVersion`.

- [ ] **S8. Gmail MIME builder allows CRLF header injection from LLM-supplied addresses.**
  `packages/providers/src/gmail-http.ts:600-614`: `to[].email` untouched, `name` only quote-stripped, interpolated into headers. Prompt-injected email could induce `"x@y.com\r\nBcc: …"`. (IMAP path safe via nodemailer validation; `In-Reply-To`/`References` normalized — Gmail-specific.)
  **Fix:** reject/strip CR/LF in `email` and `name`; validate against an address pattern.

- [ ] **S9. Reply recipient is unconstrained LLM output (prompt-injection exfiltration).**
  `packages/tools/src/conversation/reply.ts:61-83` (+ `ask-customer.ts`): nothing constrains `to` to thread participants; the only barrier is `conversation.reply` defaulting to `ask`. Matters the moment a tenant flips replies to auto.
  **Fix:** server-side constrain `to` to the fetched thread's participants (explicit per-tenant allow for off-thread recipients).

- [ ] **S10. Admin app: brute-forceable shared password, non-revocable sessions.**
  `apps/admin/app/login/actions.ts:8-15` — no throttle/lockout; `apps/admin/lib/session-crypto.ts:22-26` `constantTimeEqual` early-returns on length mismatch (leaks length); `session-crypto.ts:29-54` signs only `{iat}` → 8h non-revocable bearer; password rotation doesn't invalidate sessions (key is `ADMIN_SESSION_SECRET`).
  **Fix:** attempt counter with backoff (or document mandatory IP allowlist / Cloudflare Access); hash both sides before compare; include a key-version/nonce; document "rotate ADMIN_SESSION_SECRET to force logout."

- [ ] **S11. No rate limiting or security headers anywhere on the API.**
  `server.ts:4124-4163`: no `@fastify/rate-limit` (OAuth callbacks, all webhook families, approval links, bearer-guarded routes unthrottled), no `@fastify/helmet` (HTML routes ship without CSP / nosniff — compounds S5). Leave CORS closed (safe by default here).

- [ ] **S12. Internal error causes echoed in 500 responses.**
  e.g. `server.ts:670-671, 1124-1128, 2295-2298, 3556-3559, 3793-3796` return `detail: String(exit.cause)` — Effect Cause stringification can surface stacks/SQL/table names.
  **Fix:** log server-side; return an opaque error id.

- [ ] **S13. `GET /sign-out` is a state-changing GET (drive-by logout).**
  `apps/dashboard/app/sign-out/route.ts:5` and `apps/admin/app/logout/route.ts`. **Fix:** POST via form/server action.

## Security — accepted-risk items to track consciously

- [ ] **S14. Single shared `DASHBOARD_API_TOKEN` + self-asserted `x-org-id` is the whole tenant boundary.** `apps/api/src/dashboard-auth.ts:40-62` — leak = full cross-tenant compromise + forgeable actor attribution. Code comments note the forwarded-WorkOS-JWT upgrade; prioritize it.
- [ ] **S15. One global `CREDENTIAL_ENCRYPTION_KEY`, no key-version byte in ciphertext** (`packages/services/src/crypto.ts:35-71`) — rotation requires full re-encryption with no dual-key window. Prefix a key-version byte + support a decrypt-key set.
- [ ] **S16. Install grants are not single-use** (`apps/api/src/install-grant.ts:38`) — acceptable at 10-min TTL, but add a nonce + one-time store if grants ever appear in logs (see S6).

---

## Logic / runtime — high

- [ ] **L1. The case state machine doesn't exist (master-plan §10 unimplemented).**
  `packages/db/src/case-repository-live.ts:172-242` accepts any from→to; no runtime caller passes `expectedFromStatus`. Concrete race: manager takes over mid-tick → the `final_message` branch (`agent-runtime.ts:862-885`) checks stale in-memory status and flips `human_takeover` → `resolved`. Also `case.update_status` (`packages/tools/src/case/update-status.ts`, defaultPermission `allow`) lets the LLM set any status while its description claims state-machine compliance.
  **Fix:** allowed-transition map inside `transitionStatus` (terminal states exit only via explicit resume paths); runtime passes `expectedFromStatus` and treats conflict as re-read-and-re-park.

- [ ] **L2. Per-case serialization split across two queue keys.**
  `packages/services/src/workflow-queue.ts:58-79`: `message.received` keys `thread:{tenant}:{threadId}`; approvals/timers/resume key `case:{caseId}` → `key_strict_fifo` doesn't serialize them for the same case. Race: customer replies at the moment the manager approves → approval tick executes + resolves while the message tick falls through guard 2.9 (no pending row, by design, `agent-runtime.ts:684-705`) and runs a full loop → double reply.
  **Fix:** resolve threadId → caseId at enqueue and key everything by case, or per-case advisory lock in the runtime.

- [ ] **L3. No transactional outbox (master-plan §4 unimplemented) — events can be lost forever.**
  - Timers: `packages/db/src/timer-service-live.ts:91-122` marks `firedAt` and commits; `apps/worker/src/timer-sweep-schedule.ts:57-73` enqueues afterwards; crash/enqueue-failure between = case sleeps forever (sweep's `catchAllCause` at :100 swallows).
  - Approvals: decided-but-publish-failed (`apps/api/src/approval-endpoints.ts:134-144`) leaves the case parked in `waiting_for_approval` with no pending row — approved tool never executes, nothing surfaces it.
  **Fix:** real outbox (event row in the same tx; relay publishes + marks delivered), or at minimum mark `firedAt` only after successful enqueue (duplicate fire is safe under case-key FIFO; lost fire is not).

- [ ] **L4. Several `HumanTakeoverRequired` paths change nothing — invisible stuck cases.**
  `max_turns_exceeded` (`agent-runtime.ts:1186-1189`), `wait_for_customer`/`escalate_supplier` (:899-911), and **approved-tool-failed** (:495-504) return a result the worker only logs (`apps/worker/src/index.ts:74-83`).
  **Fix:** every such path transitions the case to `human_takeover` (in tx, with audit) before returning — as the BYOK-credential path already does (:792-828).

- [ ] **L5. Connectors go dark silently on refresh/renewal failure — no alerting.**
  `apps/worker/src/graph-subscription-renewal.ts:112-118,140-148`, `gmail-watch-renewal-schedule.ts:101-108`, `imap-poll.ts:112-118`: revoked/missing refresh token → `console.warn` only. Outlook is a hard outage: subscription lapses (~3 days), Graph stops delivering, no replayable cursor → inbound customer mail dropped indefinitely, nobody notified. (Gmail self-heals — cursor not advanced on failure.)
  **Fix:** repeated failure outcomes → operational alert (Resend platform email / metric) + connector-health flag shown to the merchant.

## Logic / runtime — medium

- [ ] **L6. The `ask` path isn't atomic; park transition has no audit row.**
  `agent-runtime.ts:1052-1067`: `approvals.create` and `transitionStatus(waiting_for_approval)` are two separate txs (crash between = pending approval on an un-parked case → agent keeps acting, second approval) and no companion audit row (§4 near-miss). Contrast `packages/db/src/dashboard-writes.ts:61-121` which does it correctly.
  **Fix:** one `tx.run` for create + park + audit.

- [ ] **L7. Approval expiry is written but never enforced — `expired` status unreachable.**
  `agent-runtime.ts:1061` stamps +24h; no sweep flips `pending → expired`; `applyApprovalDecision` (`packages/services/src/approval-decision.ts`) never checks `expiresAt`; dashboard flow has no TTL at all. A manager can approve a months-stale `refund.create`.
  **Fix:** check `expiresAt` in `applyApprovalDecision` + the resume branch; add an expiry sweep (the `approvals_pending_idx` already includes it) that rejects + escalates.

- [ ] **L8. Approval-resume skips PermissionService and executes stale/unvalidated input.**
  `agent-runtime.ts:442-494`: deliberate bypass, but days-later execution ignores policy changes (tenant flipped to `always_deny`, scope revoked). Dashboard-edited `approvedInput` (`apps/api/src/server.ts:719-728` → stored as JSONB → executed at `agent-runtime.ts:472-476`) is never validated against `tool.inputSchema` — the only unvalidated entry into `execute`.
  **Fix:** re-run scope precheck + schema decode at execution time; treat `always_deny` as a post-approval kill-switch.

- [ ] **L9. Refund threshold has no aggregation — N small refunds bypass the cap.**
  `packages/services/src/permission-service-live.ts:88-129` evaluates each `refund.create` in isolation; three $40 refunds auto-pass a $50 askAbove (over denyAbove in total).
  **Fix:** sum prior successful `refund.create` amounts for the case/order into the compared amount.

- [ ] **L10. No tool-input runtime validation.**
  `agent-runtime.ts:1118-1121` passes `decision.input` straight to `execute`; `llm-service-live.ts:195` wraps schemas with `jsonSchema()` without a validate fn; `defineTool` is identity (`define-tool.ts:20`).
  **Fix:** `Schema.decodeUnknown(tool.inputSchema)` before the permission check; on failure push a structured `invalid_input` tool-result so the model self-corrects.

- [ ] **L11. Poison job blocks its case/thread FIFO key for up to 7 days; no dead-letter queue.**
  `key_strict_fifo` keeps `failed` rows in the partial unique index until deletion (default `deleteAfterSeconds` 604800); `workflow-queue-live.ts:44-60` configures no `deadLetter`.
  **Fix:** configure `deadLetter` on `workflow.events` + alert on it; shorten failed-row retention.

- [ ] **L12. Worker rebuilds the full layer graph (incl. a fresh PG pool) per job.**
  `apps/worker/src/index.ts:65-69` provides `runtimeLayer` inside the handler; `DbClientLive` is `Layer.scoped` → new pool per job/cron pass. Connection churn turns pool exhaustion into the C1 dropped-event path.
  **Fix:** `ManagedRuntime`/`Layer.launch` once at boot, reuse across jobs.

## Logic / runtime — low

- [ ] **L13. `decision.type === "handoff"` path skips the handoff allowlist** (`agent-runtime.ts:888-897` vs the checked pseudo-tool path :955-985); latent (LLM layer never emits it today) and an un-audited `cases.update` outside any tx.
- [ ] **L14. Only the first of parallel LLM tool calls is honored** — `llm-service-live.ts:410` takes `toolCalls[0]`, rest silently dropped (no tool-result, no audit). Declare single-tool choice to the provider or handle the array.
- [ ] **L15. `tool.timeout` / `tool.retrySchedule` declared but never consumed** (`packages/agent-core/src/tool.ts:83-84`) — a hung connector call holds the tick *and its DB tx* (`agent-runtime.ts:1122`); job can pass `expireInSeconds` → concurrent re-delivery (feeds C2).
- [ ] **L16. Prod with no conversation connector env silently falls back to `ConversationServiceTest`** (`apps/api/src/bootstrap.ts:397-406`) — replies "succeed" in-memory, case resolves, customer gets nothing. Hard-fail in prod like the LLM-key check at :213-217.
- [ ] **L17. Tool-set `human_takeover` clobbered by final_message auto-resolve** — known/accepted; same root cause as L1 (no matrix forbids `resolved` over it).

---

## Data layer

- [ ] **D1. (HIGH) No active-mailbox uniqueness for gmail/outlook/imap → nondeterministic cross-tenant routing.**
  `packages/db/src/schema.ts:247` partial unique covers only `provider='shopify'`; two tenants can hold active rows for the same mailbox. `apps/api/src/gmail-webhook.ts:164-188` selects with `.limit(1)` and **no orderBy** → which tenant receives the customer's email (full PII) is plan-dependent.
  **Fix:** partial unique index `(provider, shop_domain) WHERE provider IN ('gmail','outlook','imap') AND status='active'` + deterministic orderBy backstop.

- [ ] **D2. (HIGH) Cases have no provider/connector stamp; router resolves per tenant, not per thread.**
  `schema.ts:70` bare `threadId`; `packages/providers/src/conversation-router-live.ts:45-66` picks "most recently installed active connector" tenant-wide → connecting Outlook silently breaks every open Gmail case (fetch/reply dispatched to Graph with a Gmail threadId → `ThreadNotFound`; approved replies fail post-approval). Also theoretical cross-provider threadId collision in `findByThreadId` (`case-repository-live.ts:127-143`).
  **Fix:** stamp provider/connection-id on the case at create (known in the `message.received` path), route on it, include it in the thread lookup key.

- [ ] **D3. (HIGH) `patchMetadata`'s SELECT FOR UPDATE is a no-op for every current caller.**
  `packages/db/src/connector-credential-store-live.ts:302-365`: `useDb` only yields a tx inside `withTransaction`; no caller wraps (`gmail-webhook.ts:493-505` historyId advance, `apps/worker/src/imap-poll.ts:148-162` UID cursor, graph metadata). Concurrent pushes interleave read-merge-write → regressed historyId / lost keys → duplicate ticks or a stalled cursor.
  **Fix:** open the transaction inside `patchMetadata` itself, as `transitionStatus` already does.

- [ ] **D4. No index/unique on `cases(tenant_id, thread_id)` — hottest lookup seq-scans.**
  `findByThreadId` runs per inbound email (`agent-runtime.ts:399`); `schema.ts:86-105` has no covering index. Uniqueness rests solely on queue FIFO (the Gmail unread backfill at `gmail-webhook.ts:286-322` already runs alongside push handling).
  **Fix:** partial unique index `(tenant_id, thread_id) WHERE thread_id IS NOT NULL`.

- [ ] **D5. Missing indexes on other hot paths.**
  `audit_log` has only `(case_id, id)` — `auditList` (`dashboard-reads.ts:534-561`) and `usageRows` (:707-728) seq-scan the fastest-growing table; add `(tenant_id, id DESC)` and/or `(tenant_id, action, occurred_at)`. `approvals.case_id` unindexed (`caseDetail`, takeover's pending-cancel scan).

- [ ] **D6. Tool side effects (external HTTP) execute inside the SQL transaction.**
  `agent-runtime.ts:477-494` and :1118-1143: `tx.run` wraps the Gmail/Graph/Shopify network call with the audit insert — pool connection (max 10) held across provider latency, and a commit failure *after* the email sent erases the audit record of an email that did go out.
  **Fix:** execute tool → then one tx for audit + state change (§4 requires audit-with-state, not effect-in-tx).

- [ ] **D7. PII in pg-boss payloads survives tenant deletion (GDPR / shop-redact gap).**
  `message.received` carries full email bodies (`workflow-queue-live.ts:34-39,119-124`) into `pgboss.job`/archive; `redactShop` (`apps/api/src/compliance-redaction.ts:202-262`) never touches the pgboss schema. (Account-cleanup already encrypts its own payload — the asymmetry is the gap.)
  **Fix:** delete from `pgboss.job`/archive `WHERE data->'event'->>'tenantId' = $1` in/after the wipe.

- [ ] **D8. Account deletion never revokes Outlook grants.**
  `apps/api/src/account-deletion.ts:43,51-53` `REVOCABLE_GRANT_PROVIDERS` lacks `outlook` (mirrored in `apps/worker/src/account-cleanup.ts:31-37`); Microsoft refresh token stays valid ~90 days post-deletion.
  **Fix:** add outlook revocation; note IMAP passwords (nothing to revoke) in the deletion email/runbook.

- [ ] **D9. Bare-id repo methods (defense-in-depth).** `CaseRepository.getById/update/transitionStatus`, `ApprovalService.getById/approve/reject`, `AuditLogService.forCase`, `TimerService.schedule/cancelOpenForCase` take no tenantId. No exploitable caller today (all traced), but one future user-controlled `caseId` into `CaseRepository.update` is a cross-tenant write. Require `tenantId` in the Tag signatures.

- [ ] **D10. `tenantAgentOverrides.clearModel`/`clearSystemPrompt` race** (`tenant-agent-overrides-live.ts:89-113`): UPDATE + conditional DELETE are two autocommit statements and the DELETE predicate omits the just-cleared column — a concurrent `setModel` can get its row deleted. One tx + include the column.

- [ ] **D11. Smaller items:** `markConnected` two-step shop transfer not in a tx (`shopify-app-provisioning-live.ts:150-179`, recoverable); `todaySummary` uses server-local midnight not tenant TZ (`dashboard-reads.ts:167-168`); pool sizing implicit (~40 potential connections api+worker, fine today, size explicitly before raising work concurrency); BYOK second-active-provider insert surfaces as raw `ConnectorStoreDbError`; unvalidated JSONB casts (`cases.context`, connector `metadata`, `toolPermissions`) vs the exemplary `tenants.settings` decoder; retention sweep skips `failed`/`human_takeover` cases (documented) and pg-boss archives (see D7).

- [ ] **D12. `caseEvents` inner query missing redundant tenant filter** (`packages/db/src/dashboard-reads.ts:405-416`) — not exploitable (caseId pre-verified), but every sibling query double-scopes; add for consistency.

---

## UX

### High

- [ ] **U1. Session expiry destroys work and kills polling silently.**
  `apps/dashboard/lib/session.ts:82-87` never uses the sealed `refreshToken`; WorkOS access-token TTL can be ~5 min. A manager loses a 10-minute approval-reply edit to a `redirect("/sign-up?returnTo=…")` on submit; pollers degrade to silent 401s (`CaseLiveBoundary.tsx:34-36` amber dot forever; `CasesSidebar.tsx:71-72`).
  **Fix:** implement refresh via the sealed refreshToken (re-seal + Set-Cookie in a route handler/action); have pollers detect 401 → hard-navigate to sign-in; verify the WorkOS TTL configured for this env.

- [ ] **U2. Destructive one-click actions with zero confirmation.**
  Disconnect connector (`settings/integrations/page.tsx:204-210` — kills the production mailbox), delete knowledge doc (`settings/knowledge/page.tsx:109-114` — 8px from "Edit"), reject approval (`ApprovalCard.tsx:264-270` — escalates to takeover). The branded `AlertDialog` exists and is used exactly once (PermissionToggle) — reuse it for these three.

- [ ] **U3. No pending/disabled state on most server-action forms.**
  Bare `<form action>` + static buttons: Approve/Reject (`ApprovalCard.tsx:229,251,267`; `approvals/[id]/page.tsx:123-145`), Take over / Hand back (`cases/[id]/page.tsx:436-458`), **IMAP "Verify & connect"** (`connect/imap/page.tsx:212` — 10–30s live check, no spinner), knowledge save, refund-policy save, LLM connect, all admin forms. Double-submits everywhere.
  **Fix:** shared `SubmitButton` using `useFormStatus`.

- [ ] **U4. Form input loss on validation failure (PRG, no state).**
  `connect/imap/actions.ts:26-50` — a failed connectivity check wipes all eight fields including the app password; `settings/knowledge/actions.ts:53-57` — failed URL fetch discards a large pasted document. Onboarding/sign-up already use `useActionState` correctly — apply the pattern to IMAP + knowledge.

### Medium

- [ ] **U5. Outlook/IMAP disconnect shows no banner.** Actions redirect with `?outlook=disconnected` / `?imap=disconnected` (`settings/integrations/actions.ts:30-38`) but the page only reads shopify/gmail/sheets/connected params (`integrations/page.tsx:46-63`). Generalize to one `?disconnected=<provider>` param.
- [ ] **U6. OAuth denial/cancel is a dead end.** Only success params render (`integrations/page.tsx:129-133`); cancel Google consent → back on the page, connector "missing", zero explanation. Agree an `?error=<provider>:<code>` contract with the api callback + render a warning Alert.
- [ ] **U7. No `loading.tsx` in either app.** Case detail blocks on `caseDetail` + a live Shopify call (`cases/[id]/page.tsx:325-328`) before painting. Add route-level loading for `/cases/[id]`, `/approvals`, `/settings/*` (Skeleton component already exists).
- [ ] **U8. Case-switcher sidebar goes stale after actions.** `CasesSidebar.tsx` is client state; `router.refresh()`/`revalidatePath` re-render server components only — the case you just took over keeps its old badge. Refetch page 1 on pathname change or subscribe to the poll.
- [ ] **U9. Prod error boundary is useless + dead redirect.** `app/error.tsx:18-37` branches on `error.name === "NoTenantAccess"` / renders `error.message` — Next.js redacts both in production (digest boilerplate; the `/no-access` redirect can never fire). The class is dead code anyway (`api-client.ts:75-87`). Drop it; give the boundary actionable copy + retry.
- [ ] **U10. Refund-policy save can silently zero stored thresholds.** `refund-policy/actions.ts:48-61` coalesces unparseable thresholds to `?? 0` in non-threshold modes — a stale tab overwrites saved thresholds with 0/0 and the UI says "saved". Omit the fields on parse failure instead.
- [ ] **U11. Live-updates failure state is invisible.** `CaseLiveBoundary.tsx:60-89` — permanent amber dot, aria-only explanation. After N consecutive failures show "Updates paused — reload".

### Low

- [ ] **U12. Approval receipt pages dead-end** (`approval-endpoints.ts:157-204`) — good states (approved/rejected/already-decided/expired) but no link into the dashboard case (the code comment says these become redirects — the dashboard exists now), and "ask to re-send" has no re-send mechanism.
- [ ] **U13. MultiSelect keyboard support** (`components/ui/multi-select.tsx`): no Escape-to-close, no arrow nav, mousedown-outside-only close.
- [ ] **U14. "Couldn't load cases" has no Retry button** (`CasesSidebar.tsx`); watch `text-[10px]` badge legibility (`CasesSidebar.tsx:224`).
- [ ] **U15. Next.js deprecation: the `middleware` file convention is deprecated — rename to `proxy`.**
  Build warns `⚠ The "middleware" file convention is deprecated. Please use "proxy" instead.` Affects `apps/dashboard/middleware.ts` (the pathname-passthrough that stamps `x-pathname` for `returnTo` — not auth). Rename the file to `proxy.ts` and the export from `middleware` to `proxy` per the Next.js 16 convention; verify the OpenNext/Cloudflare build still picks it up.

---

## Verified solid (no action — keep it this way)

- Server-side tenant resolution everywhere: no client-supplied tenant/org ids on any surface; install grants close the `?tenant=` hole; dashboard reads/writes consistently tenant-scoped with disclosure-safe 404s.
- All HMAC/token comparisons constant-time with length guards; expiry checked after signature (no timing oracle); webhook raw-body handling correct (removeAllContentTypeParsers + `*` buffer parser).
- Shopify OAuth hardened: per-tenant secret resolution, signed tenant-bound state, provisioned-shop match prevents re-binding.
- AES-256-GCM at rest for every token / IMAP password / Shopify client secret; random IV per call; tamper → typed `DecryptError`; nothing token-like in plaintext columns; tokens never logged (expiry only).
- Tenant resolution by receiving mailbox, never the `From` header — forged From can't cross tenants.
- The 23557d8 revoked-row-shadows-active class fixed consistently across every lookup (`status='active'` filters + active-first ordering).
- No `dangerouslySetInnerHTML` anywhere; customer email renders as escaped text; open-redirect hygiene at all five entry points, with tests.
- Approval decision layer: `SELECT … FOR UPDATE` + CAS, lost race → honest `already_decided` on both surfaces; frozen `approvedInput` snapshot executes (never re-derived).
- `transitionStatus`, `takeOverCase`/`resumeCase`, `redactShop` are model transactional implementations; `withTransaction` distinguishes rollback from commit failure correctly.
- `key_strict_fifo` real in pg-boss 12.18.2; cron singletons can't double-fire across replicas; Microsoft rotated refresh token persisted on every refresh; migrations strictly additive, all timestamps `timestamptz`.
- Dashboard: no `withAuth({ensureSignedIn:true})` regressions; CSRF safe by construction (server actions); no secrets in client bundles; legalAcceptedAt flow sound; typed-name delete confirmations re-checked server-side; contrast ≥ AA; race-aware "already decided" banners.

---

## Suggested fix order

1. **C1 → C2 → C3** — the retry/idempotency trio (silent stuck cases, double refunds, duplicate replies).
2. **S2 + S3 + S6** — approval GET mutation + token hardening + log redaction (one journey: a scanner or log reader approving refunds).
3. **S4, S1** — Graph fail-closed; SSRF IP pinning.
4. **D1, D2, D3** — mailbox uniqueness, provider stamp on cases, patchMetadata tx (multi-connector tenants are exactly what this branch ships).
5. **L1, L3** — implement the transition matrix and outbox the master plan already promises (L2, L4–L8 follow naturally).
6. **U1 + U3/U4, then U2** — session refresh + form pending/state preservation; confirmations on destructive actions.
