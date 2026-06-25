# Support Agent — Working Checklist

The single source of truth for **what's done**, **what's next**, and **what invariants must hold** in this repo. Architectural detail lives in [`master-plan.md`](./master-plan.md); this file is the running checklist on top of it.

**The agent reads this at the start of every session and updates it at the end of every session.** See [`AGENT.md`](./AGENT.md) for the working agreement.

---

## Current status

- **Phase 0 — Foundations:** ✅ done (2 items explicitly deferred to Phase 1 with reasoning recorded below)
- **Phase 1 — Runtime spine:** partial
- **Phase 2+:** not started

---

DONE: draft-email feature on cases/:id — **all 4 slices LANDED 2026-06-22** (composer that drafts +
sends a customer reply while in human_takeover, "Rephrase with AI", a workspace-configurable rephrase
model, and a minimalistic model dropdown atop the composer). See the session entries below. Still
**unverified live** end-to-end (needs a tenant LLM credential + a taken-over case).

NEXT (the "Later" item): skip emails from these domains — a settings page for domains to skip so the
agent doesn't lose tokens on newsletters etc.; the agent can suggest skipping by adding
`suggest ignore domain: true` to the case context, which the owner approves on the case page.
Later: skip emails from these domains, add a settings page for domains to skip, so the agent dont lose tokens on newsletter emails etc.. and make the agent able to suggest skipping, on the context it adds a suggest ignore domain : true, so on the case page the owner can approve skipping this domain

Architecture follow-up discussed 2026-06-25:
- [ ] Evaluate a supervisor/reporting subagent pattern for read-only research and bounded specialist
      analysis, without moving final side-effect decisions out of the runtime permission/audit/state
      machine. Candidate shape: `agent.delegate` creates an audited bounded subtask; the child returns a
      structured report with evidence/tool-call refs; the supervising agent decides the next customer or
      money action. Avoid a broad rewrite from the current handoff model until tested on one narrow flow
      such as order-status data gathering or refund eligibility analysis.

### DIAGNOSED, not yet built — automated/marketing email gets a drafted (and human-approved!) reply

Production incident (case `ba2880a0-2b3a-4db4-8e93-f1085b9c9a1e`, 2026-06-24): an automated Shopify
marketing email from `email@email.shopify.com` ("give it another try") was **misread by triage as a real
customer question**, handed off to general-inquiry, which **drafted a `conversation.reply` — a human then
approved it and it SENT** to the no-reply address. Only the *later* bounce messages got correctly
classified "Out of scope: Automated delivery status notification" and resolved without replying.

Root cause: there is **no deterministic filter for automated/bulk/no-reply/bounce mail** — the entire
defense is two cheap-model (gemini-3.5-flash) scope judgments (triage + general-inquiry's out-of-scope path)
plus a human approval, and all three failed on this message. General-inquiry's spam/offer decline is a
prompt judgment, NOT a guarantee (`general-inquiry-agent.ts:51-54,88`). No `Auto-Submitted` / `Precedence`
/ `no-reply` / DSN handling exists anywhere; headers ARE available at the Gmail webhook
(`gmail-http.ts` `payload.headers[]`) but are dropped before `InboundMessage` (`agent-core/src/payloads.ts`);
Outlook/IMAP don't retain them.

Proposed fix (deterministic, two layers — design recorded, user said diagnose-only for now):
1. **Pre-triage skip** before any LLM runs: detect automated mail (sender patterns `no-reply@`/`noreply@`/
   `mailer-daemon@`/`postmaster@`/`bounce@`/`*.email.shopify.com` — connector-agnostic since `from.email`
   is on every message — plus RFC headers `Auto-Submitted: auto-*`, `Precedence: bulk`, `List-Unsubscribe`,
   `multipart/report` DSN where the connector has them). Create the case but DON'T run the agent (no tokens,
   no reply, marked so the merchant still sees it). Natural choke point: `agent-runtime.ts` ~170 (covers all
   connectors) and/or the Gmail webhook (earliest, no case at all).
2. **Hard reply-recipient guard** at the send/approval-execute layer: NEVER send a customer reply to a
   no-reply/automated/bounce address, even if an agent drafted it and a human approved it. This is the
   belt-and-suspenders that would have stopped this exact case.

Related to (and partly subsumes) the merchant skip-domains NEXT item above — but this layer is automatic
(email standards), not manual per-domain.

Current lifecycle refactor backlog from `/private/tmp/support-agent-handoff-20260623-lifecycle-refactors.md`
and a fresh `rg` audit on 2026-06-23:

## ✅ LANDED — Merchant-authored custom agents (2026-06-24, branch `feat/custom-agents`, NOT merged)

Merchants can build their own agents from `/settings/agents` — assign tools, set who-can-call-whom
(handoffs out + `callableFrom` in), write a name/description/system prompt, pick a model, and configure
per-tool ask/auto permissions. Shipped in 3 TDD phases (each `ci:local`-green; 2040 tests):

- **Phase A — data + runtime.** New `tenant_custom_agents` table (migration `0029`; whole AgentConfig per
  workspace, `custom:` id prefix, status CHECK, cascade). `CustomAgentService` (Tag in services, Live in db).
  Shared prompt scaffold (`buildCustomAgentPromptTemplate` in agents) wraps raw merchant instructions with
  safety/approval rules at resolve time. New **`AgentResolver`** seam (Tag in services, Live in agents):
  built-ins first, then the tenant's active customs. The runtime resolves all 4 agent-lookup sites through
  it; an initial-load miss now **fails safe to `human_takeover` (`agent_unresolvable`)** instead of an
  infinite pg-boss retry (latent bug fixed). v1 customs are always `mode:subagent` (triage stays the entry).
- **Phase B — dashboard CRUD.** `AgentDto.isCustom` + `CustomAgentView`/`CustomAgentWriteBody` contracts;
  `GET /dashboard/catalog` switched to **workspace scope** and unions customs. Pure
  `validateCustomAgentInput` (services) + `ASSIGNABLE_TOOLS` (tools, = ALL_TOOLS minus
  `agent.handoff`/`case.update_context`/`case.update_status`; **money tools assignable, gated**). Save-time
  scope check vs `connector_connections` (runtime PermissionService deny is the backstop). New
  `POST/GET /dashboard/custom-agents[/:id][/delete]` gated on existing RBAC `settings.agents`. Dashboard:
  New-agent button + custom badge, create/edit `AgentForm`, server actions.
- **Phase C — inbound routing.** `customSpecialists` on AgentResolver (loaded once per tick);
  `effectiveHandoffIds` = static handoffs ∪ customs whose `callableFrom` includes the caller, used for both
  handoff allow-checks AND a trusted `[Additional specialists …]` roster injected into `buildSystemPrompt`.
  Form gains a Routing card (reachable-from + when-to-use).

Invariants kept: PermissionService gates every custom-agent tool; turn budget shared across handoff; park
guards agent-agnostic; tenant isolation (resolver always passes tenantId); dependency rule holds (new edge
is `agents → services` Tags only — services never imports agents). **NOT verified live** (needs a tenant LLM
credential + a real triage→custom handoff). Follow-ups: a custom agent is only reachable from agents that
already hold `agent.handoff` (triage); name-uniqueness not enforced; `callableFrom` self-route not special-cased.

- [x] Move remaining `packages/services/src/agent-runtime.ts` case lifecycle write choreography into
      `CaseLifecycleWriter` without adding a generic arbitrary-transition method. Remaining production
      paths include runtime human escalations, approved-tool success/failure outcomes, approval rejection,
      resolved-case reopen, approval/customer/supplier parking, LLM credential/safety/context escalation,
      reply-delivery-failure parking, and final-message resolution.
- [x] Route approval expiry escalation in `apps/worker/src/approval-maintenance-schedule.ts` through
      `CaseLifecycleWriter`.
- [x] Route workflow dead-letter escalation in `apps/worker/src/workflow-dead-letter.ts` through
      `CaseLifecycleWriter`.
- [x] Decide whether `packages/tools/src/case/update-status.ts` remains a deliberately low-level
      agent tool over `CaseRepository.transitionStatus`, or gets a lifecycle-writer operation so every
      agent-initiated status change owns its audit shape at the service boundary. Decision: route it
      through `CaseLifecycleWriter.applyAgentStatusUpdate`, preserving the tool contract while keeping
      transition + `case.status_changed` audit ownership in the service boundary.
- [x] After the above, rerun
      `rg "transitionStatus\\(|case\\.taken_over|case\\.resumed|case\\.status_changed|case\\.resolved|case\\.escalated_to_human" packages apps -n`
      and confirm production hits are limited to `CaseLifecycleWriter` plus intentional low-level
      repository/tool/test/seed code.

## ✅ LANDED — "Issue refund" button for agent-recommended refunds (2026-06-24)

Closes a real gap found while diagnosing prod case `914baed3-…`: the refund-review agent took
PATH B (read-only `refund.recommend` + a drafted `conversation.reply`), the merchant approved the
reply — which **promised the customer a refund** ("I have submitted this refund request… you should
see the confirmation shortly") — but **no `refund.create` ever ran**, so no money moved and the
dashboard offered no button to issue it (a recommendation is purely informational: a badge on the
reply approval + a timeline item, no action). Operators' only path was Shopify admin.

New operator action: on a case whose latest `refund.recommend` carries a concrete amount and where no
refund has been issued, the case page shows an **"Issue refund"** card (visible regardless of case
status, incl. `resolved`). Clicking it (confirm dialog) issues the recommended refund via
`ShopifyService.refundOrder` (notifyCustomer: true, stable idempotency key over case+order+amount),
records a `case.refund_issued` audit row, and retires the button. Gated on the existing
**`refunds.issue`** RBAC permission (route-level; open-mode/owner pass via `decideAuthz`). Does NOT
change case status. TDD: pure DI core `apps/api/.../case-refund.ts` (`issueCaseRefund`, outcomes
`issued | invalid_amount | order_not_found | already_refunded | currency_mismatch | refund_failed`)
+ pure `issuableRefund`/`refundAlreadyIssued` helpers in `refund-recommendation.ts`; 13 new unit
tests; `tsc -b` + dashboard `tsc --noEmit` green; 330 dashboard/contracts + 20 api-unit tests green.
Files: `apps/api/.../case-refund.ts` (+test), `case-handlers.ts` (`handleDashboardIssueRefund`),
`routes.ts` (`POST /dashboard/cases/:id/refund`), `apps/dashboard/lib/api-client.ts` (`issueRefund`),
`app/cases/[id]/{actions.ts,page.tsx,refund-recommendation.ts}`, `lib/labels.ts`,
`packages/dashboard-contracts/.../rbac-permissions.ts` (broadened `refunds.issue` description).
**NOT committed.**

FOLLOW-UPS (deliberately out of scope — user scoped this to the button only):
- [ ] **Prompt fix (recurrence):** the PATH B reply over-promised — it claimed a refund was "submitted
      for approval" when PATH B submits nothing. Tighten `refund-review-agent` so PATH B replies only
      say "pending confirmation" (its own example already does), and/or prefer PATH A (`refund.create`,
      which creates a real approvable refund) when the customer clearly wants money back on a
      refundable order. The mid-zone $24.92 here WOULD have resolved to "ask" → a real approval+button.
- [ ] Manual remediation: issue Christine's ($24.92, order #3108) refund — promised in the sent reply,
      never issued. Once this ships, the new button does it; until deployed, do it in Shopify admin.
- [ ] Consider de-duping the Shopify refund-confirmation email vs. an approved reply that also mentions
      the refund (both can go out if the operator issues the refund AND approves a pending reply).
- [ ] Amount is fixed to the recommendation (no partial-amount editing in v1).

## ✅ LANDED — Order lookup by confirmation number (2026-06-23)

Customers often quote the Shopify **confirmation number** (random alphanumeric, e.g. `XPAV284CT`) from
their order-confirmation email instead of the `#1001` order name. `shopify.get_order` now resolves it:
the tool tries `findOrderByName` first and, on a miss, falls back to a new
`ShopifyService.findOrderByConfirmationNumber` (Shopify `orders(query: "confirmation_number:<code>")`,
code stripped to alphanumerics, `first: 1`). `confirmationNumber` is also added to `ShopifyOrder`
(`ORDER_FIELDS` selection + `mapOrder`) and surfaced on the tool output so the agent can quote it back.
Triage + order-status prompts updated to treat a confirmation code as an order identifier and pass it
through verbatim. The dashboard case panel (`resolveOrderForContext`) mirrors the same fallback so the
operator view resolves confirmation-only cases too. **Confirmation numbers are NOT unique** — a match is
never proof of identity; the existing order-email identity gate (`order_customer_mismatch`) still gates
disclosure. TDD; `pnpm build` green; tools/providers/api shopify suites green (90 tests in the 3 touched
files). Files: `agent-core/src/shopify.ts`, `services/src/shopify-service.ts` (+`ordersByConfirmationNumber`
test fixture), `providers/src/shopify-service-live.ts`, `tools/src/shopify/get-order.ts`,
`agents/src/{support-triage,order-status-agent}.ts`, `api .../dashboard/shopify-panels.ts`; 13 e2e order
fixtures got `confirmationNumber: null`. **NOT committed** (working tree holds unrelated lifecycle-refactor WIP).

## ✅ LANDED — Triage no longer silently resolves; single-order inference (2026-06-24)

Diagnosed from a real audit trail (case `e6206180-…`): `support-triage` classified an
order-requiring case, found **no order id**, emitted a bare `final_message`, and the runtime
**auto-resolved the case with nothing done** — no reply, no handoff. Root cause was structural, two
layers:

1. **Triage prompt fallback** told the agent to "respond with plain text only" when an order-requiring
   category had no `identifiedOrderId`. That plain text is a `final_message`, which the runtime resolves.
2. **Runtime** auto-resolves on *any* `final_message`, with no notion that a router must never be terminal.

Fix:

- **Triage always hands off** — removed the terminal plain-text branch; every order-requiring category
  routes to its specialist even without an order id (`packages/agents/src/support-triage.ts`).
- **Runtime guard (new invariant):** a routing agent (`handoffs.length > 0`, i.e. triage) that reaches
  `final_message` no longer resolves — it parks `human_takeover` via `escalateToHuman`
  (`reason: "router_final_message_no_handoff"`). Keyed on `handoffs`, NOT `mode` (a terminal
  `mode: "primary"` agent with no handoffs is a legitimate resolver). `agent-runtime.ts` final_message block.
- **Single-order inference (user ask: "if the customer has only one order, infer it; don't ask for the
  number"):** new `ShopifyService.findOrdersByEmail` (Live: `orders(query: "email:…", sortKey CREATED_AT,
  reverse)`) + new read-only tool `shopify.find_customer_order` (returns `single` w/ the order | `none` |
  `multiple`). The four order specialists share `ORDER_RESOLUTION_LINES`
  (`packages/agents/src/order-resolution.ts`): use `identifiedOrderId` if present, else look the customer
  up by email — exactly one order → use it silently; zero/many → `conversation.ask_customer`. Added
  `conversation.ask_customer` to refund-review + missing-package (they lacked it) and the new tool to all
  four; bumped their `maxTurnsPerTick`.
- `shopify.get_order` refactored to export `ShopifyOrderOutput` + `projectShopifyOrder` (shared projection).

TDD; `pnpm build` green. New/updated tests green (182 across touched areas): tool unit
(`tools/test/shopify.test.ts`, single/none/multiple + read-only surface), Live query
(`providers/test/shopify-service-live.test.ts`, `findOrdersByEmail`), agent config shapes, and two worker
e2e regressions — the silent-resolve repro (triage→`human_takeover`, not resolved) and the
no-order-id→single-order-inference flow (drafts a reply, parks for approval, never asks). The e2e file's
per-test `ToolRegistryWith([…])` subsets were switched to `ToolRegistryWith(ALL_TOOLS)` so a test no longer
breaks merely because an agent gained a tool. **NOT committed** (working tree holds the user's unrelated
lifecycle-refactor WIP in `case-lifecycle-writer.ts`, `agent-runtime.ts`, `approval-maintenance-schedule.ts`,
`workflow-dead-letter.ts`, `update-status.ts` + their tests). **Known follow-up:** the
no-order-id + zero/multiple-orders edge in damaged-product shares the single `ask_customer` budget with the
photo request — fine on the common single-order path; revisit if it bites.

### ✅ FOLLOW-UP FIX — bind the inferred order to the case (2026-06-25)

Prod case `e161d86e` (Elva Labs) exposed the gap the single-order patch left open: the agent *found* the
order via `shopify.find_customer_order` (single match on the sender's email), recommended a correct
`full_refund $24.92`, and parked for approval — but the **dashboard showed no order** and the **"Issue
refund" button had nothing to act on**. Root cause: `find_customer_order` returns the order to the LLM but
nothing wrote it back to `case.context.identifiedOrderId`, which is the ONLY field both the order panel and
the Issue-refund `loadOrder` resolve from (`resolveOrderForContext`). It was only ever stamped by triage's
`case.update_context` when the customer *quoted* an order number — which this customer didn't.

Fix (runtime, TDD): after a successful `shopify.get_order` OR `shopify.find_customer_order` (`status:
"single"`), the runtime stamps `identifiedOrderId` **only when absent** (triage's customer-quoted id still
wins, never overwritten). Value = new pure helper `orderContextRef(order)`: prefer the numeric order name
(`#5501`, resolves via `findOrderByName`, renders cleanly) else the GID (always resolves via `getOrder`,
avoids the non-numeric-name → confirmation-number misroute). Safe for the identity gate: `find_customer_order`
keys on the customer's own sender email so the order already belongs to them. `agent-runtime.ts` tool-result
block + `agent-runtime-helpers.ts`; `+5` unit (`order-identity.test.ts`) + e2e assertion folded into the
existing single-order-inference test. `pnpm build` green; full suite green (2084). **Committed `dc9bdfd`,
merged to `main`, and deployed to Fly prod 2026-06-25.** Note: only helps NEW cases — the case that
surfaced this (`e161d86e`) is already parked at `waiting_for_approval` with no `identifiedOrderId`; needs a
one-off backfill to show its order.

## ✅ LANDED — Delivery-issue refund handling (verify → return-for-refund | escalate) (2026-06-25)

Follow-on from the `e161d86e` diagnosis: a refund request that cites a DELIVERY problem (courier won't
deliver, never arrived) used to go to `refund-review` and just get a refund recommendation — no check of
whether the parcel was actually stuck, on its way, or never shipped. New policy (decided with the user):
verify the claim against the carrier, then branch.

- **Triage** (`support-triage.ts`): a refund/cancellation request whose REASON is a delivery problem now
  classifies as `missing_package` (the delivery specialist), NOT `refund_request`. `refund_request` is
  scoped to NON-delivery reasons. (+1 config test.)
- **Delivery specialist** — expanded `missing-package-agent` (AgentId kept for DB stability; display name →
  "Delivery Issues"; `tracking.lookup` added to its tools; `maxTurnsPerTick` 13→16). New BRANCH B with a
  VERIFY step:
  - **B1 real problem** (tracking `status: exception` / failed-delivery scan) → `supplier.escalate` → park
    `waiting_for_supplier` → respond on `supplier.updated`.
  - **B2 moving normally** (live in_transit/out_for_delivery/pending, no exception) → reply: shipped, can't
    cancel, **return it to us after arrival for a refund** (terms via `knowledge.search`). No escalation.
  - **B3 can't verify** (no tracking provider / unknown / no tracking #) → `merchant.notify` (Telegram
    heads-up) **then** `supplier.escalate`; fall back to a reply if no supplier configured.
  - BRANCH C (unfulfilled) now leads with **cancel + refund** for refund-intent. BRANCH A (delivered) adds a
    return-for-refund alternative.
- **Consequence to remember:** "is it shipped?" comes from Shopify (always), but "is there a real delivery
  EXCEPTION?" needs a tracking provider. Stores with NO tracking provider connected land every delivery-
  reason refund claim in B3 (merchant ping + supplier escalate) — the B2 auto return-for-refund reply only
  fires where tracking is wired up. (User chose "when unsure, ask merchant + escalate.")

TDD: `+1` triage config test, missing-package config test updated (tools + B1/B2/B3 + VERIFY + return-for-
refund assertions), `+2` worker e2e (B3 unverifiable → merchant.notify + escalate → parks; B2 normal →
return-for-refund reply, no escalation). `pnpm build` green; runtime + agent suites green (110). Files:
`support-triage.ts`, `missing-package-agent.ts`, their config tests, `agent-runtime.e2e.test.ts`. Committed
`971d1ff`, merged to `main`, deployed to Fly prod (v14) 2026-06-25.

## ✅ LANDED — Two retry modes: "Retry last step" vs "Restart from triage" (2026-06-25)

Surfaced by prod case `e161d86e`: a manager "Retry now" on an already-routed case re-ran the BOUND agent
(refund-review), so the deployed delivery-routing change never applied — the runtime always re-runs
`current_agent_id`, and a plain resume doesn't touch it, so routing changes only reach NEW cases that pass
through triage. Fix: two retry shapes on a `human_takeover` case.

- **Retry last step** (existing `/retry`, `trigger: dashboard_retry`) — re-runs the bound specialist.
- **Restart from triage** (`/retry` body `{ fromTriage: true }`, `trigger: dashboard_full_retry`) — the
  resume ALSO rebinds the case to `support-triage` and clears the stale `context.classification` (same tx as
  the status flip), so the next tick re-classifies + re-routes. Enrichment + `notes` are preserved (triage
  has no message-replay, so it re-classifies from `notes`).

Layers: `CaseLifecycleWriter.resume` gains `restartFromTriage` (rebind to `PRIMARY_AGENT_ID = support-triage`
+ drop classification + audit detail); `dashboard-writes.resumeCase` + `case-retry.retryCaseNow` (trigger) +
`handleDashboardRetry` (reads `fromTriage` from body) thread it through; api-client `retry({fromTriage})`;
dashboard overflow menu now offers both items (`retryNow` "Retry last step" + `retryFromTriage` "Restart from
triage"), new `retryFromTriageAction`. TDD: `+1` case-retry unit (full-retry trigger), `+1` lifecycle-writer
(rebind + classification-clear + audit), `case-actions-menu` test updated. `pnpm build` green; full suite
green (1748). **Backend NOT committed/deployed; dashboard UI needs its own Cloudflare deploy for the buttons.**

> **Shipped 2026-06-15 on branch `feat/supplier-portal` (10 TDD commits; full `pnpm build` + 1785-test suite green via the `ci:local` pre-commit hook on every commit; dashboard `typecheck` + `next build` verified separately).** The use-case + rationale below are kept as the design record; resolved decisions + deviations are recorded after the checklist.

### The use case

A customer messages support saying their order hasn't arrived even though the shipping-policy window has passed. The agent can't resolve it alone — it needs the **supplier / warehouse** to act (chase the carrier, reship, confirm a delay). Today the agent's only escalation surface is a one-way push into a merchant-owned Google Sheet (`supplier.add_sheet_row`), and **nothing closes the loop back to the customer**. We want:

1. Agent escalates the problem → the case **parks in `waiting_for_supplier`** (a status that exists in the state machine today but has **no producer and no consumer**).
2. The supplier logs into **their own space in our app**, sees the cases escalated to them, and posts an update / resolution **on that specific case**.
3. That update **triggers the agent**, which drafts the customer reply via `conversation.reply` — gated by the merchant's existing per-agent permission (**`ask` by default**, `auto` only if the merchant flipped it). The agent adapts the supplier's (possibly internal/blunt) note into a customer-facing reply — it does **not** pass the raw note through.

### Why this shape (and what we explicitly rejected)

We evaluated closing the loop **through the Google Sheet** — agent writes a row, supplier answers in a column, a worker polls the sheet and reports back. **Rejected** because:

- **No server-side query in the Sheets API.** `values.get` takes an A1 _range_, not a `WHERE` — finding a row by order/customer/email means reading a column and scanning it in our code. Workable but clumsy.
- **No native change push.** Detecting a supplier edit means either polling + snapshot-diffing every tenant's sheet on a cron, or making the merchant install an Apps Script `onEdit` webhook — fragile, expensive, non-deterministic.
- **Per-merchant arbitrary columns** ("to each merchant their own sheet") means no reliable contract for "the supplier addressed this vs. is still typing."

The **supplier-portal** approach flips _pull → push_ and wins on every axis the user cares about:

- **Case-enclosed** — the update arrives already bound to a `caseId`. No row search, no matching.
- **Deterministic** — the trigger is an explicit "supplier submitted a resolution" event, not a heuristic over edited cells.
- **Cheap** — no polling job, no per-tenant sheet scans, no snapshot storage, no extra LLM tokens spent finding the right row.
- It finally gives `waiting_for_supplier` a real **producer** (agent escalates) and **consumer** (supplier responds).

The sheet escalation (`supplier.add_sheet_row`) can **stay as an optional fallback output** for merchants whose warehouse refuses to leave their sheet, but the portal is the canonical closed loop.

### Access model — DECIDED: recurring login (persistent supplier accounts)

The supplier gets a **real logged-in space** (not one-off signed magic links), listing their open escalations across visits. Scope each supplier to a workspace/tenant. Lean on the **member-RBAC infrastructure** already landed (roles, per-workspace assignments, permission catalog) rather than inventing a parallel auth — a supplier is effectively a heavily-constrained external role that can see _only_ cases escalated to them and can _only_ post supplier updates.

### Build checklist — ALL LANDED

- [x] **Data model** (`packages/db`) — `0025_supplier_portal.sql`: `suppliers` (one ↔ one workspace; `user_decision_uuid` bound at first login) + `case_supplier_escalations` (privacy projection denormalized at escalate time + notification-outbox ledger). Plain `supplier-store.ts` fns + integration test.
- [x] **Escalation = producer** — `supplier.escalate` tool (`packages/tools`) + `SupplierEscalationService` (Tag in `services`, Live in `db`); per-agent `allow` on `missing-package-agent` BRANCH B; runtime parks the case in `waiting_for_supplier` (mirrors `conversation.ask_customer`). `supplier.add_sheet_row` kept as fallback.
- [x] **Supplier auth** (`apps/api` + WorkOS) — `supplier.cases.view`/`respond` perms + `decideSupplierAuthz` (no open-mode bypass; explicit assignment required); `supplierGet/Post` factory; `/me/session` binds the supplier login via `bindSupplierUser`.
- [x] **Supplier space (UI)** — `/supplier/cases` + `/supplier/cases/[id]` (minimal projection + update form); chrome walled via an AppShell supplier-mode branch (see deviation); merchant `/settings/suppliers` invite page.
- [x] **Trigger = consumer** — `POST /dashboard/supplier/cases/:id/update`: `recordSupplierUpdate` (note + case flip off `waiting_for_supplier` + audit in ONE tx) → publishes `supplier.updated` to pg-boss (flip-then-publish). Integration test over HTTP.
- [x] **Agent re-engagement** — `buildInitialMessages` `supplier.updated` branch injects the `wrapUntrusted`-fenced note + a rewrite instruction + the customer email from context; `missing-package-agent` SUPPLIER-RESPONDED flow drafts the gated `conversation.reply`.
- [x] **State machine** — producer/consumer edges + a `waiting_for_supplier` park guard (holds stray events except `supplier.updated`/`manual.takeover`/`case.resumed`). `PausedWaitingForSupplier` already existed in `WorkflowResult` — no agent-core change needed.
- [x] **Notify the supplier** — **durable outbox sweep** (`apps/worker/supplier-notify-schedule.ts`) relays `PlatformMailService.sendSupplierEscalation` off the `notified_at` ledger (retry + attempt cap), NOT best-effort (see deviation).

### Resolved decisions (settled in plan mode, 2026-06-14/15)

- **Supplier identity**: WorkOS org-member with a constrained Supplier role (reused RBAC + invites).
- **Privacy scope**: problem + order ref + ship-to (city/country) + tracking; **no** customer email / full address / thread.
- **Multi-tenancy**: one supplier ↔ one workspace.
- **Escalation routing**: single default supplier per workspace (`getDefaultSupplier`, oldest); per-vendor routing later.
- **`supplier.add_sheet_row`**: kept as the legacy/fallback output alongside `supplier.escalate`.

### Deviations from plan (recorded)

- **Notification = durable outbox sweep, not best-effort** (the user chose "durable queued send"): the escalation row is the ledger; a worker cron retries until sent or the attempt cap trips.
- **Chrome walled via an AppShell `supplier`-mode branch, NOT a `(merchant)/(supplier)` route-group refactor**: the refactor would have broken ~10 co-located test imports under `app/{cases,settings,connect}` for purely cosmetic isolation, and access is enforced by the api (`decideSupplierAuthz`) regardless of route structure.

### Follow-ups (recorded, not built)

- On supplier notify cap-exhaustion, alert the _merchant_ ("supplier unreachable") and move/flag the
  case for recovery. Current audit (2026-06-22) found the sweep stops selecting rows once
  `notify_attempts` reaches the cap, leaving the case in `waiting_for_supplier` with no merchant-facing
  error state if the supplier was never reached.
- Live verification (invite a real supplier → post an update → confirm the gated customer reply) — not yet run.
- A merchant-facing list of current suppliers / pending supplier invitations on `/settings/suppliers` (invite-only for now).
- Consider hiding the new "Supplier" RBAC category from the merchant role editor (harmless today — owners only).
- Branch `feat/supplier-portal` is **not yet merged to `main`**.

### Invariants this must respect

Dependency rule (`agent-core` imports nothing downstream); `PermissionService` consulted before every tool execution; audit-log writes share the transaction with case-state changes; case state machine guards every transition; Effect Service/Layer separation; TDD (failing test first); `pnpm build` green before stopping.

---

### Session history (summarized)

- **2026-06-25 — Shipped `discount.create` goodwill-coupon tool (bounded by per-tenant DiscountPolicy).**
  The refund-review agent (and any custom agent, since it's assignable) can issue a single-use coupon
  code as a service-recovery gesture. The agent chooses ONLY `valueType` (percentage|fixed_amount) +
  `value`; the tool forces every other parameter as a guardrail: single-use (`usageLimit=1`,
  `appliesOncePerCustomer`), locked to the ORDER's customer (resolved server-side — agent can't redirect;
  a leaked code is worthless), non-combinable, whole-order, and `endsAt = now + policy.maxValidityDays`.
  The code string is auto-generated (`THANKS-XXXXXX`, deterministic from callId). PermissionService gains
  a `discount.create` branch mirroring refunds (`applyDiscountPolicy`): ≤ask% allow, ask–max ask, >max
  deny; fixed_amount gates on minor-unit zones + currency. `DiscountPolicy` lives in the `tenants.settings`
  JSONB (defaults on read — no migration), tunable at `/settings/discount-policy`. New Shopify scope:
  `write_discounts`. Two commits on `feat/discount-coupons` (backend `223ffef` + dashboard); full
  `ci:local` green (2067 tests). NOT merged to main; NOT verified live (needs the app's write_discounts
  scope granted on a real store).
  Follow-ups: (a) no per-CASE cumulative discount aggregation yet (refunds have audit-L9 summing) — v1
  gates per-call, bounded by single-use + locked-to-customer; (b) `applies_to` (specific products/
  collections) and `minimum_requirement` are forced defaults (whole-order / none), not yet agent- or
  merchant-configurable; (c) verify the live `discountCodeBasicCreate` mutation against a real store.
- **2026-06-25 — Discussed supervisor/reporting subagent architecture (no production code edits).**
  Compared the current durable peer-handoff runtime with a Claude Code-style lead-agent/subagent model.
  Decision direction: no wholesale swap; tools remain the deterministic data-fetch primitive, while a
  bounded `agent.delegate`/structured-report pattern may be worth testing for token-heavy LLM judgment or
  multi-intent synthesis. Recorded the follow-up above. Verified `pnpm build` green.
- **2026-06-25 — Case-page header cleanup: status fires on select; "Retry now" moved to a ⋮ menu.**
  Removed the separate "Update status" submit button — picking a different status in the dropdown now
  fires `setStatusAction` immediately (re-picking the current value is a no-op). Added a kebab (⋮)
  overflow menu as the home for actions that don't warrant a header button; its first item is "Retry
  now" (agent hand-back + immediate tick), moved out of the header row. More actions will be added to
  this menu later. No api/contract/schema change — same `setStatusAction`/`retryAction` server actions.
  Build (all in `apps/dashboard/app/cases/[id]/`):
  - `case-actions-menu.ts` — pure `caseActionMenuItems({ canResume })` deciding the menu's contents
    (today: `retryNow` only, while under human takeover). Page maps each key → its server action via a
    `CaseActionKey`-typed `CASE_MENU_ACTIONS` record (a new key won't type-check until it's wired).
  - `StatusSelect.tsx` (client) — auto-submits on change via `form.requestSubmit()`; disables the select
    while pending (`useFormStatus`). Labels computed server-side and passed in (no client `labels` import).
  - `CaseActionsMenu.tsx` (client) — ⋮ popover following the `MultiSelect` pattern (click-outside +
    Escape-refocus); each item is its own server-action `<form>` so behavior matches the header buttons.
    Renders nothing when there are no actions.
  - **TDD**: new `case-actions-menu.test.ts` (2 tests, red → green). Dashboard `typecheck` green; dashboard
    suite **334 passing**; root `tsc -b` green; `next build` green. Not committed.
- **2026-06-24 — Completed the remaining lifecycle-refactor backlog from the handoff (TDD).**
  `CaseLifecycleWriter` now owns the remaining production case lifecycle writes in the agent/worker path:
  runtime escalations/resolutions/parking/reopen/reply-delivery-failure outcomes, approval-expiry
  escalation, workflow dead-letter escalation, and agent-initiated `case.update_status` transitions. The
  writer gained specific operations (`parkForApproval`, `parkWaitingForCustomer`, `parkWaitingForSupplier`,
  `reopenForCustomerReply`, `parkForReplyDeliveryFailure`, and `applyAgentStatusUpdate`) rather than a
  generic arbitrary-transition escape hatch. `case.update_status` now records `case.status_changed` at the
  service boundary inside the same transaction as the guarded transition. Verified with focused lifecycle,
  worker, tool, runtime e2e, and transaction tests; `pnpm build` green; `pnpm ci:local` green against the
  local Postgres test DB (**1973 passing / 5 skipped / 0 failing**). Final `rg "transitionStatus\\(" packages apps -n`
  shows production direct status transitions only inside `packages/services/src/case-lifecycle-writer.ts`;
  the other hits are tests or repository comments.
- **2026-06-23 — Refreshed `CAPABILITIES.md` to cover everything landed since the 2026-06-12 snapshot.**
  Regenerated the capability inventory from shipped code at `e191ac4` (109 commits past the old `11f24b2`
  snapshot). Verified each area against the code before documenting. Added: a new **Team Members And
  Roles** (RBAC) section; the **Durable Supplier Portal** (`supplier.escalate`, `waiting_for_supplier`
  park + `supplier.updated` re-engagement, walled `/supplier` surface, supplier role + isolation guard,
  durable notify sweep); the order-status **customer-identity disclosure gate**; **reply-delivery retry**
  (outbox, retry sweep, "Retry sending email", failed-send never resolves); **manual reply composer +
  Rephrase with AI** (configurable rephrase model); **manual case status change**; IMAP **message-id
  correlation** + send-reliability; **email HTML rendering**; the **apps/api feature-first** composition
  root; **WorkOS-JWT dashboard auth (S14)**; **operational credential-key rotation (S15)**; **connector
  health on integrations**; **Shopify workspace connect gate**; admin **OpenRouter key by account/
  workspace** + org-name display; **Guidezilla** rebrand; **Fly.io** deploy target. Removed the four
  now-resolved boundary items (per-workspace RBAC, forwarded-JWT verification, connector-health
  rendering, previous-encryption-key wiring) and added residual ones (`x-user-email` low-trust, supplier
  loop unverified live, thread tab renders by root, supplier-loop live verification).
- **2026-06-23 — Architecture review follow-up: dashboard lifecycle writes now use `CaseLifecycleWriter` (TDD).**
  Completed the next migration target from the review: `packages/db/src/dashboard-writes.ts` no longer
  hand-rolls the case lifecycle transaction recipe for take-over, resume, or manual status changes.
  - **services**: extended `CaseLifecycleWriter` with `takeOver`, `resume`, and `setMerchantStatus`, covering
    terminal/no-op handling, settable-status validation, state-machine transitions, audit entries, and pending
    approval cancellation inside `TransactionRunner`.
  - **approvals**: added `ApprovalService.cancelPendingForCase` so manual lifecycle writes can cancel stale
    pending approvals through the service interface instead of table writes at each caller.
  - **db adapter**: `dashboard-writes.ts` is now a thin adapter that runs the lifecycle writer against the
    current `DrizzleDb`; onboarding/workspace writes remain plain Drizzle because they are not case lifecycle
    writes.
  - **Verified**: RED first in `packages/services/test/case-lifecycle-writer.test.ts` (missing writer methods),
    then green service tests; `pnpm build` green; `pnpm ci:local` green with local DB migrations and full suite
    **1941 passing / 5 skipped / 0 failing**, including `apps/api/src/features/dashboard/tests/writes.integration.test.ts`.
- **2026-06-23 — Architecture review slice: deepened case lifecycle writes (TDD).**
  Implemented the top recommendation from `/private/tmp/architecture-review-20260622-022840.html` as a
  first narrow slice: a services-level `CaseLifecycleWriter` now owns the repeated "read case → patch
  context risk flags → state-machine transition → audit log inside the transaction" choreography.
  - **services**: added `CaseLifecycleWriter` + `CaseLifecycleWriterLive` with tested `escalateToHuman`
    and `resolve` methods. Tests cover supplier-notification cap escalation, no-op source-status guards,
    and `human_takeover → in_progress → resolved` bridging while clearing only selected risk flags.
  - **worker**: `supplier-notify-schedule` and `reply-delivery-retry-schedule` now call the lifecycle
    writer instead of hand-rolling repository/audit/transaction recipes; worker bootstrap exposes the new
    tag via `Layer.provideMerge`.
  - **Verified**: RED first (`Cannot find module '../src/case-lifecycle-writer.js'`), then focused green
    `pnpm test -- --run packages/services/test/case-lifecycle-writer.test.ts apps/worker/test/supplier-notify.test.ts apps/worker/test/reply-delivery-retry.test.ts`;
    `pnpm build` green.
  - **Follow-up from the same architecture report:** migrate remaining lifecycle write choreography in
    `packages/db/src/dashboard-writes.ts` (`takeOverCase`, `resumeCase`, `setCaseStatus`) and then inspect
    `packages/services/src/agent-runtime.ts` parking/resume writes for the same service boundary.
- **2026-06-23 — Fixed the vitest teardown FK bug that polluted the shared dev DB (TDD).**
  Root-caused above: the global-teardown backstop did a single `DELETE FROM tenants`, which is blocked by
  any leaked tenant's `cases`/`approvals` rows (`ON DELETE NO ACTION`, by design). Chose the **ordered-delete**
  fix over schema-cascade, because the NO ACTION FKs are intentional safety and production's `redactShop`
  already deletes children in dependency order. Build:
  - **packages/db** (`test-teardown-purge.ts`): new `purgeLeakedTenants(sql, keepTenantIds)` deletes in the
    same order as `redactShop` — `approvals` → `cases` → `audit_log` → `tenants` (the tenant delete cascades
    the rest: transitions, message_ids, reply_deliveries, supplier escalations, knowledge docs, overrides,
    connector_connections, …). `audit_log` has no FK so it's deleted explicitly to avoid orphan leak.
    `x <> ALL('{}'::uuid[])` keeps the empty-keep-list = delete-all semantics of the original.
  - **vitest.global-teardown.ts**: now calls `purgeLeakedTenants`; the misleading "cascade carries cases →
    transitions" comment is corrected.
  - **TDD**: `packages/db/test/test-teardown-purge.integration.test.ts` seeds a leaked tenant owning
    case + approval + audit row alongside a "keep" tenant; confirmed **RED** first
    (`violates foreign key constraint "approvals_tenant_id_tenants_id_fk"` — the exact bug), then GREEN.
  - **Verified**: `pnpm build` green; full `ci:local` **1933 passing / 5 skipped / 0 failing**; post-run dev DB
    back to exactly 5 real tenants with 0 orphan cases/approvals (the teardown now self-cleans).
  - **Not done (deliberately):** did NOT add a `member_role_assignments.role_id` RESTRICT pre-delete — the
    teardown mirrors `redactShop`, which relies on the tenant-delete cascade for roles/assignments; if a future
    member-RBAC test leaks a tenant with role rows and RESTRICT blocks the cascade, handle it then.
- **2026-06-23 — Merchant can manually change a case's status from the dashboard (TDD).**
  New "Update status" dropdown on the case page lets the owner set a case's status by hand — mark it
  resolved, reopen a resolved/failed case, or park it waiting on the customer. **No schema change**
  (reuses `cases` + `case_state_transitions` + `audit_log` + `approvals`). Build:
  - **agent-core** (`case.ts`): `MERCHANT_SETTABLE_STATUSES` = `{in_progress, waiting_for_customer,
resolved, failed}` (curated — agent-internal/parked states like `triaging`/`waiting_for_supplier`/
    `waiting_for_approval`/`human_takeover` are NOT hand-settable) + `isMerchantSettableStatus` +
    `allowedManualStatusTargets(from)` = settable ∩ `isStatusTransitionAllowed(from,·)` − `{from}`. The
    manual control is re-checked against the §10 matrix, so it never bypasses the state machine.
  - **packages/db** (`dashboard-writes.ts`): `setCaseStatus` mirrors `takeOverCase` — load (tenant-scoped)
    → validate settable + matrix → update `cases` (+ `resolvedAt` when→resolved) + `case_state_transitions`
    - `audit_log` (`case.status_changed`) + cancel pending approvals, all ONE tx. Outcomes:
      `updated | unchanged | invalid_status | transition_not_allowed | case_not_found`.
  - **contracts**: new `cases.set_status` RBAC permission (implies `cases.view`; Owner auto-has it).
  - **apps/api**: `handleDashboardSetCaseStatus` + `POST /dashboard/cases/:id/status` gated on
    `cases.set_status`. Pure DB transition (does NOT tick the agent — "Retry now" is for that).
  - **apps/dashboard**: api-client `setStatus` + `setStatusAction` + a `NativeSelect` "Update status"
    form in the case-page header (current status shown as `(current)`, so submitting unchanged is a benign
    no-op) + `statusChanged` banner + `case.status_changed` audit label + curated-timeline entry.
  - **TDD**: 12 agent-core unit tests + 6 api HTTP integration tests (resolve+cancel-approval, reopen,
    unchanged no-op, invalid_status 400, illegal-transition 409, cross-tenant 404). `pnpm build` green;
    dashboard `typecheck` green; full suite **1932 passing / 5 skipped / 0 failing**.
  - **Invariant preserved (NOT regressed):** `human_takeover → resolved` stays forbidden by the matrix
    (the explicitly-tested L17/takeover-race guard), so a taken-over case can be hand-set to `in_progress`
    or `failed` but not directly `resolved`. **Follow-up:** if merchants need "I handled this takeover,
    mark it resolved," that needs an explicit invariant decision (the runtime's 2.95 park guard already
    prevents the _agent_ from auto-resolving, so loosening the matrix for an explicit human action would
    be safe) — deferred, not done here.
- **2026-06-23 — Maintenance: verified `733a213`, cleaned tree + polluted dev DB, definitive green `ci:local`.**
  Follow-up to the background agent that committed the install-link feature with `--no-verify`. (a) Confirmed
  `733a213` intact on `main`. (b) Restored the stray `apps/dashboard/next-env.d.ts` (auto-generated Next
  dev-vs-build types path churn, `.next/types/` ↔ `.next/dev/types/` — not a real change); tree clean. (c) **Reset
  the polluted shared dev DB** (`support_agent`): it had ~93 tenants, 85 of them test leftovers (fixed-date
  workspace fixtures `2026-01/02/03-01`, `Supplier Test ×6`, and the whole `2026-06-22 23:xx` killed-run cluster).
  Took a `pg_dump` backup first, then deleted the 85 in dependency order; kept the 5 real tenants
  (`Anas's Support Team`, `support-agent-test.myshopify.com`, `aiden-support`, `Second Store`, `Anas Naciri`).
  (d) Ran `pnpm ci:local` against the cleaned DB: **1919 passing / 5 skipped / 0 failing** (the 5 skips are
  live-credential smoke tests) — matches the bg agent's pre-pollution run, so the commit's code was always green;
  the earlier "181 failures" were pure DB pollution. DB left at exactly 5 tenants afterward (no leak this run).
  - **FOLLOW-UP / BUG FOUND → ✅ FIXED 2026-06-23 (see next entry):** the vitest global teardown
    (`vitest.global-teardown.ts`) did `DELETE FROM tenants WHERE id NOT IN (before-snapshot)` and its comment
    claimed the FK cascade carried `cases → transitions`. **It didn't** — `cases.tenant_id` and
    `approvals.{case_id,tenant_id}` are `ON DELETE NO ACTION`, not `CASCADE`. So any test tenant that created a
    case (or approval) blocked its own teardown delete (FK violation, swallowed by the teardown's try/catch) and
    accumulated. That was the pollution source. **Resolved by the ordered-delete option**, NOT the schema-cascade
    option: the NO ACTION FKs are intentional safety and production's `redactShop` already deletes in dependency
    order — the teardown now mirrors it. See [[stack_decisions]].
- **2026-06-23 — Pilot install uses the operator's store-unique install link (TDD, completes A4's original direction).**
  In pilot mode the merchant's Connect no longer always runs our self-built OAuth dance: the operator can paste the
  store-unique install link Shopify generates for a custom-distribution app (Dev Dashboard → custom distribution →
  Generate link, the signed `admin.shopify.com/.../oauth/install_custom_app?...signature=` URL we can't reconstruct),
  and Connect redirects straight to it. The link drives Shopify's own install flow and lands on our existing OAuth
  callback (no state of our design → resolved by the recorded shop, A4). This is the install-link half of the original
  audit-A4 direction that the 2026-06-06 fix deferred ("we build the proven authorize URL from the captured shop rather
  than storing Shopify's generated link"). Build:
  - **Schema/migration**: added nullable `install_link` text column to `shopify_app_provisioning` (migration
    `0028_clear_jocasta.sql`). Threaded `installLink` through `ShopifyAppProvisioning` + `PutShopifyAppProvisioningInput`,
    the Test layer, and the Live store (`rowToProvisioning` + `put` upsert: explicit value recorded; undefined preserved
    on a live row, cleared on reactivation — same rule as `shop_domain`).
  - **Admin API/console**: new pure `isValidShopifyInstallLink` (https + `admin.shopify.com`/`*.myshopify.com` host only —
    it's a browser redirect target, so reject open-redirect hazards); `AdminShopifyAppView`/`AdminTenantDetail.shopifyApp`
    carry `installLink`; `PUT /admin/tenants/:id/shopify-app` parses + validates it (400 `invalid_install_link`); apps/admin
    tenant page gained a "Store install link" input + summary row + error copy.
  - **Install handler**: `handleShopifyInstall` no-shop branch, gated on `cfg.shopifyConnectRequiresProvisioning`, redirects
    to the stored link (re-validated via `resolveProvisionedInstallLink`) before falling back to the A4 authorize-URL /
    managed-install paths. Leaving the link blank keeps the existing OAuth flow, so it's backward compatible.
  - TDD: validator units + DB round-trip/preserve/clear + admin valid/invalid + install-gate redirect. `pnpm build` green;
    full suite 1919 passing / 5 skipped. See [[project_pilot_shopify_app_provisioning]].
- **2026-06-22 — Configurable rephrase model + minimalistic dropdown (draft-email feature, slices 3+4 of 4).**
  The "Rephrase with AI" model is now a **workspace setting**, picked from a compact dropdown (current
  model name + chevron) on top of the composer draft. Build (TDD):
  - **Persistence**: added an optional `rephraseModel` to `TenantSettings` + `setRephraseModel` on
    `TenantRepository` (Tag + Test + Live, mirroring `setRefundPolicy`'s `||` JSONB merge in
    `tenants.settings` — **no migration**). Made the field optional so the dozen existing
    `new TenantSettings({...})` call sites didn't need touching; Test-layer setters preserve it.
    3 unit tests + a real-DB integration round-trip test (`settings.integration.test.ts`) that verifies
    persist/clear + sibling preservation + the `/models` embed.
  - **Endpoint/handler**: `POST /dashboard/settings/rephrase-model` (gated `settings.agents`) →
    `setRephraseModel`; the rephrase handler now reads the configured model (fallback
    `REPHRASE_MODEL`); the current model rides in `ModelsResponse.rephraseModel` (filled by
    `handleDashboardModels` reading `getSettings`) so the composer gets list + selection in one fetch.
  - **UI**: a compact `RephraseModelPicker` (name + chevron, lucide `ChevronDown`/`Check`) atop the
    composer; selecting persists via `setRephraseModelAction`. The picker only renders when the catalog
    is readable — the case page fetches it via a 403-tolerant `api.replyModels` so a reply-only member
    (no `settings.agents`) still gets the composer, just without the picker, instead of being bounced.
  - **Permission model**: rephrase + send stay on `cases.reply`; _changing the model_ needs
    `settings.agents` (it's a workspace setting). Verified: `pnpm build` green; unit + the new DB
    integration test pass; dashboard `typecheck` clean.

- **2026-06-22 — "Rephrase with AI" on the reply draft (draft-email feature, slice 2 of 4).**
  The manual-reply composer now has a **Rephrase with AI** button that rewrites the agent's current
  draft in place (clearer/warmer/professional, meaning + facts preserved), spent against the tenant's
  own LLM credential. Build (TDD):
  - **Core** `apps/api/src/features/dashboard/rephrase.ts` — DI'd `rephraseDraft`
    (`empty_input → no_llm → failed → rephrased`) + pure prompt helpers (`REPHRASE_SYSTEM`,
    `buildRephraseMessages`). 6 unit tests. `no_llm` is split from `failed` so the UI can say
    "connect an AI provider" rather than a generic error.
  - **Endpoint** `POST /dashboard/rephrase` (`handleDashboardRephrase`, gated `cases.reply`): checks
    the tenant credential via `resolveActiveLlmCredential`, then one-shot `LLMService.runToolCalling`
    with **`tools: []`** → the model returns a `final_message` whose `.text` is the rewrite. Model is
    hardcoded `google/gemini-3.5-flash` for now (slice 3 makes it configurable).
  - **Layer**: added `LLMService` to `ApiLayer` (`LLMServiceLive` over `LLMCredentialResolverLive` +
    `BlobStorage`) — the api had no LLM surface before; this is the first one-shot LLM call outside the
    worker runtime.
  - **UI**: `ReplyComposer` is now a **client** component (controlled draft state); the button calls a
    value-returning `rephraseAction` server action via `useTransition` and swaps the textarea text on
    success (inline error otherwise). Send still flows through the `sendReplyAction` form action.
  - Verified: `pnpm build` green; rephrase + reply unit tests pass (13/13); dashboard `typecheck` clean.
  - **Not yet verified live** (needs a tenant LLM credential + a taken-over case). **Committed.**

- **2026-06-22 — Manual reply composer (draft-email feature, slice 1 of 4).** A human driving a case
  (`human_takeover`) can now draft and send a customer reply straight from `/cases/:id`. Product
  decisions (asked + recorded): composer is shown **only in `human_takeover`** (gated on the existing
  `canResume`), and a manual send **keeps the case in `human_takeover`** (no auto-resolve — the person
  decides when they're done). Build (TDD):
  - **Core** `apps/api/src/features/dashboard/case-reply.ts` — DI'd `sendManualReply` (mirrors
    `retryCaseNow`): guards `empty_body → case_not_found → not_in_takeover → no_thread → send_failed`,
    best-effort `recordSent` (a bookkeeping failure never downgrades a real send). 7 unit tests.
  - **Endpoint** `POST /dashboard/cases/:id/reply` (`handleDashboardCaseReply`), gated on the
    pre-existing-but-unused `cases.reply` RBAC permission. Sends via `ConversationService.reply` (same
    connector/thread the agent uses): resolves the live thread to pick the recipient (latest inbound
    sender) + `inReplyTo`, lets the connector inherit the `Re:` subject, then **replicates the runtime's
    `recordOutboundReplyId`** (`recordMessageId` direction `outbound`) so the customer's next reply still
    threads back, plus a `case.replied` audit row.
  - **Layer**: added `AuditLogService` (`AuditLogServiceLive`) to `ApiLayer` (it wasn't provided before)
    so the handler can write the audit entry.
  - **UI**: `ReplyComposer.tsx` (Textarea + Send) + `sendReplyAction`; rendered on the case page only
    when `status === human_takeover`; result banner (`sent` / `send_failed` / `not_in_takeover` / …).
  - Verified: `pnpm build` green; new + sibling unit tests pass (11/11); dashboard `typecheck` clean.
  - **Follow-ups / known gaps**: (a) a manual send is currently **synchronous** — on connector failure
    it reports `send_failed` and does **not** enqueue the durable `reply_deliveries` outbox (reusing it
    would wrongly auto-resolve the case via the worker sweep; teaching the sweep to skip manual replies
    is the durable-retry follow-up); (b) if the live thread can't be resolved we surface `send_failed`
    rather than falling back to the context `customerEmail`; (c) on traditional IMAP the sent message may
    not appear in the "Email thread" tab (same Sent-folder limitation as agent replies) — the
    `case.replied` audit row is what shows it in Activity/Full audit. **Not yet committed.**

- **2026-06-22 — Consolidated branches/worktrees back into `main`.** Fast-forwarded
  `fix/imap-smtp-send-reliability` into `main`, then merged `fix/runtime-recovery` via merge commit
  `f35dd2c`. Verified merged `main` with `pnpm build` and `pnpm test` (1583 passed, 315 skipped in the
  current non-DB environment). Planned cleanup after verification: remove
  `/private/tmp/support-agent-runtime-recovery` and delete the now-merged feature branches so the repo is
  back to one active branch/worktree.

- **2026-06-22 — Checked the other worktree `/private/tmp/support-agent-runtime-recovery`
  (`fix/runtime-recovery`) against the architecture-review issues (no production code edits).** It has
  code commits `4120ab3 fix(runtime): surface recovery dead ends` and `bcb9e6e feat(dashboard): surface a failed-send timeline card with inline retry`, and `pnpm build` is green there.
  The branch fixes several concrete recovery follow-ups that overlapped the review context: reply-delivery
  failure capture is now in the same tx as risk-flag/park/marker writes, case detail exposes
  `activeReplyDelivery` so "Retry sending email" no longer depends only on `riskFlags`, supplier-notify
  cap exhaustion escalates the case with `supplier_unreachable`, and deterministic approval-resume dead
  ends park in `human_takeover`. It does **not** implement the report's deeper module recommendations:
  no `CaseLifecycleWriter`, no collapsed `ToolExecution` module, no `ConversationThreadOwnership`
  module, and no worker-local connector supervisor. The architecture report remains only partially
  addressed by that worktree.

- **2026-06-22 — Rechecked the architecture-review report against the current worktree (no production
  code edits; follow-up answer to "are the issues here fixed?").** Compared
  `/private/tmp/architecture-review-20260622-022840.html` with `git status`,
  `git diff 681b06b..HEAD`, `git diff main..HEAD`, and source grep/line checks; verified
  `pnpm build` green again. Conclusion: the Case lifecycle, Tool execution, and Connector supervisor
  remarks still stand; Conversation thread ownership is only partially reduced by the IMAP/SMTP
  reliability branch (`a03eb68`/`68f287b`/`d2037a2`) because it skips one duplicate IMAP read, adds
  timeouts, and makes pre-send thread reads best-effort, but it does not centralize case-thread
  ownership or fix the dashboard/fetchThread root-only shape. Local `main` changed only this checklist
  after the report; the branch code changes are IMAP/SMTP + conversation reply/ask tooling.

- **2026-06-22 — Fixed: IMAP/SMTP replies intermittently failed to send (TDD, branch
  `fix/imap-smtp-send-reliability`, 3 commits `a03eb68`+`68f287b`+`d2037a2`; full `ci:local` green at
  each commit — `pnpm build` + 1875→1880 tests).** Audit of the generic mailbox connector vs Gmail,
  prompted by "messages do not send, it keeps failing." The unreliability was STRUCTURAL, not random:
  - **The SMTP send was gated behind a live IMAP read.** Every reply hit a pre-send
    `ops.fetchThread(root)` to derive subject + parent, because every specialist prompt passes
    `subject: null` + `inReplyToMessageId: null` (`order-status-agent.ts:49,64,67`,
    `missing-package-agent.ts:83,86`, `refund-review-agent.ts`, `damaged-product-agent.ts`,
    `general-inquiry-agent.ts`). That read is a full IMAP login; on failure the send aborted with
    `ConversationSendFailed` **before SMTP was attempted**. Fix (`imap-smtp-conversation-live.ts`): the
    context read is now BEST-EFFORT (`Effect.orElseSucceed(() => [])`) — on failed/empty read, fall
    back to `subject ?? "Re: support"` + `references=[root]` and still send. Threading holds via the
    recorded message-id index.
  - **No connection timeouts.** Fix (`imap-smtp.ts`): a `TIMEOUTS` const (connect 15s / greeting 10s /
    socket 30s) spread into both `imapClientOptions`/`smtpTransportOptions`, so a hung handshake fails
    in seconds instead of blocking the tick for minutes (nodemailer default socketTimeout = 10 min).
  - **Why it bites in prod:** connector connects PER OPERATION, unpooled (`imap-smtp.ts:505`). One
    reply = fetchThread (IMAP) + send (SMTP) + `maybeSaveSentCopy` (IMAP, after 1500ms) + the 60s poll
    cron's IMAP login — racing handshakes on `mail.privateemail.com` (Namecheap, low concurrent-conn
    cap) → "too many connections" → send failed. Gmail is immune (pooled HTTPS, no cap, threadId on
    send). The reliability ARCHITECTURE was already correct (failed send → park + `reply_deliveries`
    retry, never silent-resolve); the connector was just failing sends far more than it should.
  - **Connection pressure cut (commit `d2037a2`):** a single reply opened up to THREE IMAP
    connections — the tool's S9 recipient-check `fetchThread`, the connector's own `fetchThread` for
    subject/parent, and the Sent append — two reading the SAME INBOX. Fix: `conversation.reply` /
    `conversation.ask_customer` now REUSE the recipient-check thread to derive a null subject
    (`Re: <subject>`) and pass it down (`reply.ts` `assertRecipientsInThread` returns the thread +
    new `replySubject`); the IMAP connector reads the mailbox ONLY when the subject is still missing
    (`if (!subject)`), defaulting the parent to the thread root so a reply still threads via
    References=[root]. Removes one full IMAP connection per reply in the healthy path, no subject
    regression. Only the provider-neutral subject is reused — the parent id is provider-specific
    (Gmail's message id ≠ RFC id), so the connector still owns it.
  - **REMAINING FOLLOW-UPS:**
    - [ ] DECIDED NOT to flip `sentSaveMode` default to `smtp_provider`: traditional IMAP providers
          (Dovecot/cPanel/Namecheap PrivateEmail) do NOT auto-file SMTP-submitted mail to Sent, so the
          flip would hide the agent's replies from the merchant's Sent folder. `pool: true` alone is
          inert without caching the transport across sends (we create + close one per `send()`).
          Remaining safe pressure cut would be a per-tenant transport/connection cache — bigger change.
    - [ ] Preserve a precise In-Reply-To (immediate parent) without a read — today the no-read path
          uses References=[root] only; the precise parent needs the indexed message-ids threaded into
          the send (provider-aware), deferred.
    - [ ] Latent thread-tab bug: the router's `fetchThread` validation
          (`conversation-router-live.ts:141`) fails the WHOLE thread when any IMAP message's derived
          `threadId` (`references[0] ?? messageId`) ≠ root, so a reordered-References reply breaks the
          email-thread tab even when the case is correctly correlated.
    - [ ] The `case_message_ids` threading fix (migration 0027) is now COMMITTED on `main` (verified
          in HEAD: migration 0027 + `findByMessageIds`), but verify it's been DEPLOYED + migrated on
          Fly — until the deployed stack runs it, prod still mints duplicate cases per reply ("threads
          scattered across cases").
  - See [[project_imap_send_reliability]].

- **2026-06-22 — Agent-runtime dead-end audit (no production code edits).** Static-traced the runtime
  failure exits, worker settlement/dead-letter handling, reply-delivery retry path, supplier notification
  sweep, approval maintenance, and merchant dashboard surfacing. Verified the focused recovery suites:
  `pnpm test -- --run apps/worker/test/workflow-job.test.ts apps/worker/test/reply-delivery-failure.test.ts
apps/worker/test/reply-delivery-retry.test.ts apps/worker/test/supplier-notify.test.ts
apps/worker/test/approval-maintenance.test.ts apps/dashboard/test/risk-flag-label.test.ts
apps/dashboard/test/case-timeline.test.ts apps/dashboard/test/labels.test.ts
apps/dashboard/test/status-variants.test.ts` (58 passed). `case-retry-send.integration.test.ts` was
  invoked but skipped because `DATABASE_URL` is not set. Covered paths: LLM credential/safety/context
  failures, max-turn exhaustion, approved-tool failures, expired approvals, retry-exhausted workflow jobs,
  and customer-reply send failures all park or surface as intended in normal conditions. Follow-ups found:
  - [x] Make failed reply delivery capture atomic enough that a send failure cannot park the case without
        durable retry metadata: today `ReplyDeliveryService.enqueue` and `reply_delivery_failed` risk-flag
        writes are best-effort before `human_takeover`, so a DB hiccup can leave the merchant with only
        generic "Retry now" and no exact draft resend.
  - [x] Show the case-detail "Retry sending email" action from the active `reply_deliveries` row, not only
        from `case.context.riskFlags`, so an outbox row remains recoverable even if the best-effort risk
        flag write failed.
  - [x] Add supplier-notify cap-exhaustion recovery: when `notify_attempts` reaches the cap, park/flag the
        merchant side (likely `human_takeover` with `supplier_unreachable`) instead of silently leaving the
        case in `waiting_for_supplier`.
  - [x] Escalate deterministic approval-resume failures that can leave a decided approval on a still-parked
        case (for example tool removed from registry) instead of returning non-retryable `Failed` that the
        worker completes without a merchant-facing error.
  - **2026-06-22 implementation on `fix/runtime-recovery`:** reply delivery recovery now requires the
    active `reply_deliveries` capture before flagging/parking, and the live writer joins the ambient tx;
    case detail exposes `activeReplyDelivery`, and the dashboard retry-send button keys off that row.
    Supplier notify final-attempt failure now escalates the merchant case with `supplier_unreachable`
    and merchant-facing timeline/risk copy. Approval resume missing-tool/non-runnable rows now park in
    `human_takeover` with explicit escalation reasons. Verified with
    `pnpm test apps/worker/test/reply-delivery-failure.test.ts apps/dashboard/test/retry-send-visibility.test.ts apps/worker/test/supplier-notify.test.ts apps/worker/test/agent-runtime-recovery.test.ts apps/dashboard/test/risk-flag-label.test.ts apps/dashboard/test/case-timeline.test.ts apps/api/src/features/dashboard/tests/case-retry-send.integration.test.ts`
    (48 passed, 4 skipped because `DATABASE_URL` is unset), `pnpm build`, and full `pnpm test`
    with socket permissions (1571 passed, 315 skipped).

- **2026-06-22 — Architecture deepening review generated (no production code edits).** Used
  `$improve-codebase-architecture` + `codebase-design` vocabulary and wrote the visual report to
  `/private/tmp/architecture-review-20260622-022840.html` (opened locally). `CONTEXT.md` and
  `docs/adr/` were absent, so the review used `master-plan.md`, this checklist, and source inspection
  as the domain record. Top recommendation: deepen a `CaseLifecycleWriter`-style module so case
  state changes, audit rows, context patches, approval/outbox-adjacent writes, and state-machine guards
  cross one semantic interface instead of being hand-composed in runtime/API/worker paths. Other
  candidates: internal Tool execution module, Conversation thread ownership module, and worker-local
  Conversation connector supervisor. **Potential master-plan deviations discovered, not fixed:** some
  lifecycle paths appear to write status/transition/audit rows directly (`supplier-store.ts`,
  `dashboard-writes.ts`) instead of centralizing through the state-machine guard; failed reply delivery
  capture can park a case even if the outbox enqueue/risk-flag writes were only best-effort. Follow-ups:
  - [ ] Verify and, if needed, route supplier/dashboard lifecycle writes through one state-machine-guarded
        lifecycle module.
  - [ ] Make failed reply delivery capture atomic with the case park + audit/outbox writes, or document
        why the best-effort tradeoff is intentional.
  - [ ] Deepen conversation thread ownership so the IMAP email-thread tab can use indexed message ids
        rather than a single root-only `fetchThread` lookup.
  - [ ] Consider a worker-local connector supervisor for Gmail watch renewal, Graph subscription renewal,
        and IMAP poll passes.

- **2026-06-19 — Agent-runtime decomposition (branch `refactor/agent-runtime-decompose`, behavior-
  preserving, full CI green at each commit — build + migrate + 1872 tests).** `agent-runtime.ts` was a
  2666-line monolith with a single ~1700-line `tickBody`. Decomposed in staged commits, each verified:
  (1) committed the in-flight message-id correlation feature to get a clean base (`7fdb19e`);
  (2) `refactor: extract pure helpers` (`69b1ac2`) — ~730 lines of pure helpers (eventToCaseLookup,
  buildSystemPrompt, buildInitialMessages, executionKeyFor, deliveryScopeFor, the prompt-injection flag
  helpers, applyOverride, …) moved to a sibling `agent-runtime-helpers.ts`, re-exported via `export *`
  so the package surface + test imports from `./agent-runtime.js` are unchanged (10 previously-private
  helpers gained `export`);
  (3) `refactor: decompose tickBody into named phase closures` (`64b4a17`) — `tickBody` is now a ~15-line
  skeleton: load → `resumeApprovedTool`/`handleApprovalRejected` → `enrichCase` → `checkParkGuards`
  (returns `WorkflowResult | null`) → `maybeReopen` → `runAgentLoop`. Each phase is a named closure in
  the Layer scope capturing the resolved services (NO deps-threading), with per-tick `working` shared by
  reference and only the two approval closures taking the narrowed event as a param. Bodies moved
  verbatim;
  (4) `style: reindent` (`386921f`) — AST-derived +2-space reindent of the 6 closure bodies, verified
  `git diff -w` empty (whitespace-only);
  (5) `runAgentLoop` itself split (`6fa2c98` + `6db0ee8`): `handleLlmFailure` (LLM-error
  classification) + `parkForApproval` (approval row/park/email) extracted as always-return closures, then
  `executeToolCall(decision, agent, current, turn)` extracted for the whole tool_call body. Because that
  body mixes `continue`/`return` and reassigns `agent`/`current`, it returns a `{ agent, current, done }`
  protocol (`done` = terminal WorkflowResult or null=continue); `messages`/`seenOrderEmails` stay shared
  by reference. The for-loop is now LLM call → handleLlmFailure → decision dispatch → executeToolCall →
  thread agent/current → max-turns. **Deviation from the "separate files" reading of full
  decomposition:** the stateful phases stay in ONE file as closures (the deps-object rewrite separate
  files would need is high-churn/high-risk on the most critical file); they are clean extraction points
  if a file split is wanted later. See [[project_agent_runtime_decomposition]].
  **Remaining (optional, NOT done):** unify the two handoff paths (decision-level + `agent.handoff`
  pseudo-tool — they differ: the pseudo-tool must push a tool-role result, so not a clean merge); add
  `addRiskFlag` / `transitionWithAudit` micro-helpers (genuine dedup, logic-touching → needs tests).
  Branch NOT merged to `main`. Companion analysis (uncaught edge cases E1–E13 + mermaid diagrams) in
  `docs/agent-runtime-analysis.md` + `docs/diagrams/` (untracked).

- **2026-06-19 — Fixed: IMAP "RE:" replies created DUPLICATE cases instead of threading
  (TDD, branch `feat/supplier-portal`, `pnpm build` green; services+worker+db+tools+providers
  suites green incl. the live-DB integration tests; NOT committed).** Reported by tenant Elva Labs
  (IMAP/SMTP `mail.privateemail.com`): customer replies minted a new case per reply, and the case's
  "email thread" tab couldn't show them. **Root cause:** IMAP has no provider-stable thread id, so a
  case's thread is reconstructed from `threadRootId(msg) = references[0] ?? messageId`
  (`packages/providers/src/imap-smtp.ts:185`) and the case is found by EXACT `threadId` match. Many
  clients reorder/truncate the `References` chain, so `references[0]` is NOT a reliable thread root —
  a reply roots on a different id (often the immediate parent = our own `sa-…@domain` outbound id) →
  exact lookup misses → duplicate case. (Gmail/Outlook are immune — provider-stable `conversationId`.)
  **Fix (user chose DETERMINISTIC-only — message-id index, NO subject net):** new `case_message_ids`
  table (migration `0027`, clean `db:generate` — chain still healthy post-0026) recording the RFC
  Message-ID of BOTH every inbound message we accept AND every outbound reply we send, unique on
  (tenant, message_id), FK→cases ON DELETE CASCADE (redaction cascades, no code change). `InboundMessage`
  now carries `inReplyTo`/`references` (IMAP poll populates from `raw`; Gmail/Outlook leave unset). New
  `CaseRepository.findByMessageIds` + `recordMessageId` (Tag + in-memory Test + Live, ON CONFLICT DO
  NOTHING). Runtime `loadOrCreateByThread`: after an exact-threadId miss, correlate by
  `inboundReplyCandidateIds(payload)` (= In-Reply-To + the WHOLE References chain, deduped, NOT the
  message's own id) → `findByMessageIds` → attach to the existing case (keeping its stored threadId);
  records the inbound id on every accept and the outbound id on every successful
  `conversation.reply`/`ask_customer` (in-loop AND approval-resume legs). Recording both directions is
  what makes a reply that cites only its immediate parent resolve. **New invariant:** every accepted
  inbound + every sent outbound customer message MUST be recorded in the message-id index, and inbound
  case resolution MUST try the index before minting a new case. Tests: runtime regression (reply with a
  divergent derived root + In-Reply-To citing the recorded first message → no duplicate case, both land
  on the original, 2 `event.received`), `inboundReplyCandidateIds` unit, Test+Live repo parity,
  imap-poll header-flow. See [[project_imap_threading_re_fix]].
  - **KNOWN REMAINING GAP (not fixed — needs a decision):** the case "email thread" tab renders via
    live `conversation.fetchThread(caseRoot)`, which for IMAP searches the INBOX by the single root id
    (`imap-smtp.ts:570`). A reply that doesn't cite the root is now correlated to the right case but
    STILL won't appear in that tab (the search can't bridge `root → our Sent sa-… → the reply`). The
    customer's reply IS handled + visible on the case timeline; only the live thread-tab body is
    incomplete. Fixing it means feeding the case's indexed message-ids into `fetchThread` (signature
    change across all connectors) OR transitive INBOX+Sent expansion inside the IMAP connector — a
    separate, larger change deferred pending user sign-off.

- **2026-06-17 — Failed customer-reply DELIVERY is now durable + retriable (6 TDD commits on
  `feat/supplier-portal`, full `ci:local` green at each commit — build + ~1863 tests; dashboard
  `tsc --noEmit` + `next build` verified separately).** Root cause from a live Fly diagnosis (tenant
  Elva Labs, IMAP/SMTP `mail.privateemail.com`): a merchant-approved `conversation.reply` could FAIL
  to send and the case still looked done. Two bugs + the feature the user asked for:
  - **Bug (silent-delivery, in-loop):** when `conversation.reply` ran auto, a send failure was fed
    back to the LLM, which then emitted `final_message` → `case.resolved` — the customer never got the
    reply but the case resolved. **Fixed:** a send failure now parks the case in `human_takeover` and
    ends the tick (never resolves).
  - **Approval-resume failure** previously escalated as a bare `approved_tool_failed` with the draft
    lost. **Fixed:** the approved draft is captured for retry.
  - **Feature — reply-delivery outbox + retry:** new `reply_deliveries` table (migration `0026`,
    hand-authored — see snapshot-chain note below) + store (`reply-delivery-store.ts`); a
    `ReplyDeliveryService` Tag (services) / Live (db); the runtime enqueues the **verbatim draft** on
    any `conversation.reply`/`ask_customer` send failure (both paths) + stamps a `reply_delivery_failed`
    risk flag; a worker cron (`reply-delivery-retry-schedule.ts`, every minute) re-sends due rows via
    the SAME `ConversationService` with exponential backoff (60s base, 30m cap, 6-attempt cap) — **no
    LLM re-run** — and on success **auto-resolves** the case (`human_takeover`→`in_progress`→`resolved`,
    clearing the flag); at the cap it `abandon`s and leaves the case in `human_takeover`. A guard skips
    auto-retry once the case leaves `human_takeover` (a human took it / resolved it) so it never races a
    manual reply. Manual path: `POST /dashboard/cases/:id/retry-send` (gated `cases.retry`, tenant-scoped)
    requeues the row due-now; the dashboard shows a primary **"Retry sending email"** button (distinct
    from "Retry now" = re-run agent) + a result banner + the risk chip. Only **retriable transport**
    failures (`ConversationSendFailed`/`ProviderUnavailable`/`Auth*`) enqueue — a recipient/mailbox
    validation reject still surfaces to the agent as before. **New invariant:** a failed customer-reply
    delivery must NEVER resolve the case — it parks (human*takeover) + persists to the `reply_deliveries`
    outbox for retry. See [[project_reply_delivery_retry]].
    \_Follow-ups:* (a) cancel/skip the pending outbox row when a human hands the case back so a stale
    draft can't auto-send later (partly covered by the human_takeover guard) — NOT built;
    (b) make the manual retry trigger an immediate sweep pass (today it waits ≤60s for the cron) —
    NOT built; (c) ✅ DONE — the failed `tool.invoked` audit row now carries `error: <tag>` via
    `toolFailureAuditDetail` (PII-stripped at the first `:`), so a send failure is debuggable from the
    audit log alone instead of only stdout.
  - **DRIZZLE SNAPSHOT-CHAIN GAP (cleanup follow-up):** `packages/db/migrations/meta/` is missing the
    snapshots for `0009` + `0021`–`0025` (those migrations were hand-authored without running
    `drizzle-kit generate`), so `pnpm db:generate` diffs against the stale `0020` snapshot and emits a
    POLLUTED migration that re-creates already-existing tables. Migration `0026_reply_deliveries.sql`
    was therefore hand-authored to contain ONLY the new table; the full, accurate `0026_snapshot.json`
    WAS kept, which **re-anchors the chain** so the next `generate` is clean. Don't blindly commit a
    `db:generate` output until the chain is healthy — inspect it.

- **2026-06-17 — Diagnosed (no code change) why the Fly worker "fails to send emails":** the worker
  sends BOTH platform/Resend mail (approval links, supplier, account-deletion, connector alerts) AND,
  via the agent runtime, customer replies through the connector. Live Fly findings: outbound SMTP
  egress to `mail.privateemail.com` 465/587/993 WORKS (Fly isn't blocking it); `PLATFORM_MAIL_ENABLED`
  is set to **"false"** so the worker runs the no-op `PlatformMailServiceTest` → every approval/system
  email silently drops; `RESEND_FROM_ADDRESS` is the sandbox `onboarding@resend.dev` (can only mail the
  Resend account owner); `APPROVAL_BASE_URL` still points at the dead Railway api. Customer replies
  mostly send fine when approved — the gap was the failed-delivery handling fixed above. To actually
  send platform mail: `fly secrets set PLATFORM_MAIL_ENABLED=true`, a verified Resend domain in
  `RESEND_FROM_ADDRESS`, and fix `APPROVAL_BASE_URL`. (Also: two admin-token secrets exist —
  `ADMIN_API_TOKEN` + a typo'd `ADMINI_API_TOKEN` — clean up.)

- **2026-06-17 — Fixed: case-detail page crashed on open (Next error boundary, "error reference")
  for any case whose Shopify order has a fulfillment (TDD, branch `feat/supplier-portal`, build +
  312 dashboard tests green; NOT committed).** Symptom: opening a case showed the generic error
  page with a changing `error.digest` (`3494059476`, then `2546464403`). Diagnosis (against the
  DEPLOYED stack, per the user): Fly api (`support-agent-backend`, VERSION 4) returned **200 for
  every** `/dashboard/cases/:id` + `/shopify` request — no backend 5xx — so the throw was a
  render-time exception in the dashboard's Next server (CF Worker `support-agent-dashboard`) while
  rendering a _successful_ 200. `wrangler tail` was too flaky to capture it, so root-caused
  statically. **Root cause:** Path B reads orders over JSON, and `JSON.parse` has no Date type, so
  `ShopifyFulfillment.{updatedAt,estimatedDeliveryAt,deliveredAt}` (typed `Date` in
  `agent-core/shopify.ts`) are ISO **strings** at runtime. `OrderPanel.tsx` called real Date methods
  on them directly — `latestFulfillment` did `b.updatedAt.getTime()` (runs whenever
  `order.fulfillments.length > 0`) and the ETA/Delivered rows did `.toISOString()` — throwing
  `TypeError: … getTime is not a function` / `… toISOString is not a function`. Two distinct
  messages → two distinct Next digests (explains the changing reference). Only fires once an order
  gains a fulfillment, so `71349f04` (no fulfillment) rendered fine while `64ea26d5` (fulfilled)
  crashed. **Fix:** added `asDate(Date|string): Date` to `lib/format.ts` (and routed
  `formatRelativeTime` through it); extracted the throwing logic into pure
  `app/cases/[id]/order-panel-data.ts` (`latestFulfillment` + `fulfillmentDay`) that coerce via
  `asDate`; `OrderPanel` imports them. Regression test `test/order-panel-data.test.ts` feeds ISO
  **strings** (RED reproduced the exact two TypeErrors; GREEN after). Swept the rest of the
  dashboard for the same class — the only other raw-Date-method site (`settings/usage`) already
  hydrates api strings to `Date` first, so OrderPanel was the lone offender. **New invariant:** any
  dashboard render that calls a Date method on an api-sourced field must coerce with `asDate` first
  (Path B delivers `Date`-typed fields as strings). _Follow-up:_ commit (tree is entangled with the
  uncommitted order-identity-gate + reply-dedup edits — needs `git add` of just the dashboard files).

- **2026-06-17 — PROD OUTAGE root-caused + fixed: inbound email created no cases for tenant
  `477168f6` (Elva Labs, org `org_01KV5SQTA1SDNYZ4XSBA9A46HV`) — the worker's conversation-connector
  crons were silently dying every pass (branch `feat/supplier-portal`, build green; NOT yet deployed).**
  Symptom: "cases aren't loading nor created on new messages." Diagnosis path: the live IMAP connection
  (`contact@elvalabs.com` on `mail.privateemail.com`) is **active** in the Railway DB (verified via the
  prod admin API `GET /admin/tenants/:id` on `support-agent-backend.fly.dev`), but its metadata had **no
  `lastUid` cursor and no `connectorHealth` flag** 18h after install — meaning the `imap.poll` cron never
  completed a single pass. Fly worker logs showed the smoking gun: `[imap-poll] pass crashed … _tag:'Die'
… Service not found: ConnectorCredentialStore`, every minute. **Root cause:** the worker `runtimeLayer`
  (`apps/worker/src/bootstrap.ts`) never exposed `ConnectorCredentialStore` at the top level — it was only
  ever `Layer.provide`-d _into_ sub-layers (llm resolver, shopify, conversation router, permissions, …),
  which consumes+hides it. The three conversation-connector crons (`imap-poll`,
  `gmail-watch-renewal`, `graph-subscription-renewal`) all `Effect.provide(…, runtimeLayer)` and require
  `DbClient | ConnectorCredentialStore`; `DbClient` was exposed, `ConnectorCredentialStore` was not → Die
  on every pass → no `message.received` published → no cases. The bug compiled because each cron cast its
  effect `as Effect.Effect<…, never>`, erasing the unmet requirement. **Fix (TDD, compile-time guard):**
  (1) removed the six `as …never` casts (3 crons × main-pass + health-report) so `tsc -b` now enforces the
  layer contract — confirmed RED (`Type 'ConnectorCredentialStore' is not assignable to type 'never'`);
  (2) added `ConnectorCredentialStore` to the `WorkerBootstrap.runtimeLayer` type union and merged
  `connectorStoreForPermissions` (= `ConnectorCredentialStoreLive(keys)` in prod, dev stub otherwise) into
  the `env` layer so it's exposed via `envWithDb` → GREEN. `pnpm build` green; 28 worker cron/bootstrap
  tests pass. Casts were pure type assertions — no runtime behavior change beyond the layer now resolving.
  **New invariant:** the worker's conversation-connector crons must resolve `ConnectorCredentialStore` from
  `runtimeLayer` — never re-introduce an `as Effect<…, never>` cast to silence a missing-layer error.
  **DEPLOYED + VERIFIED 2026-06-17 (commit `8a11170`):** `fly deploy` rolled both api+worker to VERSION 4
  at 12:07Z; worker booted clean, scheduled imap-poll, **zero `Service not found` crashes**. Confirmed live
  on the Railway DB via SSH (`fly ssh console` + a `postgres` one-liner): `imap.poll` now completes every
  pass (no stuck/active jobs) and **seeded `lastUid=491` at 12:19:13Z** on the `contact@elvalabs.com` row —
  the poll connected to `mail.privateemail.com` and advanced state. Note the seed path sets the cursor to
  the CURRENT mailbox top, so only NEW mail (UID > 491) creates cases going forward; pre-existing mail does
  not (by design). **Remaining follow-up:** (c) the silent-skip was invisible for 18h because
  `reportRenewalResultsHealth` ALSO needs the store and Died too — consider a worker boot-time assertion that
  `runtimeLayer` resolves every cron's deps. See [[project_worker_connector_cron_layer_fix]].

- **2026-06-17 — Fixed: a customer reply to a RESOLVED case was silently dropped (TDD, branch
  `feat/supplier-portal`, NOT committed — entangled tree, see below).** Root-caused from a real
  production audit trail (Gmail tenant, case `71349f04`): the case resolved after a gated order-status
  reply; the customer replied again; the agent re-ran, re-drafted `conversation.reply`, but the reply
  was swallowed by the **C2 in-loop idempotency dedup** and the agent gave up with a bare
  `final_message`. Cause: `conversation.reply`'s idempotency key is `input.draftId`, and the
  execution-marker is stored **case-scoped and permanent** (`ToolExecutionStore.find(caseId, callId)`);
  the stateless LLM reused the same `draftId` across the two distinct inbound messages, so tick 2's
  reply matched the marker tick 1 wrote (via the approval-resume leg) → `{deduped:true}`, no audit row,
  no send. The marker only ever needed to guard against a _redelivered_ job, not a genuinely new
  message. **Fix** (`packages/services/src/agent-runtime.ts`): added a per-delivery scope to the marker
  key — `executionKeyFor(tool,input,fallback,scope?)` prefixes the key, new `deliveryScopeFor(event)`
  yields `msg:<messageId>` for inbound mail / `appr:<approvalId>` for approvals / `timer:<id>` /
  `case:<id>`. Scoped at BOTH legs: in-loop (`deliveryScopeFor(event)`) and approval-resume
  (`appr:<approval.id>`). Redelivery still dedups (same discriminator); a new message no longer does.
  **Secondary** (recommended, included): an explicit reopen — `message.received`/`customer.replied` on
  a `resolved` case now transitions `resolved → in_progress` with a `case.reopened` audit before the
  loop, so the reopen is visible and the `final_message` short-circuit (status===resolved) can't swallow
  a genuine re-engagement. **Tests**: 2 new regression tests in
  `apps/worker/test/agent-runtime-recovery.test.ts` (cross-delivery no-dedup → tool re-runs on the 2nd
  message; `case.reopened` audit on reply-to-resolved); updated the 2 existing C2 redelivery tests
  (547/667) to seed the new delivery-scoped keys (still assert redelivery dedup). `pnpm build` green;
  services suite 270/270; recovery file 17/17. New invariant: **the C2 execution marker is
  delivery-scoped** — a marker from one delivery must never dedup a side-effecting tool in another.
  _Residual:_ `supplier.updated` / `case.resumed` / `manual.takeover` fall back to `case:<id>` (no
  per-delivery id on the event) — two of the same on one case could still cross-dedup; follow-up.
  _Entanglement note:_ `agent-runtime.ts` in this working tree ALSO carries the uncommitted
  order-status identity-gate edits, so the file can't be committed in isolation without `git add -p`
  (interactive staging is unavailable here) — left uncommitted for the user to stage/split. _Unrelated
  pre-existing breakage observed:_ the order-identity work added `conversation.ask_customer` to
  `order-status-agent` but did NOT register it in 5 `agent-runtime.e2e.test.ts` order-status/
  merchant.notify tool registries, so those 5 e2e tests fail (`schemasFor` → `Failed`); proven
  independent of this fix by reverting `agent-runtime.ts` to HEAD (they still fail). Needs registering
  `conversationAskCustomer` in those envs as part of completing the order-identity gate.

- **2026-06-16 — Admin console shows the WorkOS org NAME beside the org id (TDD):** the org name lives
  only in WorkOS, so added `makeWorkosOrganizationDirectory` (`GET /organizations/:id` → `name`,
  soft-fails to null) mirroring the existing user directory; wired it through `startServer` opts →
  `buildApp` decoration → `getWorkosOrganizationDirectory(req)`. The admin HTTP handlers enrich their
  responses after the Effect returns (the DB/Effect layer never learns org names): `/admin/tenants`
  resolves unique org ids → names, `/admin/tenants/:id` + `/admin/accounts/:id` resolve the single org.
  New contract fields `AdminTenantSummary.workosOrganizationName`, `AdminTenantDetail.tenant.workosOrganizationName`,
  `AdminAccountDetail.organizationName` (all `string | null`). UI: tenant-list group header shows
  `name + mono id`, tenant-detail "WorkOS org" row + account-page heading/crumb show the name. Falls back
  to the bare id when WorkOS is unconfigured / the lookup fails. `pnpm build` green; directory +
  group-tenants unit tests + admin tenant/account integration tests green.
- **2026-06-16 — Order-status identity gate (branch `feat/supplier-portal`, TDD, build + 707
  affected-package unit tests green; NOT committed).** Closes a cross-customer order-data leak in the
  `where_is_order` flow: a requester writing in from a different email than the order was placed under could
  previously get the order's status (and in `conversation.reply`-auto mode, automatically). Now: a
  `shopify.get_order` whose `email` ≠ the case's runtime-stamped `customerEmail` stamps
  `order_customer_mismatch` + persists `pendingOrderEmail`; the agent (order-status specialist, now holding
  `conversation.ask_customer`) runs a self-serve challenge — asks the customer to confirm the order's email
  — and the runtime (NOT the model) sets `identityVerified` when their reply states it
  (`replyProvesOrderIdentity`). Until verified, `shouldForceReplyApproval` forces `conversation.reply` to
  human approval even under tenant-auto, and the dashboard shows an `order_customer_mismatch` risk chip. The
  legit second-email customer is auto-served after confirming; an attacker can't produce the email so the
  reply stays gated. New pure helpers (`orderCustomerMismatchFlag` / `replyProvesOrderIdentity` /
  `shouldForceReplyApproval`) + `buildInitialMessages` resume directive, all unit-tested. Mirrors the
  refund-scope guard for read-disclosure. See [[project_order_status_identity_gate]]. Follow-up: generalize
  beyond `where_is_order` (any get_order mismatch + reply), and consider a possession-factor (code-to-order-
  email) upgrade over the current knowledge-factor check.
- **2026-06-15 — Supplier portal landed (branch `feat/supplier-portal`, 10 TDD commits, ci:local
  green at every commit — full `pnpm build` + 1785 tests; dashboard `typecheck`+`next build` verified
  separately).** Closes the escalation loop end-to-end: the `missing-package-agent` carrier branch calls
  the new `supplier.escalate` tool (per-agent `allow`) → runtime parks the case in `waiting_for_supplier`
  (producer mirrors `conversation.ask_customer`) → a park guard holds stray events → the supplier logs
  into a walled `/supplier/cases` portal (constrained WorkOS Supplier role; `decideSupplierAuthz` with no
  open-mode bypass; minimal privacy projection — problem/order/ship-to/tracking, no PII) and posts an
  update → `POST /dashboard/supplier/cases/:id/update` records it + flips the case off
  `waiting_for_supplier` + audits in one tx, then publishes `supplier.updated` → `buildInitialMessages`
  injects the fenced note + a rewrite instruction → the agent drafts the gated `conversation.reply`,
  rewriting the note (never verbatim). Supplier notification is a **durable outbox sweep** (worker cron
  off the `notified_at` ledger), not best-effort. Most of the spine (status, event, payloads,
  `PausedWaitingForSupplier`) pre-existed as types — this wired it up. Full detail + resolved decisions +
  deviations + follow-ups in the **✅ LANDED — Supplier portal** section above. NOT yet merged to `main`.
  See [[project_supplier_portal_landed]].

- **2026-06-14 — Dashboard UI polish (5 small fixes on `main`, one commit each, TDD where logic changed):**
  (1) **Today homepage** (`app/page.tsx`) showed raw `conversation.reply` for pending approvals — now
  routed through the existing `toolActionLabel()` ("Send customer reply") like every other approval
  surface; dropped `font-mono`. (`7cad79b`)
  (2) **Low-contrast yellow badges → amber:** the "Need your approval" count tile (homepage) and the
  `waiting_for_approval` status badge (`lib/status-variants.ts`, shows in case header / cases table /
  sidebar) moved from the vivid-yellow `warningBright` (`#eab308`, poor contrast on `#f7f7f7`) to the
  calmer amber `warning` (`#b45309`); updated `status-variants.test.ts`. Sibling yellows still on
  `warningBright` and left alone: `approvalStatusVariant("pending")`, `riskVariant("medium")`. (`53ee681`)
  (3) **Badge pill wrapping:** added `whitespace-nowrap` to the `Badge` base class
  (`components/ui/badge.tsx`) — fixes "Needs approval" wrapping to two lines into a tall oval in narrow
  columns (affects every badge). (`43c692e`)
  (4) **Case Context section** (`app/cases/[id]/page.tsx`) replaced the raw `JSON.stringify` `<pre>` dump
  with a labeled field list. New pure, unit-tested `case-context.ts#buildContextRows` maps the known
  context keys (the closed `case.update_context` schema + runtime-reserved `customerEmail`/`riskFlags`/
  `photoSignals`) to friendly rows/chips, reusing `return-labels` + `riskFlagLabel`; unknown keys are
  humanized (camelCase-aware) as a fallback so nothing is hidden. New `CaseContext` renderer + 11 tests.
  (`fab3e16`)
  (5) **Timeline connector line was discontinuous:** the line is a per-`<li>` `border-l-2` but items were
  spaced with `space-y-3` (margin = outside the border-box → gap at every item). Moved the gap to `pb-3`
  - `last:pb-0` (padding = inside the border) across all three timelines (email / activity / full audit)
    so the line is continuous, spacing + height unchanged. (`535033f`)
    Every commit ran `ci:local` green (full build + 1753 tests).

- **2026-06-14 — Rebranded the dashboard to "Guidezilla":** Sidebar (`apps/dashboard/app/IconRail.tsx`)
  and tab title (`layout.tsx`) now read **Guidezilla** instead of "Support Agent" (the `@support-agent/*`
  package scope is unchanged — those are workspace import names, not branding). Logo is a blue-croc SVG
  the user supplied; co-located in the app tree and rendered via `next/image` static import, matching the
  `_logos/` integration-card convention. Two tonal variants exist: `guidezilla-logo.svg` (blue-on-white)
  and `guidezilla-logo-dark.svg` (white-on-blue), generated as a gradient-preserving inverse along the
  white↔blue line (`#FDFEFE`↔`#0345FC`) so anti-aliased edges survive. The always-dark rail uses the
  **dark** variant on a seamless `#0345FC` tile (per user choice). Favicon: `app/favicon.ico` (64×64),
  rasterized from the SVG via ImageMagick then encoded to `.ico` by **ffmpeg** (ffmpeg has the ICO muxer
  but no SVG decoder). The wordmark uses a local display font, **Climate Crisis** (variable TTF in the app
  tree), loaded with `next/font/local` and exposed as `--font-climate-crisis` so only the brand text
  switches font; applied in the rail via `font-[family-name:var(--font-climate-crisis)] text-lg`. Dashboard
  `tsc --noEmit` + `next build` green. Not committed (current branch is `refactor/api-feature-modules`,
  unrelated).

- **2026-06-14 — Restructured `apps/api/src` into feature modules + thinned `server.ts` (1605 → 139 lines):**
  Took the flat 52-file `apps/api/src/` (every file a sibling) into a layered, feature-first tree.
  Six behavior-preserving commits on branch `refactor/api-feature-modules`, full `ci:local` suite green
  at every commit (1742 passed / 5 skipped, incl. all DB-gated api integration tests). Final layout:
  `src/platform/` (http, schemas, pgboss, **logger** + **app** factory + **context**/`RouteContext`),
  `src/auth/` (dashboard context/auth/authz/jwt/user-id, workos-directory, install-grant, +
  **dashboard-routes** = the shared RBAC-gated `dashboardGet/Post` factory), and ten `src/features/<x>/`
  (shopify, mailbox, dashboard, members, admin, approvals, telegram, account, connect, system). `server.ts`
  - `bootstrap.ts` are the only root files. **Tests co-locate** next to their subject under
    `src/features/<x>/tests/` (decided with the user — cleaner than barrels: a test next to its code imports
    `../handlers.js` directly, so the churn that made barrels tempting evaporates); cross-cutting whole-server
    tests under `src/tests/`. **No barrels.** `server.ts` is now a pure composition root: build app via
    `platform/app.buildApp`, thread `RouteContext{cfg,layer}`, mount `register<X>Routes(app, ctx)` per feature;
    each feature's route table lives in `features/<x>/routes.ts` (verbatim paths/schemas/permissions/order).
    Redundant `shopify-`/`dashboard-` filename prefixes dropped on the way in. Mechanics: a one-off path-aware
    import codemod (`/tmp/api-codemod.mjs`, not committed) recomputed every relative `.js` specifier from a
    per-phase move-map (pure path math, not regex); `tsc -b` + vitest were the oracle. **Config:**
    `apps/api/tsconfig.json` now `exclude`s `src/**/tests/**` (tests stay out of `dist`, matching prior
    behavior); root `vitest.config.ts` include widened with `apps/**/src/**/*.test.ts`.
    **Follow-ups (recorded, not started):** (1) `platform/pgboss.ts` imports domain modules
    (`features/account/deletion`, `features/shopify/policy-import-queue`) for its lazy publishers — split the
    boss singleton (platform) from the per-feature publishers to restore "platform = no domain knowledge";
    (2) `features/admin/account-handlers.ts` still mixes the dashboard `handleDashboardAccountDelete` with
    operator handlers (dashboard/routes imports it cross-feature) — could hoist account-delete to a dashboard
    handler; (3) `features/shopify/handlers` imports `features/account/compliance-redaction` for the GDPR
    webhooks (shopify→account) — acceptable but a candidate for a neutral `features/compliance/`.

- **2026-06-14 — Modularized `apps/api/src/server.ts` (6661 → 1605 lines):** The api god-file
  was split into focused sibling modules; `server.ts` is now the composition root (imports +
  `startServer` route wiring + lifecycle + `ServerHandle`/`redactUrlSecrets`/`loggerConfig`/`main`).
  Handler bodies moved **verbatim** (behavior-preserving) into: `http.ts` (response/request/body/
  cookie/HTML helpers), `dashboard-context.ts` (`runWithDb` + dashboard auth + RBAC guard + legal
  helpers), `pgboss.ts` (the lazy shared pg-boss singleton + `acquireApprovalBoss`/`stopApprovalBoss`
  - the cleanup/policy-import publishers — extracted to break a would-be import cycle and avoid
    duplicate boss caches; `server.ts` `close()` now calls `stopApprovalBoss()`), and per-domain
    `*-handlers.ts`: `dashboard-case`, `account-admin`, `dashboard-settings`, `dashboard-knowledge`,
    `dashboard-connect`, `shopify`, `mailbox`, `approval`, `member-rbac`. Module dep graph is acyclic
    (`dashboard-case→shopify`; `settings→account-admin→connect→shopify`). Drafted in parallel via a
    one-off Workflow, then integrated by hand. Verified: full `pnpm build` green + **all 490 api tests
    pass (52 files, incl. every DB-gated integration test over HTTP)**. `strList` still re-exported from
    `server.ts` for `query-params.test.ts`. No behavior or contract change.

- **2026-06-13 — API unused-symbol cleanup:** Removed behavior-neutral strict-TypeScript
  diagnostics: unused `Effect`, `MemberAccess`, and `ShopifyAppProvisioning` imports, plus the unused
  `cfg` parameter from `resolveDashboardAuth`; marked the common auth wrapper's intentionally retained
  config parameter `_cfg`. Verified with the API strict-unused no-emit check and full `pnpm build`; no
  architecture or behavior change.
- **2026-06-13 — Member RBAC: invite teammates + per-workspace roles (TDD, branch `feat/member-rbac`):**
  Merchants can now invite members and grant scoped access — a support agent who handles cases and
  issues refunds but can't touch integrations, AI provider, agents, account, or the audit log. Design
  pattern (chosen with the user): a CODE permission catalog + merchant-editable ROLES + per-workspace
  member assignments + WorkOS email invitations.
  (1) **`packages/dashboard-contracts`** — new `rbac-permissions.ts` (the buildable catalog:
  `RBAC_PERMISSIONS` / `RbacPermissionId`, 18 ids incl. `refunds.issue` kept SEPARATE from
  `approvals.decide`; `implies` closure so `cases.reply ⇒ cases.view`) + pure `rbac-resolve.ts`
  (`effectivePermissions`, owner ⇒ all) + member/role DTOs. 9 unit tests.
  (2) **`packages/db`** — 4 cascade-from-tenant tables (`roles`, `role_permissions`,
  `member_role_assignments` keyed on the decision-UUID = `x-user-id`, `member_invitations`);
  migration `0024_member_rbac.sql` (+ journal entry, NO snapshot — repo stopped writing them at 0021)
  seeds an Owner role per existing org-owning workspace; plain-DrizzleDb `member-rbac-store.ts` (NOT an
  Effect Tag — the `/dashboard/*` path uses plain db fns; an agent never consults human RBAC).
  `ensureOwnerRole` wired into onboarding + workspace-create. 6 integration tests.
  (3) **`apps/api`** — pure `dashboard-authz.ts` (`decideAuthz`: **open-mode FIRST** so a workspace with
  zero assignments behaves pre-RBAC and existing read flows keep working; then actor-id required; then
  owner/permission). `dashboardGet/Post` gained a `permission?` arg → centralized
  `enforceDashboardPermission` guard (memoizes `authenticateDashboard` on the req so the handler's own
  auth is a cache hit). EVERY `/dashboard/*` route annotated with its permission; refund double-check
  (`refunds.issue`) added on approve when the approval tool is `refund.create`. New endpoints:
  `POST /me/session` (reconcile invite + return access; any member), members/roles/invitations CRUD +
  `permission-catalog` (members.manage). Auto-claim: a member-write while open-mode stamps the actor as
  Owner first, so configuring roles never locks the admin out. `x-user-email` header added. 7 authz
  unit + 3 RBAC integration tests; **all 465 api tests green** (open-mode kept the existing ones passing).
  (4) **`apps/dashboard`** — `getDashboardContext` + tolerant `getShellWorkspaces` now load
  `me/session` permissions; `x-user-email` sent; new `api.*` member/role methods. Nav gating
  (`visibleSettingsGroups`/`hasAnySettingsAccess` + `visiblePrimaryNav`, **fail-open on null** since the
  api is the real boundary) wired into IconRail + SettingsNav. `requirePermission` page guard on
  `/audit` + all admin settings pages (prevents a gated read's 403 → bogus `/onboarding` redirect). New
  `/settings/members` page + server actions (WorkOS `sendInvitation`). 17 new nav-gating assertions;
  dashboard `tsc --noEmit` + `next build` + 273 tests green.
  **Verify:** `pnpm build` green; full `pnpm test` **1694 passed / 5 skipped / 0 failed** with a live DB.
  **Deviations from plan (recorded):** no Effect `MemberRbacService` Tag (plain db fns instead — dead
  abstraction otherwise); org-scoped endpoints (`onboarding`, `workspaces` create/rename/delete,
  `account/delete`) stay RBAC-ungated because they use `authenticateDashboardOrg` (no resolved
  workspace) — workspace/account management is an org-level concern, hidden cosmetically from
  non-admins; low-sensitivity reads (`/settings`, `/shop-currency`, `tenant`, `workspaces`) left ungated.
  **Invariants that must not regress:** open-mode = "zero assignments ⇒ allow" is the lock-out net;
  `refunds.issue` is checked IN ADDITION to `approvals.decide` for `refund.create` approvals;
  permission catalog is code (adding an id = default-deny until a role grants it).
  **Committed + on `main`** (corrected 2026-06-13): despite the entanglement worry above, the work
  landed as five clean per-package commits reachable from `main` — `6fff3ae`
  feat(dashboard-contracts), `c368523` feat(db), `8431ba4` feat(api), `88519be` feat(dashboard),
  `d2ce27c` docs(todo). Working tree is clean; nothing RBAC-related is outstanding to commit.
  **Follow-ups (recorded, not started):** removing a member only drops the local assignment (revokes
  access via enforced mode) — full WorkOS org-membership removal needs the membership id we don't track;
  revoking a pending invite revokes the local row only (WorkOS email auto-expires); multi-member
  _existing_ orgs rely on each member's first-load (single-operator is the common case) — a one-shot
  enumerate-all-WorkOS-members → Owner backfill would harden it; refund-approval e2e not integration-
  tested (covered by the `decideAuthz` unit + the manual flow).
- **2026-06-13 — Shopify connect gated per workspace + truthful connected banner (TDD):** Root-caused the
  "Second Store" mis-connect: with `SHOPIFY_CONNECT_REQUIRES_PROVISIONING` unset and global
  `SHOPIFY_APP_CLIENT_ID/SECRET` set in `apps/api/.env.local`, the deployment runs in SaaS mode, so an
  unprovisioned workspace's Connect fell back to the deployment-wide app (the same custom app the first
  store uses) and the OAuth completed against the DEFAULT workspace (connector row for `1ba5d40a…`
  updated 2026-06-12 23:43, 8 min after "Second Store" was created) — then `?connected=shopify` rendered
  "Shopify connected." purely from the query param while Second Store stayed unconnected. Fixes:
  (1) `GET /dashboard/shopify-app` gained `available`, computed by the SAME `resolveTenantShopifyApp`
  the install path runs (never re-derived from the row), so the button mirrors the authoritative gate;
  (2) `POST /dashboard/connect/shopify` refuses to mint a grant when the workspace has no resolvable app
  (403 `shopify_provisioning_required` / 500 `shopify_app_not_configured`) — a merchant is never sent
  into an OAuth flow that could only run on credentials that aren't their workspace's;
  (3) integrations overview + `[provider]` detail gray the Connect button off `available`, with pilot
  ("Awaiting setup…") vs unconfigured copy (pure `shopifyConnectState`);
  (4) the `?connected=` success banner renders only when THIS workspace actually holds an active row
  (pure `connectedBanner`); otherwise a "didn't end up in this workspace" warning;
  (5) `/connect/[provider]` route + `api.connectUrl` map mint refusals onto the `?error=shopify:<code>`
  banner contract (`lib/connect-denial.ts` — lib never imports from app/). Tests: gate integration file
  4→12 (availability matrix + mint gating incl. gmail-not-blocked), dashboard connect-error 7→20.
  Verified `pnpm build`, dashboard `tsc --noEmit`, full suite 1646 passed / 5 skipped.
  **Env (user applies, not done):** local dev is currently SaaS-mode; for pilot behavior set
  `SHOPIFY_CONNECT_REQUIRES_PROVISIONING=true` AND remove global `SHOPIFY_APP_CLIENT_ID/SECRET`
  (bootstrap refuses the combo), then provision the first workspace's custom app via apps/admin
  (client id/secret + shop `support-agent-test.myshopify.com`) so its webhooks keep verifying.
  **Follow-up (recorded, not started):** in SaaS mode the managed-install re-entry still resolves the
  tenant by shop when the state cookie is lost, so a connect started in one workspace can complete
  against the workspace that owns the shop — the truthful banner now surfaces it, but the grant-bound
  flow could pin the tenant end-to-end instead.
- **2026-06-12 — Integration cards use supplied logo assets (TDD):** Replaced the inline Gmail,
  Google Sheets, and Outlook SVG components in the dashboard's shared integrations metadata with
  `next/image` components backed by the supplied files under
  `apps/dashboard/app/settings/integrations/_logos`; Shopify and generic IMAP remain inline because
  no replacement assets were supplied. Added a structural regression test that requires each branded
  component to import its asset and contain no inline `<svg>`. Verified `pnpm build`, dashboard
  `typecheck`, dashboard production build, and dashboard suite (229 passed). Visual browser verification
  was unavailable because the in-app browser was not available.
- **2026-06-13 — Workspace restored to `main`:** Cleared the interrupted auto-stash restore from detached
  HEAD, switched back to `main`, and popped the newest `On main` auto-stash cleanly. Preserved the older
  `feat/dashboard-branded-confirm-dialog` WIP stash. Verified with `git status --short --branch`,
  `git stash list`, and `pnpm build` (green). No architecture or code behavior change.
- **2026-06-12 — Dashboard copy audit: no internal jargon reaches merchants (TDD where logic changed):**
  Full sweep of `apps/dashboard` user-facing copy. (1) New `lib/labels.ts` (+12 tests) — `caseStatusLabel`
  (`human_takeover` → "With you", `waiting_for_approval` → "Needs approval", …), `approvalStatusLabel`,
  `toolActionLabel` (`conversation.reply` → "Send customer reply", mirrors catalog displayNames — keep in
  sync), `auditActionLabel` (`llm.decision` → "Agent decision", `compliance.*` → "Data & privacy request"),
  `humanizeSlug`; wired into cases list/sidebar/detail (status badges, category, approval tool badges,
  full-audit rows), approvals list/detail (breadcrumb, H1, badges), and the audit page (filters +
  description too). (2) Fallbacks humanized instead of leaking raw codes: `risk-flag-label.ts`,
  `case-timeline.ts` escalation reasons (tests updated first). (3) "tenant" purged from all rendered copy
  (→ workspace/account/you): settings landing+legal+usage+llm+refund-policy+integrations(+detail),
  onboarding, no-access, goodbye, home banner, audit header, approval-detail footer; "LLM provider" →
  "AI provider" everywhere (nav, tiles, breadcrumbs, alerts); `AES-256-GCM`/`connector_connections`/tenant-id
  removed from the llm key help; BYOK/DPA/LLM tile badges → Key/Terms/AI; "registered in the worker",
  "(agent, tool) pair", "OAuth grant/scope set" rewritten; "Tool permissions" → "Permissions" (nav + page);
  case-header "tokens:" → "AI usage: … tokens". (4) Error pass-throughs sanitized: new
  `friendlyConnectDetail` in `connect/imap/connect-plan.ts` (+5 tests) maps raw mail-library errors
  (auth/DNS/conn/TLS) to plain words and DROPS unknown ones — wired into the imap action + form (detail no
  longer rendered font-mono); `/settings/llm` gained a generic alert for unknown `?error=` codes (action
  forwards backend codes the page didn't render). Verified: dashboard vitest 254 green, `pnpm build` +
  dashboard `tsc --noEmit` green. NOTE: edits to `connect/imap/*` + `integrations/_shared.tsx` +
  `imap-connect-plan.test.ts` left UNCOMMITTED — they ride with the in-flight IMAP-discovery/logos WIP in
  those same files. Follow-up: approvals "risk: low" badges kept (plain words); `PROVIDER_LABELS.imap`
  ("IMAP / SMTP") kept as the integrations-card name on purpose.
- **2026-06-16 — IMAP password guidance made provider-aware (TDD):** the connect form stopped
  telling every merchant they need an "app password" — the bug that confused a Namecheap Private
  Email setup, where IMAP/SMTP sign in with the _normal_ mailbox password and the app-password
  picker has no IMAP entry (it's only for 2FA). New `PasswordHint`
  (`regular | app_password | app_password_if_2fa`) on the `settings` variant of `ImapDiscovery`
  (`apps/api/src/features/mailbox/imap-discovery.ts`): per-MX-preset (Namecheap→`app_password_if_2fa`
  - new Namecheap app-password KB URL; Zoho/Fastmail/Yandex→`app_password`; GoDaddy/OVH/IONOS→`regular`),
    ISPDB/guess derive from app-password-URL presence (`hintFromAppPasswordUrl`, guess→`regular`). The
    discover endpoint already returns the discovery object verbatim, so no handler change. Dashboard:
    pure `passwordGuidanceForFailure(discovered)` in `connect/imap/connect-plan.ts` maps the hint to
    accurate failure copy (`regular`→"use your normal mailbox password, not an app password"; `_if_2fa`→
    "only if you've turned on two-factor"; `app_password`→needs one + "Create an app password" link when
    a URL exists). Form relabeled **App password → Password** with a neutral helper; page intro + the
    failure alert now route through the helper. +9 tests (6 discovery, "+" guidance suite of 6 incl.
    fixture). `pnpm build`, dashboard `tsc --noEmit`, api+dashboard vitest 609 passed. NOT committed yet
    / branch `feat/supplier-portal`.
- **2026-06-12 — IMAP connect form simplified to email + app password (TDD):** `/connect/imap` no longer
  shows host/port/security by default — server settings are autodiscovered. New pure
  `apps/api/src/imap-discovery.ts` (29 tests), chain ordered first-hit-wins: (1) OAuth-provider detection —
  gmail/outlook-family addresses AND Google-Workspace/M365 custom domains via MX suffix → "use the OAuth
  connector" alert instead of doomed basic-auth; (2) Mozilla ISPDB
  (`autoconfig.thunderbird.net/v1.1/<domain>`, regex XML parse, %EMAILADDRESS%/%EMAILLOCALPART% username
  resolution, hostname-charset validation on parsed hosts); (3) MX-suffix presets (Zoho per-region,
  PrivateEmail, Fastmail/messagingengine, GoDaddy, Yandex, OVH, IONOS) with app-password help URLs, then
  ISPDB again for the MX host's registrable domain; (4) DNS-existence-checked `imap.|smtp.|mail.<domain>`
  guesses. IO injected (`DiscoveryIo`); live impl + thin handler at authenticated
  `POST /dashboard/connections/imap/discover` (read-only → no legal gate; the only HTTP target is the fixed
  ISPDB host — the merchant-controlled domain is hostname-validated before interpolation, and discovered
  hosts are mere form prefill that still pass the existing verify-before-save). Dashboard: pure
  `app/connect/imap/connect-plan.ts` (8 tests) decides manual vs discover vs oauth vs needs-settings; the
  form's Advanced `<details>` (username/hosts/ports/security, hosts no longer `required`) opens itself —
  prefilled via key-remount — only when detection fails, the section is half-filled, or a discovered login
  fails (that alert names the provider + links "create an app password"). Filling Advanced bypasses
  discovery entirely (escape hatch, incl. deliberate Gmail-via-app-password). Verified live:
  zoho.com→ISPDB, fastmail.com→MX preset (their ISPDB entry 404s — the fallback earning its keep),
  gmail.com→oauth, yahoo.com→ISPDB+help URL. `pnpm build`, dashboard `tsc --noEmit` + `next build`,
  `ci:local` 1609 passed / 5 skipped. Also reworded the integrations-card imap copy in `_shared.tsx`
  (left uncommitted — rides with the in-flight logos WIP touching that file). Follow-ups recorded under
  the universal-email-connectors section.
- **2026-06-12 — Permissions matrix made merchant-facing (TDD):** `/settings/permissions` now
  shows only merchant-configurable actions — rows come from the new pure
  `merchantConfigurableTools(catalog)` in `apps/dashboard/lib/catalog.ts` (tools carrying a
  `tenantControl`), so internal plumbing (`agent.handoff`, lookups, `knowledge.search`,
  `case.update_*`, `merchant.notify`) no longer renders. Rows show `displayName` +
  `displayDescription` (short tenant copy) instead of the raw tool name + agent-facing prompt
  description. Cells show the CURRENT effective permission (`currentToolPermission` over the
  fetched `agentOverrides` rows — the page previously ignored tenant toggles and showed shipped
  defaults); the separate "Default" column is gone. `refund.create` cells link to
  `/settings/refund-policy` instead of a misleading static badge (it's threshold-driven, mirroring
  the agent page's special case). +1 unit test (`merchantConfigurableTools` filter). Verified
  `pnpm build`, dashboard `tsc --noEmit`, dashboard suite 226 passed.
- **2026-06-12 — Shipping consistency check + curated case timeline (TDD):** Three follow-ons to the
  Telegram-notifications slice, same session. (1) **Shipping cross-check** — `general-inquiry-agent`
  now pulls BOTH `shopify.get_store_info` AND `knowledge.search` for shipping-destination questions and
  runs a prompt-level SHIPPING CONSISTENCY CHECK: agreement (or a destination-silent policy doc) →
  answer from store settings (what checkout enforces); contradiction → `merchant.notify` ping stating
  what each source says + asking what customers should be told, AND a draft reply that asserts NEITHER
  claim (just "double-checking shipping coverage") — the human approving the gated draft decides with
  the heads-up in hand. NOTE: this is prompt-enforced, not deterministic; a mechanical
  policy-vs-`shipsToCountries` comparison at import time (mirroring the refund currency-mismatch
  warning) remains a recorded follow-up. (2) **Heads-up content in the audit trail** — the runtime's
  `tool.invoked` row for `merchant.notify` now carries `notify: {title, message, delivered}` (same
  pattern as `refund.recommend`'s output capture). (3) **Curated timeline is the dashboard default** —
  `parseCaseTimelineMode` defaults to `simplified` (`?timeline=full` opts into the raw audit view);
  the view is rebuilt as an allow-list in pure `curatedTimelineEvent`
  (`apps/dashboard/app/cases/[id]/case-timeline.ts`): customer emails in, agent replies out, refund
  recommendations, approval cards (any decision channel — dashboard, email link, telegram link — since
  they share the approval rows), `merchant.notify` heads-ups with their audited content + delivered
  state, and human touchpoints (`case.escalated_to_human` with merchant-friendly reason copy mirroring
  the Telegram copy map, `case.taken_over`, `case.resumed` incl. dashboard*retry, `case.resolved`).
  Hidden on purpose: `agent.handoff`, Shopify/knowledge/tracking lookups, `case.update*\*`,
`llm.decision`, `event.held_human_takeover`, `case.waiting_for_approval`(the approval card carries
that story). Mode buttons relabeled Activity / Email thread / Full audit. Tests: +1 agents prompt,
e2e audit-details assertions, case-timeline 13 (mode default flip + curation rules). Verified`pnpm build`, dashboard `next build`, ci-local green per commit (1568 passed / 5 skipped).
- **2026-06-12 — Merchant Telegram notifications (full slice, TDD):** Channel-neutral
  `MerchantNotificationService` (services Tag + test layer + pure copy builders in
  `merchant-notification.ts`) with Telegram as the first transport — the first realization of the
  master-plan §9 "NotificationService fan-out". (1) **providers:** `TelegramMerchantNotificationLive`
  (plain-text Bot API sendMessage, deliberately NO parse*mode so customer-derived text can't act as
  markup; chat binding = `connector_connections` provider `telegram`, chat id in the encrypted token
  column; migration `0022_telegram_provider` widens the CHECK), `MerchantNotificationNoopLive` for
  botless deploys (delivered:false ≡ "not linked"), shared `TelegramConfig(FromEnv)`. (2) **tool:**
  `merchant.notify` (communicate / allow / external_message, internal — no tenantControl) registered on
  all five specialists with a shared prompt block + 1-turn budget bump: the agent pings the STORE OWNER
  when it's unsure or spots something they should know; never the customer, never pauses the case;
  `delivered:false` tells the model to proceed without retrying. (3) **system emitters** (best-effort
  via `Effect.serviceOption`, always outside SQL txs, never affect tick outcomes): runtime ask-branch
  `approval_requested` ping carrying the SAME signed approve/reject links as the email; every
  agent-driven `human_takeover` park (escalateToHuman, approval-rejected, missing/revoked LLM key,
  dead-letter exhaustion) with merchant-friendly reason copy (`HUMAN_TAKEOVER_REASON_COPY`, unknown
  reasons quoted verbatim); connector-health ok→broken alongside the one-time Resend alert.
  (4) **worker cron** `llm.credits-check` (`30 */6 \* \* _`): each active openrouter BYOK key's balance
from `GET /api/v1/credits`; ONE `llm_credits_low`ping per below-threshold crossing (default $5,`LLM_CREDITS_ALERT_THRESHOLD_USD`); the once-flag lives in connector metadata, is stamped ONLY after
  a \_delivered_ ping (no channel yet → retried next pass) and re-arms on recovery; anthropic/openai
  skipped (no balance API). (5) **api:** `POST /dashboard/connections/telegram` mints a 15-min signed
  t.me deep link (fixed-width binary base64url token ≤64 chars — the dot-separated install-grant format
  doesn't fit /start's charset; same authenticated-mint trust rules); bot webhook
  `POST /webhooks/notifications/telegram` fails closed on `X-Telegram-Bot-API-Secret-Token`, binds the
  sending chat on a valid `/start` (latest link wins — prior chats revoked, one chat per workspace),
  confirms in-chat, acks everything else 2xx; disconnect rides the existing `:provider/disconnect`
  (telegram = imap-style no-op provider-side revoke). (6) **dashboard:** `/settings/notifications`
  under the Connections nav group — generate/open link, connected-chat state, confirm-gated disconnect,
  "what gets sent" copy; `api.connectTelegram` in the api-client. Env (all-or-nothing trio, api +
  worker must match): `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_WEBHOOK_SECRET`; the
  worker Live layer also needs `CREDENTIAL_ENCRYPTION_KEY` (bindings are connector rows). Verified:
  `pnpm build`, dashboard `next build`, full ci-local suite green at every commit (final run 1558
  passed / 5 skipped). ⚠️ **NOT verified live** — needs a real @BotFather bot. Operator setup: create
  bot → set the env trio on api+worker → register the webhook:
  `curl https://api.telegram.org/bot<TOKEN>/setWebhook -d url=https://<api-host>/webhooks/notifications/telegram -d secret_token=<TELEGRAM_WEBHOOK_SECRET>`.
  **Follow-ups (recorded, not started):** Telegram inline approve/reject buttons (callback_query)
  instead of bare links; per-kind notification preferences; Slack as the second channel through the
  same Tag; an email leg for `llm_credits_low`; live end-to-end verification.
- **2026-06-12 — Prompt-injection hardening (5 mitigations, TDD):** Shrank how often an injected
  customer email / poisoned knowledge doc / hostile order field can steer the agent. (1) **Untrusted-content
  framing** — new pure `agent-core/untrusted.ts` (`UNTRUSTED_OPEN/CLOSE` sentinels, `wrapUntrusted` which
  strips forged sentinels so the fence can't be closed early, `UNTRUSTED_PREAMBLE`). `buildSystemPrompt`
  now prefixes the preamble; `buildInitialMessages` fences customer subject+body (and the `case.resumed`
  context dump) while keeping the trusted `[Thread context:…]` header OUTSIDE the fence; `knowledge.search`
  fences each document body (the URL-snapshot path is the spiciest). (2) **L8 already done** in the runtime
  resume path (schema re-decode + policy re-check, audit.md L8 = `[x]`) — added the missing e2e regression
  (manager edits `approvedInput` into an invalid shape → `human_takeover` / `approval_input_invalid`, no
  send). (3) **`case.update_context` locked to a fixed schema** — dropped the open `extra` record so an
  injection can't plant arbitrary keys that re-inject on resume. The ONE genuine `extra` consumer
  (order-status-agent stamping `extra.liveTrackingStatus` = the `tracking.lookup` result) was migrated
  to an explicit, narrowly-typed `liveTrackingStatus` named field (tolerant projection of the tracking
  union; unknown sub-keys stripped at decode) + the agent prompt updated to write `liveTrackingStatus`.
  Rule going forward: a genuinely-needed-but-unsupported key is a signal to add a NAMED field (with tests
  - clear render-back rules), never to reopen a generic `extra`. (4) **Refund scope guard** —
    `refundCustomerMismatchFlag` stamps `refund_customer_mismatch` onto case context (→ ApprovalCard chip)
    when a refund targets an order whose customer ≠ the case's runtime-stamped `customerEmail`; the
    order→email map is built from `shopify.get_order` results in the same tick (no extra Shopify call,
    fails open). (5) **`ask_customer` recipient guard** already present (`assertRecipientsInThread`) — added
    the explicit off-thread-rejection test (it auto-executes, so higher-risk than reply); new
    `risk-flag-label.ts` gives the mismatch flag friendly copy. Tests: +5 agent-core, +5 services messages,
    +2 services prompt, +6 refund-scope helper, +2 case tool, +2 knowledge tool, +2 ask_customer recipient,
    +1 refund-mismatch e2e, +1 L8 e2e, +3 dashboard label. `pnpm build` + dashboard `next build` green; full
    vitest **1207 passed / 266 skipped**. NOTE: framing is a mitigation, not a guarantee — the durable
    defenses remain the tool-permission gates + recipient/scope constraints. Read-scoping of
    `shopify.get_order`/`get_customer` left store-wide on purpose (reads can't exfiltrate past the reply gate;
    refund is the money path and now carries the mismatch flag).
- **2026-06-12 — Structured return-intent capture (small slice):** Applied the "named field, not a generic
  `extra`" rule to its first real case. Returns still route through `refund-review-agent` as `refund_request`,
  but the agent now stamps narrow literal `returnReason` + `requestedResolution` fields (RETURN CAPTURE step)
  instead of prose, PATH A is guarded so a return never auto-refunds, and the dashboard ApprovalCard shows
  "Return" chips. The full dedicated returns capability (own category + agent + `return.create` over Shopify
  reverse-fulfillment + refund-on-receipt) is deferred — see the Phase 5 entry. Details + tests in Phase 5.
- **2026-06-12 — Case category column never written (dashboard showed all "uncategorized"):**
  `case.update_context` wrote the triage `classification` only into the `context` blob, while the dashboard
  chip, the contracts, and the cases-list search filter (`ilike(cases.category, …)`) all read the
  `cases.category` column — whose only writer was the mock seed script (why seeded refund cases looked
  fine). Fix (TDD, `packages/tools/test/case.test.ts`): the tool now mirrors `classification` into
  `category` in the same atomic `repo.update` (absent classification leaves the column untouched), and
  data migration `0021_backfill_case_category` backfills existing rows from `context->>'classification'`
  (applied + verified locally: 141 rows categorized; 2 remaining NULLs have no classification either).
  Decision recorded: keep BOTH copies deliberately — the blob is rendered verbatim into agent prompts
  (`agent-runtime.ts:251`) so specialists see the triage decision; the column serves SQL/UI; the single
  writer keeps them in lockstep. Consolidating to column-only (runtime would inject `category` into
  prompts) is possible later but risks LLM-behavior regressions across five specialists for no
  functional gain.
- **2026-06-12 — Sign-out safe-cone fix (rail WIP):** The uncommitted expand-on-hover rail + two-step
  sign-out confirm uses a clip-path "safe cone" (`lib/cone.ts` → `--cone-x/--cone-y` on the panel's
  `::before`) to bridge the rail→panel gap. The cone juddered and the popover closed mid-travel. Two root
  causes in the heading tracker: (1) **starvation** — the previous-pointer anchor advanced on every
  `pointermove`, so on 120Hz devices (~1px/event at ordinary speeds) the delta never cleared the 2px jitter
  floor and the heading stayed stale forever; (2) **thrash** — when a delta did clear the floor the heading
  snapped 100% to the raw per-event direction (±30–45° noise at 2–4px), swinging the 48px-trailing apex
  wildly, and a single 2px backward twitch flipped the apex 96px ahead → pointer out of cone → spurious
  `mouseleave` close. Fix (TDD, `test/cone.test.ts` 15 tests): `pointerDirection` → `advanceHeading` with
  (a) anchor that only advances when the accumulated move clears `minDelta=3`, (b) distance-weighted
  blending for aligned moves (`blendDelta=16` re-aims fully), (c) a reversal accumulator — opposed (dot<0)
  travel holds the heading until `reverseDelta=12`px accumulate, then snaps, so the _intentional_
  close-on-reversal still fires at any retreat speed but twitches never flip it (a pure LERP can never flip
  on an antiparallel reversal — caught in design review). Also: clip-path fallback apex `50% 50%` → `0% 50%`
  (widest wedge between open and first move), and the S13 sign-out POST guard test re-pointed at
  `SignOutButton.tsx` where the form now lives. The cone's red debug tint was then removed (same session) —
  the pseudo-element is invisible, hit-test-only. Adjacent papercut (not fixed): the 60px cone strip
  overlaps the rail's right edge, so while the confirm is open the wedge can eat hover/clicks on the right
  ~12px of the Settings row until a leftward retreat flips the cone away; shrink `CONE_REACH` if it bothers
  in practice.
- **2026-06-11 — Workspaces (multi-store per account):** A WorkOS org now owns MANY tenant rows — each row is
  one **workspace** with its own Shopify store, mailboxes, LLM key, cases, knowledge, policies. Architecture:
  workspace = tenant row (no new scoping column anywhere; services/runtime/worker/webhook routing untouched).
  (1) db: `tenants_workos_org_unique` relaxed to a plain index (migration 0020); default workspace = oldest
  `(created_at, id)` — `findTenantIdByWorkosOrg`/`tenantByWorkosOrg` now ORDER BY it; new
  `listWorkspacesByWorkosOrg`/`findWorkspaceForOrg`/`createWorkspaceForOrg` (non-idempotent)/
  `renameWorkspaceForOrg`. (2) api: `x-workspace-id` header pins a dashboard request to a workspace via the
  single `authenticateDashboard` change point (400 malformed / 404 foreign — never 403, which the dashboard
  reserves for onboarding; no header → default). New endpoints: GET+POST `/dashboard/workspaces`,
  `:id/rename`, `:id/delete`. Deletion: `deleteTenantAccount` gained `{allowOrgDelete, sendEmail}` +
  `resolveCleanupTargets` — the WorkOS org goes on the cleanup job ONLY when allowed AND it's the org's last
  workspace (fixed a real bug: admin delete of one of two workspaces would have nuked the shared org);
  workspace delete refuses the last workspace (409); account delete sweeps all workspaces newest-first, only
  the final (default) job carries org+email. Create-workspace copies the org's current legal acceptance
  (connector gates keep holding); zero workspaces → 409 use_onboarding. (3) dashboard: `workspace:id` cookie
  (server actions only) validated per-request via pure `pickActiveWorkspace` (stale → default, self-healing);
  `getDashboardContext` returns `{workspaceId, workspaces}` and every api call stamps the header (incl. the
  /api/cases proxies); WorkspaceSwitcher popover in the icon rail; `/workspaces/new`; settings/account split
  into per-workspace delete (>1 workspaces, typed-name confirm) + whole-account delete (copy enumerates all
  workspaces). Also: `call()` gained `on403:"return"` — fixed the dead legal-403 branch in the IMAP connect
  action. (4) admin: tenant list grouped by org (`groupTenantsByOrg`). (5) chore: removed dead
  `resolveTenantByShop` (the no-state auto-create path; both install/callback no-state branches are
  lookup-only). No pg-boss/worker changes needed — `runAccountCleanup` already skips null org/email.
  TDD throughout; verified `pnpm build`, both Next builds, full ci-local suite green at each commit.
  **Follow-ups recorded under "Workspaces follow-ups" below.**
- **2026-06-11 — Email thread isolation + Outlook reply hardening:** Fixed the mailbox/thread routing gap that let the dashboard and runtime guess among multiple connected mailboxes. Cases now carry the exact connected mailbox, `findByThreadId` scopes by `(tenant, provider, mailbox, thread)`, inbox events stamp `mailbox`, and conversation tools fail closed when a case is not mailbox-bound. The dashboard email-thread view now resolves legacy cases conservatively and shows a safe ambiguity state. Separate Outlook-specific fixes landed for the pre-existing self-reply bug: Graph replies now anchor to the latest inbound customer message, the approved `to` list is written back onto the draft, replies to the connected mailbox itself are rejected, and Graph reply drafts are filtered out of thread views so the same draft/sent pair does not render twice. Verified with `pnpm build`, the targeted conversation/provider tests, the DB integration suite for mailbox scoping, and the full local CI run (`1388 passed / 5 skipped`).
- **2026-06-11 — Dashboard "Retry now" (resume + immediate agent tick):** A `human_takeover` case can now be
  re-run by the agent on demand, closing the recovery loop for `max_turns_exceeded` / retries-exhausted
  escalations ("Hand back to agent" only waited for the customer's next message). Three pieces:
  (1) `buildInitialMessages` (now exported) builds a real re-orientation message for `case.resumed` ticks —
  thread id header, trigger, subject, prior `case.update_context` patches, and a fetch_thread instruction
  (previously the agent woke to a bare `(system event: case.resumed)` with no thread id, so it couldn't act).
  (2) `POST /dashboard/cases/:id/retry` (`apps/api/src/case-retry.ts`): `resumeCase` flip first (the §2.95
  guard would hold an event published before the flip), then publish `case.resumed` trigger=`dashboard_retry`
  onto `workflow.events`; publish failure degrades to `resumed_no_tick` (= plain hand-back, never a lost case).
  (3) "Retry now" button + outcome banners on `/cases/:id` next to "Hand back to agent" (api-client `retry`,
  `retryAction`). Tests: message-shape unit tests (services), retry orchestration unit tests (api),
  integration test proving the event lands in `pgboss.job`, runtime e2e for the full `case.resumed` tick.
  Note: cases stranded in `new` by the pre-audit-fix worker can be unstuck with Take over → Retry now.
- **2026-06-11 — Full audit remediation (audit.md):** Fixed 61 of 63 findings from the 2026-06-10 five-area
  audit; see `audit.md` (all boxes ticked except U15/S14) for the per-item list with file references. The
  headline structural changes, since several master-plan claims were previously **unimplemented**:
  (1) C1–C3 at-least-once safety — retryable runtime failures now rethrow so pg-boss actually retries
  (retryLimit was dead code), a dead-letter consumer parks exhausted cases in `human_takeover`, and two new
  tables (`processed_messages`, `tool_executions`) dedupe duplicate webhook ticks and tool re-executions
  (the `(caseId,callId)` / draftId dedup the tool descriptions CLAIMED existed did not — descriptions fixed).
  (2) §10 state machine now real: `isStatusTransitionAllowed` matrix in agent-core, enforced by both repo
  impls; the final_message-over-takeover race holds the case. (3) §4-adjacent: timers are enqueue-then-mark,
  approvals get an expiry + republish maintenance cron (`approval-maintenance-schedule.ts`), and the ask path
  writes approval+park+audit in one tx. (4) Per-case tick serialization via `TransactionRunner.withLock`
  (pg advisory lock) — closes the thread-key vs case-key queue race. (5) Approval links: GET renders a
  confirm page, only POST decides (email-scanner auto-approval), tokens are per-action signed with 24h TTL.
  (6) Graph webhook fails closed + validates clientState before token work; SSRF fetch pins DNS answers;
  IMAP/SMTP require STARTTLS; Gmail MIME rejects header injection; reply recipients constrained to thread
  participants; refund thresholds compare case-cumulative amounts. (7) Connector health: renewal/poll crons
  stamp `connectorHealth` metadata + one-time Resend operator alert on ok→broken (dashboard can render the
  flag — **follow-up: integrations page doesn't read it yet**). (8) Worker builds its layer graph once
  (ManagedRuntime), tool HTTP runs outside the audit tx, `tool.timeout` honored, ciphertext now version-
  prefixed with multi-key decrypt (`decryptWithKeys`) for key rotation.
  **Deferred:** ~~S14 (forwarded-WorkOS-JWT…)~~ DONE 2026-06-13 — see the Audit-follow-ups section;
  U15 (middleware→proxy rename) pending the Next 15/16 decision. **Deviations recorded:** commits land directly on `main` (matching the operator's current
  workflow — the feature branch had already been merged); ~~CREDENTIAL_ENCRYPTION_KEY_PREVIOUS env plumbing
  for the new multi-key decrypt is not yet wired into bootstrap~~ DONE 2026-06-13 (S15 — see the
  Audit-follow-ups section: key set wired through api/worker bootstrap + the three credential stores).
  Verified: full suite 1120 passed (DB-gated integration suites included via ci-local), `pnpm build` green,
  both Next apps build. New worker crons registered in index.ts: approval-maintenance, workflow dead-letter.
- **2026-06-09 — Auto-import shop policies into the knowledge base:** After a tenant connects Shopify, the OAuth
  callback enqueues a best-effort `shopify.policies.import` pg-boss job; the worker reads `shop.shopPolicies`
  (new `ShopifyService.getShopPolicies` Tag + Live impl, GraphQL validated, needs the `read_legal_policies`
  scope — added to `DEFAULT_SHOPIFY_SCOPES` + `shopify.app.toml`), keeps SHIPPING_POLICY + REFUND_POLICY
  (Shopify has **no** RETURN_POLICY — returns live under refund), converts the HTML body to text via `htmlToText`,
  and upserts each as a `url` knowledge doc keyed by the policy URL (dedup via `contentHash`: create / update on
  change / skip if unchanged; never touches merchant-authored docs). Fully silent: a missing scope, no policies,
  or any Shopify/KB error logs + swallows (`runShopifyPolicyImport`), so a successful connect is never broken.
  TDD: 2 provider tests (getShopPolicies) + 8 worker tests (create/filter/no-op/empty/dedup/update/no-overwrite/
  silent). `pnpm build` green. Operator follow-up: add `read_legal_policies` to the app's Dev Dashboard scopes
  (the binding config) or the import silently no-ops. Known tradeoff: stored as `url` docs, so a dashboard
  Resync re-scrapes the storefront (noisier than the API body).
- **2026-06-09 — Custom-distribution install link clarified:** Confirmed the Dev-Dashboard "Generate link" for a
  custom-distribution app is a Shopify-signed, expiring `admin.shopify.com/oauth/install_custom_app?...signature=`
  link (NOT reconstructable by us), while token acquisition stays authorization-code-grant (client-credentials is
  org-owned-stores only). The operator confirmed the dashboard Connect → `/admin/oauth/authorize` route reaches
  the locked store's install screen ("this app is exclusive to your store"), so A4's "build the authorize URL"
  resolution holds for the locked store; the signed link remains an alternative entry. No code change this session.
- **2026-06-09 — Human-takeover guard + resume:** The runtime had no guard for `human_takeover` (the symmetric
  gap to the `waiting_for_approval` park guard): an inbound customer reply on a taken-over case reused the case
  via `findByThreadId` and ran the agent loop, answering over the human. Added runtime section 2.95 — any event on
  a `human_takeover` case records `event.held_human_takeover` and returns the new `PausedForHumanTakeover` result
  without running the agent. Added the resume path so takeover is no longer a one-way door: `resumeCase` (db)
  flips `human_takeover → in_progress` (transition + `case.resumed` audit, no-op if not in takeover), `POST
/dashboard/cases/:id/resume`, api-client `resume`, `resumeAction`, and a "Hand back to agent" button on the case
  page (shown only when `human_takeover`). Resume is a pure status flip — the agent re-engages on the next inbound
  message (the runtime has no message-history replay, so it deliberately doesn't replay the already-seen reply).
  TDD: runtime e2e (held reply, status unchanged, LLM never called) + 3 resume integration tests. `pnpm build`
  green; full suite 1065 passing / 5 skipped.
- **2026-06-09 — Checklist maintenance:** Collapsed 78 verbose session entries into date-grouped summaries;
  detailed implementation and audit records remain in the phase checklist and audit section below.
- **2026-06-09 — Dashboard controls:** Added branded Auto-confirmation, per-agent outward-action controls,
  hidden internal agent details, return-to-page re-auth, multi-select approval filters, persisted 10-row
  pagination, and a branded "?" hint on the home "In progress" tile (clarifies it counts only cases the agent
  is actively handling — new/triaging/in_progress — not ones parked waiting for approval). Recent
  presentational changes still need authenticated pixel verification.
- **2026-06-09 — Refund policy:** Replaced the temporary Always-deny switch with
  `thresholds | always_ask | always_deny`, added a Shopify currency-mismatch warning, and removed the unused
  `alwaysDeny` compatibility shim after confirming the local DB had no legacy rows.
- **2026-06-09 — Knowledge and routing:** Added a tenant-wide, SSRF-guarded knowledge base and internal
  `knowledge.search`; added `general-inquiry-agent` and `shopify.search_products`. General inquiries are
  grounded and ask-first; clear offers/scams resolve without reply. The new agent has not been exercised live.
- **2026-06-09 — Local dev:** Dashboard crashes were diagnosed as Next/Turbopack heap exhaustion. Recovery is to
  clear `apps/dashboard/.next`; use `next dev --webpack` to isolate the issue. Node 26 remains an unproven risk.
- **2026-06-16 — Fly.io backend deploy target (IMAP/SMTP egress):** Railway blocks outbound SMTP
  (587/465), so the IMAP/SMTP connector's `verify()`/send can't reach mail providers there — proven
  live: a Namecheap connect failed with a reachability error on Railway while the same mailbox's
  993/465/587 connect fine from a normal network. Added `deploy/fly/fly.toml` (+ `README.md` runbook)
  to host `apps/api` + `apps/worker` on Fly, which allows outbound SMTP. ONE Fly app, TWO process
  groups (`api` = Fastify public HTTPS on `:4000` w/ `/healthz`; `worker` = pg-boss + crons, no port),
  built from the EXISTING `deploy/railway/Dockerfile`; migrations via `release_command` (so neither
  group migrates at boot; `DEPLOY_ROLE` is unused — the process command IS the role). `fly config
validate` green. Runbook keeps the DB on Railway (public `DATABASE_PUBLIC_URL`) as the fast path,
  bulk-imports secrets from Railway with the host-specific overrides (DATABASE_URL/PORT) called out,
  and documents the custom-domain repoint (replacing the cloudflared tunnel on
  `support-agent-api.nacirianas.com`). Railway stays viable for Gmail/Graph-API tenants (HTTPS, no
  SMTP egress needed). DEPLOYED LIVE 2026-06-16: `support-agent-backend.fly.dev` in `cdg` (1 api after
  scale-down + 1 worker + standby), secrets imported from Railway, DB kept on Railway (public proxy URL
  `…proxy.rlwy.net`), migrate `release_command` green, and SMTP/IMAP egress verified from inside Fly
  (`587/993/465 OK` — the connections Railway refused). Two `fly.toml` fixes during bring-up:
  `[build].dockerfile` resolves relative to the CONFIG dir, so it must be `../railway/Dockerfile`; and `mad`
  is deprecated on Fly → `cdg`. The Fly api authenticates the dashboard correctly because the imported
  `WORKOS_CLIENT_ID` is the prod (KTJ95) one — the local-api 401 mismatch won't recur. REMAINING (later, per
  the user): repoint the dashboard `DASHBOARD_API_BASE_URL` + Shopify/Google callback URLs + `APPROVAL_BASE_URL`
  from Railway to Fly. `deploy/compose/` (Hetzner) remains the documented VPS alternative.
- **2026-06-08 — Dashboard and deploy:** Deployed the pilot API, worker, and authenticated merchant dashboard;
  added the blue/off-white three-column shell, breadcrumbs, a searchable virtualized case switcher, light-mode
  polish, and append-only tenant-authored agent prompts. `apps/admin` remains intentionally undeployed.
- **2026-06-07 — Deployment hardening:** Cleaned environment ownership and redundant startup wrappers, made both
  frontends Cloudflare/OpenNext-buildable, fixed repeated pilot audit findings, and refreshed deploy guidance.
  Railway is the primary backend target; Hetzner Compose remains the documented alternative.
- **2026-06-06 — Pilot audit and operations:** Closed all code-level pilot onboarding findings, including Shopify
  provisioning gates, deterministic secret routing, OAuth revocation, legal sign-up routing, deletion reliability,
  and surviving admin audit records. Remaining work is operational deployment/live testing and per-operator admin
  identity; the shared-password admin model is still the recorded product decision.
- **2026-06-05 — Pilot provisioning:** Added per-tenant operator-provisioned Shopify custom apps and the first
  `apps/admin` console. Pilot and SaaS are now deploy/config variants of this repo, not source branches.
- **2026-06-04 — SaaS and edge cutover:** Added self-service organization provisioning, legal/DPA acceptance, and
  self-service/admin account deletion. Completed Path B: the dashboard is a pure API client suitable for Cloudflare
  Workers, with settings/onboarding reads and writes served by `apps/api`.
- **2026-06-03 — Dashboard API:** Added tenant-scoped dashboard read and write endpoints for cases, approvals,
  audit, events, connectors, usage, Shopify panels, agent overrides, approval decisions, and case takeover.
- **2026-06-02 — API, deploy, and connectors:** Migrated `apps/api` to Fastify with schemas, pino, and OpenAPI;
  added the Hetzner/Docker deploy stack; hardened Shopify OAuth tests; added Gmail unread backfill/mark-read; and
  recorded deployment/distribution decisions later superseded by the single-repo variant model.
- **2026-06-01 — Integrations and evidence:** Added schema-driven supplier-sheet writes and connector Manage pages;
  fixed the WorkOS callback; aligned Shopify scopes/config; and completed damaged-product photo hardening with EXIF,
  perceptual-hash duplicate detection, and product matching.
- **2026-05-29 to 2026-05-30 — Damaged-product and local tooling:** Added the multimodal/R2 photo pipeline,
  `damaged-product-agent`, deterministic mock-case seeding, and app-local env scripts/examples. The Shopify
  submission-readiness review identified gaps that were subsequently resolved or superseded by distribution choices.
- **2026-05-24 to 2026-05-27 — Safety and specialists:** Added `missing-package-agent`, follow-up timers, retention
  sweeps, optional audit PII redaction, per-case token usage, Google Sheets support, and supplier escalation tooling.
- **Through 2026-05-18 — Runtime foundation:** Landed the Effect runtime spine, permission/audit/state-machine
  boundaries, Shopify and Gmail connectors, triage/order/refund workflows, approval links and resume flow, BYOK/model
  routing, tenant-scoped dashboard foundations, live case updates, and the first verified Shopify happy path.

**Latest recorded verification:** `pnpm build` green; recent full-suite runs were green against local Postgres.
No master-plan deviation was introduced by the summarized sessions beyond deviations already recorded in the phase
checklist, audit section, `master-plan.md`, or project memories.

---

## Audit follow-ups (2026-06-11)

Remaining work surfaced by the audit remediation (everything else in `audit.md` is done):

- [x] **S14 — forwarded-WorkOS-JWT auth for apps/api (clean cutover, 2026-06-13).** The shared
      `DASHBOARD_API_TOKEN` + self-asserted `x-org-id`/`x-user-id` are GONE. The dashboard forwards the
      merchant's WorkOS access token (`session.accessToken`) as `Authorization: Bearer <jwt>`; the api
      verifies it (`apps/api/src/dashboard-jwt.ts`, `jose` `createRemoteJWKSet` over WorkOS's
      client-scoped JWKS — RS256 sig + `exp` + optional `iss`) and reads `org_id`→organizationId,
      `sub`→user. `authenticateDashboardToken` derives the manager decision UUID from the verified `sub`
      via the shared `dashboard-user-id.ts` hash (golden-tested = the value the dashboard used to send).
      Verifier built at boot from `cfg.workos` (new `WORKOS_CLIENT_ID`; `DASHBOARD_API_TOKEN` removed
      from config + all env templates), decorated on the Fastify instance, read off `req.server` — no
      handler-signature churn; `authenticateDashboardOrg` is now async. `x-workspace-id` stays a header
      but is validated against the VERIFIED org (so the workspaces trust gap is closed too); `x-user-email`
      stays a low-trust header (see follow-up). Onboarding forwards the post-`switchToOrganization`
      org-scoped token. Tests: +9 verifier, +11 parser, +3 decision-uuid golden; all 12 dashboard
      integration suites migrated to an injected test verifier + synthetic bearer (helper at
      `apps/api/test/support/dashboard-auth.ts`). Verified: `pnpm build` + dashboard `tsc`/`next build`
      green; full suite **1711 passed / 5 skipped** with a live DB.
      **Follow-up — CLOSED 2026-06-13:** the `/me/session` invite-reconcile no longer trusts the
      `x-user-email` header. The api resolves the member's VERIFIED email from WorkOS keyed on the verified
      `sub` (`apps/api/src/workos-directory.ts`, injected like the verifier; `WORKOS_API_KEY` config) and
      reconciles against that. The WorkOS lookup is gated on a pending invite actually existing (no call on
      the common load), fails soft (a hiccup → no reconcile, invite stays pending), and never falls back to
      the header (no key → reconcile no-ops). Regression test: a member (`mallory`) spoofing
      `x-user-email: sam@…` does NOT inherit Sam's pending invite (dashboard-rbac integration). The
      auto-claim Owner email stays a header — it only labels the acting user's own row (cosmetic).
- [x] **Dashboard: render `connectorHealth`** on /settings/integrations (2026-06-13). The data already
      arrived (`ConnectorConnectionView.metadata` carries `connectorHealth`/`connectorHealthReason`/`At`);
      new pure `apps/dashboard/lib/connector-health.ts` parses it from `metadata: unknown` (defaults to ok,
      humanizes the raw reason — no jargon), and the integrations overview + `[provider]` detail badge
      broken connectors with a "needs attention — reconnect" treatment. 13-test helper. Dashboard-only —
      no api/db change.
- [x] **S15 — `CREDENTIAL_ENCRYPTION_KEY_PREVIOUS` wired end-to-end (2026-06-13).** Key rotation is now
      operational. New `parseKeySet(primary, previous?)` + `decryptToStringWithKeys(keys, buf)` in
      `packages/services/src/crypto.ts`. The three credential Live stores
      (`connector-credential-store-live`, `account-openrouter-credential-store-live`,
      `shopify-app-provisioning-live`) now take a key SET (`Buffer | ReadonlyArray<Buffer>`, primary first):
      they ENCRYPT with `keys[0]` and READ via `decryptToStringWithKeys`, so ciphertext written under an old
      key keeps decrypting and each row re-encrypts to the new primary on its next write. Api bootstrap:
      `loadApiConfig` builds `cfg.encryptionKeys = [CREDENTIAL_ENCRYPTION_KEY, ...CREDENTIAL_ENCRYPTION_KEY_PREVIOUS]`
      (comma-separated, trimmed); `cfg.encryptionKey` stays the primary (server.ts re-encrypts grant tokens
      with it). `buildApiLayers` falls back to `[encryptionKey]` when `encryptionKeys` is absent (hand-built
      test configs). Worker bootstrap: exported pure `parseEncryptionKeySet(env)` helper; threads the set
      into the connector/account-openrouter stores and the account-cleanup grant decryption
      (`WorkerBootstrap.credentialEncryptionKeys`, `AccountCleanupOptions.encryptionKeys`). Back-compat
      invariant holds by construction: a length-1 set == today. Env templates updated (api/worker `.env.example`,
      `deploy/compose/.env.example`, `deploy/railway/railway.env.example`) with the rotation how-to (and the
      stale "rotating orphans every credential" comments corrected). Tests: +6 crypto, +3 connector-store
      rotation integration, +2 api bootstrap, +4 worker key-set unit; all existing store/account-cleanup
      tests stay green (call sites updated to the set shape).
- [ ] **U15 — middleware→proxy rename** once the Next 15-vs-16 decision settles (see audit.md U15).
- [ ] **D1 deploy note:** migration 0018's active-mailbox unique index fails if prod already has two
      ACTIVE rows for one mailbox — check before deploying.
- [ ] Consider draftId-based send-dedup inside the Gmail/Graph/IMAP connectors as a second layer under
      the runtime's `tool_executions` markers (C2 is covered; this would also catch cross-case repeats).
- [ ] **Enrich `timer.expired` ticks like `case.resumed`:** the retry work (2026-06-11) gave `case.resumed`
      a real re-orientation message (thread id + prior context); follow-up timer ticks still wake the agent
      with a bare `(system event: timer.expired)` and the same blindness — same fix applies.
- [ ] **Rate-limit keying (S11 structural follow-up):** `@fastify/rate-limit` (`app.ts`) buckets on
      `req.ip` with no `trustProxy` and no `keyGenerator`, so behind a proxy/edge the direct peer IP is the
      proxy's and the limit acts as a near-global cap. The server-side dashboard (`api-client.ts` is
      `server-only`, one egress IP) and provider webhooks (Shopify/Pub-Sub/Graph IP ranges) collapse into
      shared buckets too. `RATE_LIMIT_MAX` (default 600/min) is now documented in `apps/api/.env.example`;
      600 is fine for the pilot but too tight for multi-tenant SaaS. Proper fix: set `trustProxy` and add a
      `keyGenerator` that buckets on real client IP or authenticated identity (org/user from the verified
      JWT) so brute-force protection is per-actor, not per-deployment. Raising the number is only a stopgap.

## Workspaces follow-ups (2026-06-11)

Deliberately deferred when workspaces (multi-store per account) landed:

- [ ] **Per-workspace membership / roles** — decided 2026-06-11: every org member sees every workspace for
      now. A later iteration adds a `workspace_members` table + access checks in `authenticateDashboard` and
      a member-management UI. Until then workspace isolation is a navigation concept, not a permission one.
- [ ] **"Workspace deleted" email template** — workspace-scoped deletes currently send NO email (only the
      account delete's final workspace does). Add a distinct, lighter Resend template for single-workspace
      deletion if merchants ask for a receipt.
- [ ] **Concurrent delete of the last two workspaces** — two simultaneous workspace deletes can each pass
      the `count > 1` check and leave a live zero-workspace org (the user recovers via /onboarding under the
      same org; no data loss). Hardening if it ever matters: take the org-scoped pg advisory lock
      (`TransactionRunner.withLock`) around the count+delete.
- [ ] **`createTenantForOrg` race is no longer index-backed** — onboarding's org-idempotency now rests only
      on its pre-SELECT (the unique index is gone). A two-tab onboarding race can mint two first workspaces;
      harmless (it's just an extra workspace the user can delete), recorded for completeness.
- [ ] **Workspace rename UI** — the api endpoint (`POST /dashboard/workspaces/:id/rename`) exists and is
      tested; the dashboard doesn't surface it yet (names are set at create time). Small settings form when
      needed.

## ⚠️ Pilot pre-onboarding audit (2026-06-06)

**STATUS (2026-06-06 session 5): all code-level findings FIXED — A1, A2, A3,
A4, A6, B1, B2 are resolved (see each checkbox + commit below). The
onboarding-blocking trio A1–A3 and the HIGH B1 are clear, so the code is no
longer the blocker for onboarding a real merchant.** What remains is **A5 + B3
(deploy/infra only)**: the merchant dashboard Worker is deployed but still
awaits its production runtime credentials/live auth smoke test, and `apps/admin`
hasn't been deployed/live-tested behind its required network gate. Don't call
the pilot "deployed end-to-end" until those land.

The two original audits were read-only; the fixes landed in session 5 across
seven TDD commits. Each item below carries its problem, original file:line, and
the fix that shipped. Verified after the fixes: `pnpm build` green, full suite
**769 passing / 5 skipped**, dashboard + admin `next build` green.

### Audit A — pilot provisioning & deploy

- [x] **A1 (HIGH) — Pilot provisioning can be bypassed.** FIXED 2026-06-06 (commit `3b3157d`): the gate is enforced authoritatively at the install/callback resolver (`resolveShopifyAppForTenant` takes `requireProvisioning`); pilot mode with no non-revoked row → 403 `shopify_provisioning_required`, no global fallback. The manage page mirrors the overview's disabled "Awaiting setup" button. The
      `SHOPIFY_CONNECT_REQUIRES_PROVISIONING` gate only guards the dashboard
      _overview_. A merchant can visit the Shopify integration page or hit
      `/shopify/install` directly, which **falls back to the global Shopify app
      credentials** when no provisioning row exists — so an unprovisioned tenant
      can still install against the global app.
      Evidence: `apps/dashboard/app/settings/integrations/[provider]/page.tsx:67`,
      `apps/api/src/shopify-app-resolver.ts:49`, `apps/api/src/server.ts:1619`.
      Fix direction: enforce the provisioning gate at the **install endpoint** and
      the integration page, not just the overview. When the flag is set and there's
      no non-revoked provisioning row, **refuse the install** instead of resolving
      the global fallback app.
- [x] **A2 (HIGH) — Revoking provisioning does not prevent installs.** FIXED 2026-06-06 (commit `3b3157d`): a revoked row is not installable on the OAuth path (403, reason `revoked`); `put()` reactivates a revoked row to `ready` so re-entering creds un-blocks it; the webhook secret path still resolves a revoked row's secret. Revoked
      provisioning rows are still resolved and usable for OAuth, and re-entering
      credentials for a revoked app **preserves `revoked`** instead of
      reactivating.
      Evidence: `apps/api/src/shopify-app-resolver.ts:38`,
      `packages/db/src/shopify-app-provisioning-live.ts:79`.
      Fix direction: the **OAuth/install** resolve path must treat a revoked row as
      not-installable. **GOTCHA — keep the two resolve paths distinct:** a revoked
      row **must still resolve its secret for webhook HMAC verification** (revoked
      apps' compliance/uninstall webhooks must still verify — see
      [[project_pilot_shopify_app_provisioning]]). So block installs, not webhook
      verify. Separately, `put()` should reset status to `ready`/`connected` on
      re-provision so re-entering creds reactivates.
- [x] **A3 (MEDIUM/HIGH) — Shopify webhook secret routing can become
      ambiguous.** FIXED 2026-06-06 (commit `bb188d8`, migration 0012): partial unique index on `shop_domain WHERE status <> 'revoked'`; `getByShop` orders non-revoked-then-newest; `markConnected` clears other rows holding the shop; `put` reactivation clears the stale shop*domain. `shopify_app_provisioning.shop_domain` was **not unique**, but
      webhook resolution selects the \_first* matching row. A shop transferred
      between tenants can leave multiple provisioning rows for the same shop →
      nondeterministic secret selection.
      Evidence: `packages/db/src/schema.ts:301`,
      `packages/db/src/shopify-app-provisioning-live.ts:114`,
      `apps/api/src/tenant-resolver.ts`.
      Fix direction: make shop→row resolution deterministic — e.g. a partial unique
      index on `shop_domain WHERE status != 'revoked'`, and/or prefer the
      `connected` (active) row; reconcile with the shop-transfer path that
      nulls/moves `shop_domain` so stale rows can't shadow the live one.
- [x] **A4 (MEDIUM) — Custom-distribution install URL is not stored.** FIXED 2026-06-06 (commit `fef9040`): the operator can record the store domain at provisioning (`PUT .../shopify-app` optional `shopDomain` + apps/admin form field). It's normalized, recorded on the row, and bound to the tenant via `claimShopifyShopForTenant` (so `tenants.shopify_domain` resolves a no-state callback; 409 if the shop is actively owned elsewhere). With the shop known, the install uses that store's standard OAuth authorize URL instead of the unverified managed-install picker. (Deviation from the original direction: we build the proven authorize URL from the captured shop rather than storing Shopify's generated link.) **UPDATE 2026-06-23: the deviation is now closed — the operator can also paste Shopify's generated store-unique install link (`install_link` column + apps/admin input), and pilot Connect redirects straight to it, taking precedence over the authorize-URL fallback. See the 2026-06-23 session entry.** The
      provisioning model stores credentials but **not** Shopify's generated
      custom-distribution install link; the app builds a generic URL from the
      client id (`buildManagedInstallUrl` → `admin.shopify.com/oauth/install`),
      which is **unproven for a real custom-distribution app**.
      Evidence: `packages/db/src/schema.ts:276`, `apps/api/src/shopify-install.ts:143`.
      Fix direction: this is the install-mechanism design surfaced this session —
      capture the store `shop_domain` + the generated install link at provisioning,
      persist `tenants.shopify_domain` so the no-state callback's `findTenantByShop`
      resolves, and use the stored link instead of the unverified managed-install
      URL. (Custom distribution requires the store domain anyway — see the design
      note in the session log + [[project_pilot_shopify_app_provisioning]].)
- [x] **A5 (MEDIUM) — Full pilot deployment is incomplete.** FIXED (code) 2026-06-07 (commit `0caa9bb`): both front-ends now `cf:build` green on Cloudflare/OpenNext. `apps/admin` was already green. **`apps/dashboard` was unblocked** by going middleware-less (option 2 below, chosen by the user over a Node runtime): Next 16's proxy is Node-only and OpenNext refuses Node middleware, so the proxy was removed and AuthKit reads the session straight from the cookie (`lib/session.ts` `getSession()` — `iron-session` unseal + public `getTokenClaims`). Trade-off: no request-path token refresh (re-auth on access-token expiry). Full writeup in DEPLOY.md "apps/dashboard". **Remaining is operational only:** actually running `cf:deploy` for both front-ends needs the user's Cloudflare account + DNS (`app.<domain>`, admin behind Cloudflare Access). api+worker remain on Railway (`deploy/railway/`).
- [x] **A6 (LOW) — Pure-pilot deploys still require global Shopify creds.** FIXED 2026-06-06 (commit `1b08a05`): in pilot mode (`SHOPIFY_CONNECT_REQUIRES_PROVISIONING=true`) the global `SHOPIFY_APP_CLIENT_ID/SECRET` are not just optional but **disallowed** — `loadApiConfig` fails fast if they're set with the pilot flag (no ambiguous hybrid), and boots fine without them. `globalShopifyApp()` returns null so the resolver fails closed. The
      api can't boot using only per-tenant Shopify credentials.
      Evidence: `apps/api/src/bootstrap.ts:188` (`requireEnv`).
      Fix direction: make `cfg.shopify` optional when
      `SHOPIFY_CONNECT_REQUIRES_PROVISIONING` is set, so a pure-pilot deployment
      with no global app boots on per-tenant provisioning alone. (Already noted as a
      follow-up in [[project_pilot_shopify_app_provisioning]].)

### Audit B — account-deletion / onboarding / admin (the "item 6" follow-up)

- [x] **B1 (HIGH) — External OAuth-grant revocation is not implemented.** FIXED 2026-06-06 (commit `4709a0a`): new `packages/providers/oauth-revocation.ts` (Google token revoke, Shopify app uninstall, Gmail `users.stop`) + `revokeConnectorGrant` dispatcher. The api captures active OAuth grants **before** the wipe and passes them in the `account.cleanup` job with tokens AES-GCM-encrypted under the shared `CREDENTIAL_ENCRYPTION_KEY` (never plaintext in the job table); the worker decrypts + revokes each best-effort before the WorkOS/email steps. LLM BYOK keys excluded.
      Account deletion wipes connector credentials **before** cleanup runs, and the
      cleanup job only deletes the WorkOS org + sends a confirmation email. So
      provider-side, **Google/Gmail grants, Gmail watches, and Shopify
      installations stay active** after deletion.
      Evidence: `apps/worker/src/account-cleanup.ts:38`, `apps/api/src/server.ts:756`.
      Fix direction: capture the tokens/install refs **before** wiping (or revoke
      in the same step) and revoke provider-side during cleanup — Shopify app
      uninstall / token revoke, Google OAuth token revoke, and `users.stop` for the
      Gmail watch.
- [x] **B2 (MEDIUM) — New users aren't reliably routed through `/sign-up`.** FIXED 2026-06-06 (commit `13a45e8`): `getDashboardContext` + `requireOrganization` redirect logged-out users to the legal-gated `/sign-up` (not WorkOS-hosted `/sign-in`); returning users use the "Sign in" link there. The onboarding legal fallback + the api tenant-level connector gate remain the airtight net. The
      legal-gated `/sign-up` exists and the goodbye page links to it, but
      unauthenticated dashboard access still redirects to `/sign-in` (WorkOS-hosted
      sign-in), which **lets a user bypass the custom legal-gated sign-up page**.
      Evidence: `apps/dashboard/app/sign-in/route.ts:19`,
      `apps/dashboard/lib/api-client.ts:163`.
      Fix direction: route unauthenticated users to `/sign-up` (or enforce the
      legal-acceptance gate on the `/sign-in` path) so legal acceptance can't be
      skipped. See [[project_legal_accept_at_signup]].
- [~] **B3 (INFO) — Admin UI is a first version, not deployed/live-tested.**
  PARTIAL 2026-06-06: the admin app now has a verified-green Cloudflare/OpenNext
  deploy config (see A5) and is one `cf:deploy` away from running — but actually
  deploying + live-testing against the api needs the user's Cloudflare account,
  so it's still **not deployed/live-tested**. Known gaps unchanged: shared
  password, no per-operator audit identity, connector health is read-only,
  broader tenant/admin tooling incomplete.
  See [[project_admin_console_scaffold]].

### Re-audit follow-ups (2026-06-06 session 6)

A second pass found the first round's fixes weren't all failure-safe.

- [x] **R1 (HIGH) — deletion-time OAuth revocation not reliable.** FIXED
      (`96ec748`). (a) Capture grants in ANY status, not just `active` — a
      locally-revoked row may still have a live provider grant (`buildConnectorGrants`,
      unit-tested). (b) Worker revocation FAILS the job on a non-`already_gone`
      failure so pg-boss retries; order revoke→org→email keeps the email
      at-most-once. (c) Deletion is now capture → enqueue → **wipe**: a
      connector-read or enqueue failure aborts with 503 before any data is
      destroyed (was: wipe-then-best-effort, no recovery path); the cleanup job
      carries `startAfter` so the worker can't act before the wipe commits.
- [x] **R2 (MEDIUM) — admin tenant deletion left no surviving audit record.**
      FIXED (`790f640`, migration 0013). New platform-scoped `admin_audit_log`
      (no tenant FK) written in the wipe transaction → the deletion record
      outlives the wiped tenant. Actors `admin` / `tenant_self` /
      `shopify-compliance`. Satisfies master-plan §13.
- [~] **R3 (MEDIUM) — admin UI not operationally complete.** PARTIAL. R2 gives
  admin mutations a surviving audit trail, but (i) deploy/live-test still needs
  the user's Cloudflare account (overlaps A5/B3) and (ii) per-operator identity
  is still the **shared-password** model — audit rows record actor `admin`, not
  an individual operator. Both are pre-existing product decisions (shared
  password chosen by the user); moving to per-operator identity (e.g. WorkOS
  operator accounts) is a separate change, not yet scoped.
- [x] **R4 (LOW) — `/sign-up` routing lacked a regression test.** FIXED
      (`3c44ead`). Extracted pure `lib/auth-redirect.ts` + a test asserting
      logged-out → `/sign-up` (never `/sign-in`). `/sign-in` stays available for
      returning users via the explicit link on `/sign-up`.

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
- [x] No secrets in git (real `.env*` files are gitignored; only local
      app/package/deploy `.env.example` templates are committed)
- [x] **Prompt-injection framing holds (2026-06-12):** every system prompt is prefixed with
      `UNTRUSTED_PREAMBLE`, and all attacker-controllable spans reaching the model are wrapped via
      `wrapUntrusted` — inbound customer subject+body and the `case.resumed` context dump (in
      `buildInitialMessages`) and `knowledge.search` document bodies. The trusted `[Thread context:…]` header
      stays OUTSIDE the fence. Don't pass raw customer/tool-result prose into the prompt without fencing it.
- [x] **`case.update_context` stays a closed schema** — no open `extra` / `Record` field. The context blob
      is re-injected verbatim on `case.resumed`, so any new derived fact gets a NAMED field, never an escape
      hatch. (2026-06-12)
- [x] **Refund scope flag** — `refund.create` proposals are checked against the case's runtime-stamped
      `customerEmail`; a mismatch stamps `refund_customer_mismatch` (surfaced on the ApprovalCard). Keep the
      `customerEmail` stamp runtime-controlled (never LLM-writable) or the guard becomes forgeable. (2026-06-12)
- [x] **Order-status disclosure gate (2026-06-16)** — in the `where_is_order` flow, a `shopify.get_order`
      whose customer email ≠ the case's runtime-stamped `customerEmail` stamps `order_customer_mismatch` +
      persists `pendingOrderEmail`. While that flag is set and `identityVerified` is not true, the runtime
      FORCES `conversation.reply` to human approval even if the tenant set it to auto
      (`shouldForceReplyApproval`), so another customer's order is never auto-disclosed. The legit second-email
      customer self-verifies: the agent asks (via `ask_customer`) for the order email, and the runtime — NOT the
      model — sets `identityVerified` when their reply states it (`replyProvesOrderIdentity`). Keep
      `identityVerified` / `pendingOrderEmail` runtime-stamped and OUT of the `case.update_context` allowlist, or
      a prompt-injected reply could forge a pass.
- [x] **Dashboard identity is the VERIFIED WorkOS JWT, never a header (S14, 2026-06-13).** Every
      `/dashboard/*` org + user comes from `authenticateDashboardToken` verifying the forwarded WorkOS access
      token; `x-org-id` and `x-user-id` are not read at all. Don't reintroduce a header-asserted org/user or a
      shared service token. The manager decision UUID is derived from the verified `sub` via
      `dashboard-user-id.ts` — keep that hash byte-identical to the dashboard's copy (golden-tested both sides)
      or existing role assignments / approval attributions silently re-key. `x-workspace-id` must stay
      validated against the verified org.

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
- [x] App/package-local `.env.example` templates document only the variables
      owned by each runtime/tool; deploy aggregates live under `deploy/`, never at
      repo root. Env ownership is enforced by `apps/api/test/env-ownership.test.ts`.
- [x] `docker-compose.dev.yml` for local Postgres 16 (single `postgres` service with healthcheck and named volume)

---

## Phase 1 — Runtime spine

**Goal:** a workflow can move a case through states.

Current next slice: run Postgres-backed integration tests, then close the audit-in-same-transaction invariant.

- [x] `CaseRepository` Tag + `CaseRepositoryLive` (Postgres/Drizzle) + `CaseRepositoryTest` (in-memory). Interface: `create`, `getById`, `findByThreadId`, `update`, `transitionStatus`. Status changes flow only through `transitionStatus`, which writes a `case_state_transitions` row in the same SQL transaction and supports optimistic `expectedFromStatus` checks (→ `CaseStateConflict`). `update`'s patch type excludes `status` at compile time so callers cannot bypass the transition path. Errors: `CaseNotFound`, `CaseStateConflict`, `CaseRepositoryDbError`. Tests: 6 unit (Test layer) + 3 integration (Live + Postgres).
- [x] `AuditLogService` Tag + `AuditLogServiceLive` + `AuditLogServiceTest`. Interface: `record(entry)` returns the persisted row with assigned id + occurredAt, `forCase(caseId, { limit, afterId })` returns ordered entries with cursor-style pagination. Errors: `AuditLogDbError`. Tests: 4 unit + 2 integration. **Note:** the cross-service audit-in-transaction invariant is still pending — it'll be enforced when `AgentRuntime.handleEvent` composes `CaseRepository.transitionStatus` and `AuditLogService.record` inside a single `db.transaction(...)` boundary.
- [x] `EventBus` Tag + Live (pg-boss-backed). Abstract Tag in `packages/services/src/event-bus.ts`; `EventBusFromWorkflowQueue` publishes to `WorkflowQueue`; pg-boss Live in `apps/worker/src/event-bus-live.ts`; unit test covers delegation and Postgres-gated integration test covers publish → consume through pg-boss.
- [x] `WorkflowQueue` Tag + Live. Abstract Tag + in-memory FIFO Test layer in `packages/services/src/workflow-queue.ts`; pg-boss Live in `apps/worker/src/workflow-queue-live.ts` creates a `key_strict_fifo` queue, uses per-event singleton keys (`case:*`, `thread:*`, `order:*`, or `event:*`), revives Date payload fields on consume, and exposes consumer shutdown. Tests: 2 unit + 1 Postgres-gated integration.
- [x] `AgentRegistry` Tag in `agent-core` + `AgentRegistryDefault` (Ref-backed) + `AgentRegistryWith(configs)` (pre-registered). Methods: `register`, `resolve`, `tryResolve`, `all`. Errors: `AgentAlreadyRegistered`, `UnknownAgent`. First real config: `support-triage` in `packages/agents/src/support-triage.ts` — OpenRouter `google/gemini-3.1-flash-lite`, prompt declares 5 categories (`where_is_order`, `missing_package`, `damaged_product`, `refund_request`, `general_inquiry`), tools limited to the Phase 1 trivial set (`case.update_status`, `case.update_context`). 7 + 3 unit tests; defensive assertion locks the tool list until intentionally widened.
- [x] `ToolRegistry` + `defineTool` helper (§8). `defineTool` is a typed-identity helper that preserves `Tool<I, O>` inference. `ToolRegistry` Tag in `agent-core` with default `ToolRegistryDefault` layer (Ref-backed in-memory map) and `ToolRegistryWith(tools)` for pre-registered layers. Methods: `register`, `get`, `tryGet`, `schemasFor` (uses `effect`'s `JSONSchema.make` to derive LLM-facing JSON Schemas from Effect Schemas), `all`. Errors: `ToolAlreadyRegistered`, `UnknownTool`. 10 unit tests.
- [x] `PermissionService` Tag in `agent-core` + `PermissionServiceDefault` layer. Pure function: `check({ tenantId, agent, tool, payload }) → "allow" | "ask" | "deny"`. Decision order is `agent.permissionOverrides[tool.name] ?? tool.defaultPermission`. Tenant-level policy rules and conditional rules (e.g. amount thresholds) are deferred to Phase 4 — the Tag interface stays stable; the Default layer will swap for a Live layer that also consults `PolicyService`. 6 unit tests.
- [x] `ApprovalService` Tag + `ApprovalServiceLive` (Drizzle) + `ApprovalServiceTest`. Interface: `create` (always starts in `pending`), `getById`, `approve` (optionally with `approvedInput` for edit-and-approve), `reject` (with `decisionReason`), `listPending(tenantId)`. State transitions use optimistic concurrency: `approve`/`reject` only succeed if the row is `pending`; double-decision returns `ApprovalStateConflict`. Live impl runs the SELECT-FOR-UPDATE + UPDATE in one tx. Errors: `ApprovalNotFound`, `ApprovalStateConflict`, `ApprovalServiceDbError`. 7 unit + 3 integration tests. Expiry sweep (`timer.expired` driven) is deferred — the `expiresAt` column is written on create, but nothing reads it yet.
- [x] `AgentRuntime.handleEvent` — Phase 1 tick loop from §5 / §18. Supports create/load case for `ticket.created` and case-scoped resume events, resolves agent + tools, calls scripted `LLMService`, audits event/LLM/tool steps, checks `PermissionService` before tool execution, creates approvals for `ask`, executes `allow` tools, handles handoff, final message, and `max_turns_exceeded`. Phase 1 limitations: `email.received` lookup-by-thread and `tracking.changed` lookup-by-order return `Failed`; customer/supplier wait actions return human takeover until those workflows land.
- [x] Trivial tools: `case.update_status`, `case.update_context`. Both defined via `defineTool` in `packages/tools/src/case/`. They depend on `CaseRepository` (provided by the runtime's Layer). `case.update_status` wraps `transitionStatus` (carrying through `expectedFromStatus` + `reason`); `case.update_context` reads + shallow-merges a closed set of named fields, including the explicitly shaped `liveTrackingStatus` projection. There is no open `extra` escape hatch. Repository errors are mapped to `ToolOutputInvalid` with `issues: [<TaggedErrorName>]` at the tool boundary so the LLM gets a structured failure. Tests cover transition behavior, schema decoding, named context merges, unknown-key stripping, case-not-found, and ToolRegistry schema integration.
- [x] Trivial agent: `support-triage` config + scripted runtime test classifies context and updates status using only `case.update_context` / `case.update_status`.
- [x] End-to-end test: scripted synthetic event path in `apps/worker/test/agent-runtime.e2e.test.ts` covers `ticket.created` / `customer.replied` → case → audit entries → `resolved`.

---

## Phase 2 — First real integration

**Goal:** the agent can answer "where is my order?"

- [x] `LLMService` Tag landed early in Phase 1 (`packages/services/src/llm-service.ts`) so `AgentRuntime` can be developed and tested deterministically against a scripted layer. `LLMServiceScripted(decisions[])` pops one decision per call. `LLMServiceFromFn((req, {callIndex}) => ...)` for branching test logic. 4 unit tests.
- [x] `LLMServiceLive` (Vercel AI SDK + OpenRouter) in `packages/providers/src/llm-service-live.ts`. Maps `ToolCallingRequest` → AI SDK `generateText` in single-step mode (the runtime drives the tool-call loop itself). Translates our `ChatMessage` union onto `ModelMessage[]`, wraps each tool's JSON Schema with `jsonSchema()` so the SDK doesn't try to introspect them as Zod, and reads `result.toolCalls[0]` (→ `tool_call`) or `result.text` (→ `final_message`). Error mapping: `statusCode === 429 || ≥500` → `ProviderUnavailable`; "context length" / "maximum context" → `ContextTooLarge`; "safety" / "content policy" / "blocked by" → `SafetyBlocked`; "invalid tool" / "tool_use" → `InvalidToolCall`; everything else → `NetworkError`. Config Tag `LLMConfig` in `packages/services` (interface only); `LLMConfigFromEnv` factory in providers reads `OPENROUTER_API_KEY` (+ optional `OPENROUTER_BASE_URL` / `OPENROUTER_SITE_URL` / `OPENROUTER_SITE_NAME`) and fails the Layer build if the key is missing. 8 unit tests using `vi.mock("ai")` + `vi.mock("@openrouter/ai-sdk-provider")` to assert request mapping + decision mapping + error mapping without any real network call.
- [ ] Fix `packages/providers` `llm:smoke` Layer wiring. The 2026-06-07 env
      cleanup confirmed `packages/providers/.env.local` loads correctly, but the
      command then fails with `Service not found: BlobStorage`; provide the
      package smoke command a suitable BlobStorage layer.
- [x] Wire `LLMServiceLive` + `AgentRuntimeDefault` + all Live repos + (raw) pg-boss consumer into the worker entrypoint. `apps/worker/src/bootstrap.ts` composes the Layer cake: `DbClientLive` → `CaseRepository` / `AuditLogService` / `ApprovalService` / `TransactionRunner` Live → `LLMServiceLive` (over `LLMConfigFromEnv`) → `ShopifyServiceLive` (over `ShopifyHttpLive` + `ShopifyCredentialStoreFromEnv`) → `AgentRegistryWith([supportTriage])` + `ToolRegistryWith([caseUpdate*, shopifyGetOrder])` + `PermissionServiceDefault` → `AgentRuntimeDefault`. The bootstrap exposes `runtimeLayer` (including `AgentRuntime` + every tool-side dep) so tool bodies can yield `CaseRepository` / `ShopifyService` at call time. `apps/worker/src/index.ts` calls `boss.work(workflow.events, ...)` **directly** (not through `WorkflowQueuePgBossLive`) — the Layer-composed consumer hits a known polling-loop flake; raw `work()` is reliable. Each job: revive `DomainEvent` → `Effect.runPromiseExit(AgentRuntime.handleEvent(event))` → log `<eventType> -> <WorkflowResult.type>`. Stale model id in `support-triage` (`anthropic/claude-3.5-sonnet`, retired) caught + swapped to `google/gemini-3-flash-preview`. Prompt tightened so the agent classifies-then-finishes in 2 turns (1 tool call + 1 final_message). Synthetic-event publisher CLI: `apps/worker/scripts/publish-event.ts` (`pnpm --filter @support-agent/worker exec tsx scripts/publish-event.ts --tenant <uuid> --subject ... --body ...`), idempotently upserts the tenant row. **End-to-end smoke** against real Postgres + real OpenRouter (Gemini 3 Flash Preview) green: `ticket.created → resolved` with the full audit chain (`event.received → llm.decision(tool_call) → tool.invoked → llm.decision(final_message) → case.resolved`) and a `new → resolved` row in `case_state_transitions`.
- [x] `ShopifyService` Tag + `ShopifyServiceLive` (GraphQL Admin) + `ShopifyServiceTest`. Methods: `getOrder`, `getCustomer`, `searchByEmail`, `getFulfillment`. Live impl: `fetch` against `/admin/api/${apiVersion}/graphql.json` (single-call per method, full field set returned). Error mapping: 401/403 → `ShopifyAuthFailed`, 429 → `ShopifyRateLimited`, 5xx + GraphQL `errors[]` → `NetworkError`, null `data.order` / null `data.customer` → `OrderNotFound` / `CustomerNotFound`. GID coercion: plain ids auto-wrapped as `gid://shopify/{Order|Customer}/${id}`. Status enum coercion: lowercases Shopify's UPPER_SNAKE display statuses and accepts known values only (falls back to null for unknown). Domain types in `agent-core/src/shopify.ts` (intentionally narrow — not the full Admin schema). Credential store: `ShopifyCredentialStore` Tag in services with `ShopifyCredentialStoreStatic(map)` + `ShopifyCredentialStoreAny(creds)` for tests; `ShopifyCredentialStoreFromEnv` in providers reads `SHOPIFY_TEST_SHOP_DOMAIN` + `SHOPIFY_TEST_ACCESS_TOKEN` (+ optional `SHOPIFY_API_VERSION`, defaults `2025-01`). DB-backed multi-tenant store deferred to a later slice. HTTP indirection via `ShopifyHttp` Tag (`ShopifyHttpLive` wraps `fetch`; `ShopifyHttpFromFn` lets tests pin responses without `vi.stubGlobal`). 11 provider unit tests (all 4 methods + 4 error branches) + 3 tool tests.
- [ ] Commerce-platform agnostic refactor before adding WooCommerce: introduce a provider-neutral `CommerceService` Tag (`getOrder`, `findOrderByName`, `getCustomer`, `searchCustomerByEmail`, fulfillment/tracking as needed), generic domain types (`CommerceOrder`, `CommerceCustomer`, `CommerceFulfillment`), and `commerce.get_order` / `commerce.get_customer` tools. Keep Shopify as the first Live implementation behind that Tag, then add WooCommerce as a second implementation instead of duplicating `WooCommerceService` + `woocommerce.*` tools. Replace Shopify-shaped persistence and context where practical (`cases.shopify_order_id`, `tenants.shopify_domain`, `context.shopifyCustomerId`) with normalized provider references (`provider`, `externalId`, `shopDomain` / `storeUrl`). Widen `connector_connections.provider` beyond `shopify|gmail|outlook` when the second commerce connector lands. Compatibility note: keep existing `shopify.*` tools/types as aliases or migrate agents/tests in one controlled slice so the live Shopify path does not regress.
- **DISTRIBUTION DECISION (2026-06-01, corrected 2026-06-02):** support-agent ships as a **public Shopify OAuth connector with limited visibility / unlisted listing** for scalable multi-merchant installs — a "connect your store → approve scopes" OAuth flow. It is **not** a fully visible App Store launch and should stay non-embedded (`embedded = false`), but current Shopify docs still categorize limited-visibility public apps as App Store-distributed apps with listing/review obligations. The true no-review/no-App-Store route is custom distribution, limited to one store or stores in the same Plus organization, so it is only useful for bespoke pilots. GDPR compliance webhooks (line 128) still apply and are already done. Recorded in memory `project_shopify_oauth_connector_distribution`.
- **BRANCH STRATEGY → SUPERSEDED 2026-06-05.** The two-branch plan is **dropped.** Pilot and SaaS are now **two deploy/config variants of this one repo** — no pilot branch, no second repo; shared features merge to `main` only, and variant differences live in config/layers/`deploy/` (per-tenant credential resolution keys off the `shopify_app_provisioning` row; the dashboard Connect gate keys off `SHOPIFY_CONNECT_REQUIRES_PROVISIONING`). See `AGENTS.md` working-style, `master-plan.md` §19.6, and memory [[project_pilot_is_deploy_variant]] / [[project_pilot_shopify_app_provisioning]]. Original (now-historical) note retained below:
- **BRANCH STRATEGY (2026-06-02, SUPERSEDED — see above):** keep two branches for Shopify distribution work. **Pilot branch:** custom-distribution path, no App Store distribution, Stripe billing only, operator provisions or creates the customer's Shopify store/custom app outside the normal self-serve flow, saves `(tenantId, shopDomain, clientId, encrypted clientSecret, custom install URL, status)` in a pilot provisioning table/config, and the dashboard shows Shopify as "Ready to connect" only after that mapping exists; callback maps `shopDomain -> tenant/app config`, verifies/exchanges with that app secret, then writes the normal `connector_connections` row. **Main/SaaS branch:** scalable public limited-visibility connector path where merchants can self-serve from Settings → Connect Shopify; Shopify remains one connector among Gmail/Sheets/future commerce connectors, and broad launch still needs limited-visibility review/billing requirements resolved.
- **FINDING (2026-06-01) — Claude's Shopify connector is NOT this model.** Decoded the live Claude→Shopify connect URL: it's `admin.shopify.com/oauth/authorize` (account-level identity OAuth, hence the store picker) with **PKCE** (`code_challenge`/`S256`, public client), `redirect_uri=https://setup.shopify.com/oauth/callback`, **`resource=https://setup.shopify.com/mcp`**, `state` JWT → `claude.ai/api/mcp/auth_callback`, `signup_types[]=setup_mcp_claude`, and a broad write-everything scope set. I.e. **Claude acts as an OAuth+MCP _client_ against a Shopify-_hosted_ MCP server** (almost certainly the same server exposed as the `Shopify` tools in the Claude session) — it is NOT a custom Admin-API app. Ours is the opposite: we hold the offline Admin token and call the GraphQL Admin API ourselves, scope-minimal, every tool Permission-gated (§9). The browser flows look alike but the architectures are opposite. So an earlier note calling Claude's connector "the same model" was wrong (corrected above).
- [ ] OPEN DECISION (deferred 2026-06-01, user chose "explain, no code yet"): should support-agent add a **Shopify-MCP connector** (act as MCP client to Shopify's hosted MCP) to replicate Claude's exact UX, OR keep the custom Admin-API app? Trade-offs: MCP-client = less to maintain (no Admin client/webhooks/scope mgmt, Shopify owns data access) BUT external/broad tool surface that doesn't flow through `defineTool`+PermissionService the same way, per-tenant PKCE token handling, and likely needs a Shopify-side arrangement (Claude's `client_id`+`signup_types` look partnership-flavored). Custom app = full control + scope minimization + audit/permission invariants (current path, recommended for an autonomous multi-tenant runtime). See memory `project_shopify_oauth_connector_distribution`.
- [x] Production deploy stack (Hetzner Cloud + Docker Compose) — 2026-06-02. Multi-stage `Dockerfile` (`builder` → `api`/`worker`/`migrate`), `docker-compose.prod.yml` (internal Postgres + one-shot migrate + Caddy auto-TLS), `deploy/Caddyfile`, `deploy/compose/.env.example`, `.dockerignore`, `DEPLOY.md`. Both runtime images verified to build + boot to config validation; `docker compose config` passes. Remaining to actually go live: provision the box, fill `deploy/compose/.env`, run `migrate`, `up -d`, finish the external Shopify/Google callback config (next item), and deploy the dashboard to Workers (Path B box in Phase 3).
- [ ] First real merchant connector launch checklist: replace `shopify.app.toml` placeholders with the production Client ID + public API host, run `shopify app config link` + `shopify app deploy`, set production `SHOPIFY_APP_CLIENT_ID` / `SHOPIFY_APP_CLIENT_SECRET` / `SHOPIFY_APP_CALLBACK_URL` / `DASHBOARD_BASE_URL` / `DASHBOARD_API_BASE_URL`, confirm current Shopify limited-visibility review/billing requirements, confirm `/legal/data-processing` is linked from the production dashboard/API origin, and smoke-test dashboard Connect/Reconnect for Shopify + Gmail + Google Sheets against a real store/mailbox. The lightweight data-processing notice + DPA acceptance gate are implemented and tracked in the Production-gap boxes below.
- [ ] Stripe billing decision for Shopify installs: product direction is third-party billing through Stripe, owned by support-agent outside Shopify. For scalable public limited-visibility distribution, confirm/request Shopify permission or a billing exemption before launch because current Shopify docs require Shopify-provided billing for App-Store-published apps; custom distribution avoids Shopify billing but only supports one store or stores in the same Plus organization.
- [x] Post-connect redirect lands the merchant back in the dashboard (2026-06-01). New `DASHBOARD_BASE_URL` config in `apps/api/src/bootstrap.ts`; pure `dashboardConnectRedirect()` helper in `apps/api/src/post-connect-redirect.ts` (5 unit tests) builds `{DASHBOARD_BASE_URL}/settings/integrations?connected=<provider>[&shop=…]`, wired into BOTH the Shopify and Google OAuth callbacks in `server.ts`. When `DASHBOARD_BASE_URL` is unset the old `/installed` landing page is preserved unchanged. The dashboard integrations page shows a `?connected=<provider>` success banner. This closes the only real gap vs Claude's flow on the custom-app path (the store-picker + Shopify consent screen were never gaps — see the FINDING above). Set `DASHBOARD_BASE_URL` in the apps/api env to enable.
- [ ] Shopify connector scope minimization for limited-visibility launch: keep MVP scopes tight. Today's set is `read_orders, read_customers, read_products, write_orders` (each justified by a live tool — see line 126). Treat `read_all_orders` as optional and only request it if we need orders older than Shopify's default 60-day window; if added, document the support-use justification.
- [ ] Shopify protected customer data minimization for limited-visibility launch: keep GraphQL field selection to what a workflow actually uses. Nuance discovered 2026-06-01: the dashboard customer panel already surfaces phone/address/spend, so this isn't a clean "Email + Name only" trim — it's a deliberate decision to either justify those fields or drop them from the panel. Revisit when tightening the connector, not before. (Distribution/review nuance for PCD clarified 2026-06-06 — see the per-app provisioning item below + `docs/shopify-pcd.md`.)
- [x] **Per-tenant Shopify app provisioning — capture the PCD + distribution step (Custom distribution, pilot).** Clarified 2026-06-06: Custom-distribution apps need **no review** and PCD is "always available", but each provisioned app still requires two **Dashboard-only** settings: (a) set the app's **distribution = Custom** (not Public/unlisted), and (b) **declare the PCD fields** (name + email + address, not phone) in Apps → API access → Protected customer data, or the connected live store returns orders with those customer fields **redacted/null** (silently breaks `shopify.get_order`-based flows). **Built 2026-06-06:** (1) the `apps/admin` tenant provisioning page now shows a per-app **Dev Dashboard checklist** (Custom distribution + declare PCD fields + run the check), and (2) a live **"Run PCD check"** button → `POST /admin/tenants/:id/shopify-app/pcd-check` → `checkAdminShopifyAppPcd` reads a few recent orders via the tenant's connected store and reports `present` / `redacted` / `no_orders` / `not_connected`. New `ShopifyService.listRecentOrderPiiPresence` returns **presence booleans only** (no PII crosses the boundary); verdict anchors on customer email. TDD: +3 Live-impl mapping, +4 pure `summarizeOrderPii`, +6 api integration (Effect-level verdicts via `ShopifyServiceTest` + HTTP not_connected/auth via real server), +3 admin-api wiring. Note: Custom distribution also can't use the Shopify Billing API (billing is Stripe/support-agent by decision — already tracked) and is limited to one store / one Plus org per app.
- [x] Shopify data-handling / privacy note for limited-visibility launch — implemented 2026-06-04. Public `GET /legal/data-processing` covers purpose, fields collected, retention, subprocessors, security, and access/deletion handling; `docs/shopify-pcd.md` carries the internal note/status. The DPA acceptance gate is paired with it in onboarding and Settings -> Legal before connector credentials can be persisted.
- [x] Shopify app config — `shopify.app.toml` at repo root (2026-06-01). This is the **OAuth-connector** app config (`shopify app config link` / `deploy` pushes it to the Partner Dashboard) for the limited-visibility public app path. Declares `name`/`handle`, `application_url=/installed`, `embedded=false` (permanent — see distribution decision above), `[access_scopes].scopes` (read_orders/read_customers/read_products/write_orders), `[auth].redirect_urls=/shopify/auth/callback`, `[webhooks].api_version="2026-04"`, the `app/uninstalled` subscription, and `[webhooks.privacy_compliance]` wiring the three GDPR handlers (`customer_data_request_url` / `customer_deletion_url` / `shop_deletion_url`). **External finalization (can't be done from the repo):** set the real `client_id` + public host (placeholders `REPLACE_WITH_SHOPIFY_CLIENT_ID` / `https://your-app-domain.example`), then `shopify app config link` + `shopify app deploy`.
- [DROPPED] ~~Shopify embedded-admin readiness~~ — NOT NEEDED under the OAuth-connector distribution decision (2026-06-01). The app is intentionally non-embedded; the standalone OAuth flow + the WorkOS-authenticated dashboard are the merchant surface. App Bridge / session-token auth / frame embedding only matter for App-Store-listed embedded apps. `/installed` stays a simple post-install landing page.
- [x] Shopify scope alignment — DONE 2026-06-01. Added `read_products` to `apps/api/src/bootstrap.ts:DEFAULT_SHOPIFY_SCOPES` (now `read_orders, read_customers, read_products, write_orders`) + the tool→scope doc comment, and to `shopify.app.toml`'s `[access_scopes]`. New `DEFAULT_SHOPIFY_SCOPES` bootstrap test asserts every Shopify tool's required scope is covered (would have caught this gap; guards future scoped tools). `read_all_orders` intentionally still NOT requested (no >60-day lookup requirement yet).
- [ ] Shopify limited-visibility listing/legal/billing readiness: confirm the current listing, review, and billing obligations for a limited-visibility public app before first non-pilot merchant install. This supersedes the 2026-06-01 assumption that "unlisted" meant no listing/review path. Billing owner is Stripe/support-agent by product decision, so the Shopify action is specifically to verify exemption/eligibility or adjust distribution.
- [x] Shopify mandatory compliance webhooks: three handlers in `apps/api/src/server.ts` (`POST /webhooks/shopify/customers/data_request`, `/customers/redact`, `/shop/redact`). All three share a `verifyComplianceWebhook` scaffold that re-uses `verifyShopifyWebhookHmac` + `readRawBody` + `findTenantByShop`. Bad sig → 401, missing headers → 400, oversized body → 413, unknown shop → 200 no-op (Shopify mustn't retry-storm). On HMAC pass: `data_request` writes a paper-trail row to `audit_log` (`action="compliance.data_request"`, `actor_type="system"`, `actor_id="shopify-compliance"`, details = customer email + shopify id + data_request id + orders + random `traceId`) — fulfilment is manual within the 30-day window; `customers/redact` calls `redactCustomer` (matches cases by `context.customerEmail` OR `context.shopifyCustomerId` GID form or numeric-string form, then drops their approvals → audit rows → cases (cascades to state transitions) inside one tx); `shop/redact` calls `redactShop` (drops approvals → cases → audit_log → connector_connections → tenant in FK-safe order, all in one tx). Helpers live in `apps/api/src/compliance-redaction.ts` so the same `redactShop` is reusable from a future retention-sweep cron. 9 new tests: 3 parser-shape (`parseCustomersDataRequest`, `parseCustomersRedact`, `parseShopRedact`) × 2-3 cases each covering happy + malformed + type-coercion paths. **Limitation:** the customer-match query only catches cases stamped after the customer-ID slice landed (2026-05-17); pre-existing cases need a manual sweep — acceptable because no real merchant traffic has run yet.
- [x] Shopify `app/uninstalled` webhook: `POST /webhooks/shopify/app/uninstalled` in `apps/api/src/server.ts`. Verifies the Shopify webhook HMAC (new `verifyShopifyWebhookHmac` in `packages/services/src/hmac.ts` — sha256 over raw bytes, base64 in `X-Shopify-Hmac-Sha256`, signed with `client_secret`). Body is read via `apps/api/src/shopify-webhook.ts:readRawBody` (1 MiB cap, byte-exact — no JSON re-encoding before HMAC). Looks up the tenant by header shop domain via new `findTenantByShop` (no-op on miss — webhooks must NOT mint tenants), then calls `ConnectorCredentialStore.revoke(tenantId, "shopify", shop)`. Always returns 200 after a valid HMAC so Shopify doesn't retry storm; bad HMAC → 401; missing headers → 400; oversized body → 413. Idempotent: a second uninstall for an already-revoked row re-sets `revokedAt` and returns 200 again. Tests: 5 unit (HMAC verifier) + 8 unit (`readRawBody`, `parseUninstallPayload`) + 5 integration (happy path, bad sig, unknown shop, idempotent re-run, missing headers).
- [x] `ConversationService` Tag: provider-neutral thread/message/reply interface (`packages/services/src/conversation-service.ts`). Methods: `fetchThread(tenantId, threadId) → ConversationThread`, `reply(tenantId, ConversationReply) → SentMessage`, `askCustomer(tenantId, AskCustomerDraft) → SentMessage`. Domain types live in `packages/agent-core/src/conversation.ts` (`ConversationThread`, `ConversationMessage`, `ConversationReply`, `SentMessage`, `AskCustomerDraft`, `MessageParticipant`, tagged errors `ThreadNotFound` / `ConversationAuthMissing` / `ConversationAuthFailed` / `ConversationProviderUnavailable` / `ConversationSendFailed`). `InboundMessage` + `OutboundMessageDraft` + `MessageAttachment` in `packages/agent-core/src/payloads.ts` (renamed from `InboundEmail` / `OutboundEmailDraft` / `EmailAttachment`); event `email.received` renamed to `message.received` everywhere (agent-runtime, workflow-queue keying, queue-live revival, integration tests). `ConversationServiceTest` + `makeConversationServiceTest({ now, mintId })` in-memory layer for tests; the handle exposes a `sent` array recording every `reply` / `askCustomer` call so tests can assert send shape without a real connector. Worker bootstrap wires `ConversationServiceTest({})` as a placeholder — the **only** spot a real connector Layer (Gmail, Outlook, IMAP, helpdesk) plugs in. NO Gmail / Outlook / IMAP implementation in this slice — the contract was shipped first to keep the agent surface connector-agnostic per master-plan §16 + CLAUDE.md invariant. 5 unit tests for the Test layer + 7 unit tests for the three tools below.
- [x] `ConnectorCredentialStore` / tenant connection model: encrypted per-tenant credentials. `connector_connections` table (`tenant_id`, `provider`, `shop_domain`, `access_token_encrypted` bytea (iv ‖ gcm_tag ‖ ciphertext), `scopes` text[], `api_version`, `status` ∈ {active, revoked}, `installed_at`, `revoked_at`, `updated_at`, UNIQUE(tenant_id, provider, shop_domain), partial index on active rows). Tag in `packages/services/src/connector-credential-store.ts` with `put` (upsert that clears `revoked_at`), `get` (returns `ConnectorRevoked` for revoked rows so callers fail loudly), `revoke`, `listForTenant`; Test Layer (in-memory, plaintext) for unit tests. Live in `packages/db/src/connector-credential-store-live.ts` — AES-256-GCM via `packages/services/src/crypto.ts`, key read at Layer-build time from `CREDENTIAL_ENCRYPTION_KEY`. `ShopifyCredentialStoreFromConnector` adapter in providers resolves the existing Shopify Tag over this store, mapping every connector-side error to `ShopifyAuthMissing` at the boundary. Worker bootstrap picks connector-backed Layer when the encryption key is set, falls back to `ShopifyCredentialStoreFromEnv` otherwise — single-tenant dev still works. Tests: 7 crypto + 5 Test-layer + 6 Live integration (including the "ciphertext does NOT contain plaintext" check) + 22 in apps/api (install URL, state signing, HMAC scheme, callback HMAC verification, code→token exchange, full HTTP roundtrip with real DB write). Deferred: `mode` discriminator (`managed_oauth` vs `tenant_oauth_client` vs `static_token` vs `api_key`) and `billing_owner` — current schema implicitly assumes `managed_oauth`; widen when the second mode lands.
- [x] Public HTTPS endpoint for the install + callback via Cloudflare Tunnel. `cloudflared/config.yml` + `cloudflared/README.md` document the tunnel `support-agent-api` (id `52265c89-…`), DNS `support-agent-api.nacirianas.com → <tunnel>.cfargotunnel.com`, ingress to `http://localhost:4000`. Single-level subdomain — multi-level (`api.support-agent.nacirianas.com`) needed a paid Advanced Certificate so we flipped to the flat name; orphan CNAME at the multi-level name is harmless and can be deleted via the Cloudflare dashboard. `loadApiConfig` rejects non-`https://` callback URLs unless `NODE_ENV=test` or `ALLOW_HTTP_CALLBACK=1` so a misconfigured boot fails fast instead of surfacing as a confusing Partner Dashboard rejection. 4 unit tests on the check.
- [x] Managed Shopify install + OAuth callback in `apps/api`. Pure helpers in `apps/api/src/shopify-install.ts` (shop-domain regex, signed-state encoding, install-URL builder, Shopify canonical-query HMAC) and `apps/api/src/shopify-callback.ts` (`exchangeCodeForToken`). `apps/api/src/server.ts` is a thin `node:http` server (no framework dep yet — swap to Fastify when the REST/command surface expands beyond the webhook/OAuth/approval edge) exposing `GET /shopify/install?shop=...&tenant=...`, `GET /shopify/auth/callback`, and `/healthz`. Install URL composition wires `SHOPIFY_APP_CLIENT_ID` + `SHOPIFY_APP_CALLBACK_URL`; access scopes are configured in Shopify's app settings, not duplicated in local env. `GET /shopify/install` also accepts Shopify's signed initial install/app-launch request (`hmac`, `shop`, `host`, `timestamp`) without a tenant, verifies HMAC, auto-resolves the tenant by shop, then redirects to OAuth. Callback verifies HMAC (Shopify scheme: sorted canonical query minus `hmac`/`signature`, HMAC-SHA256 with `client_secret`); if `state` is present it must verify (else 401, tampered); if `state` is absent (Shopify Custom Distribution path), `resolveTenantByShop(shop)` looks up an existing tenant by `tenants.shopify_domain` or auto-creates one (partial unique index `tenants_shopify_domain_unique` + `ON CONFLICT DO NOTHING` keeps the upsert race-safe). Then exchanges the code for an offline access token and persists via `ConnectorCredentialStore.put`. Per-merchant Partner Dashboard config is the only piece outside this repo. Returns JSON on success; the dashboard will swap that for a redirect once it exists.
- [x] `GmailConversationLive` (`packages/providers/src/gmail-conversation-live.ts`) — Google OAuth install at `GET /google/install` → `GET /google/auth/callback` in `apps/api/src/server.ts` (state-signed tenant binding; scopes `gmail.readonly` + `gmail.send` + `gmail.modify` + `userinfo.email`; `prompt=consent` forces refresh-token issuance). Tokens stored via the extended `ConnectorCredentialStore.put` (new `refresh_token_encrypted` + `token_expires_at` columns from migration `0003_gmail_oauth_columns.sql`). After install, `users.watch` registers against `GMAIL_PUBSUB_TOPIC`; returned `historyId`+`expiration` go into the new `metadata` jsonb column via `patchMetadata`. Pub/Sub push lands at `POST /webhooks/conversations/gmail/:tenantId?token=<shared-secret>` (`GMAIL_PUSH_TOKEN`, constant-time compare); `apps/api/src/gmail-webhook.ts` parses the envelope, refreshes the access token if expired (`patchTokens`), calls `users.history.list` from the stored cursor, fetches each new INBOX message, normalises via `gmail-http.ts:toInboundMessage`, and publishes `message.received` onto pg-boss `workflow.events`. The Live `ConversationService` wraps `gmail-http.ts` (`gmailGetThread` / `gmailSendMessage` / `buildGmailMime` for RFC 5322 with `In-Reply-To`/`References` for proper threading) in Effect; HTTP errors map to `ConversationAuthFailed` / `ConversationProviderUnavailable` / `ConversationSendFailed` / `ThreadNotFound`. Worker bootstrap auto-swaps the placeholder `ConversationServiceTest` for `GmailConversationLive` when `CREDENTIAL_ENCRYPTION_KEY` + `GOOGLE_OAUTH_CLIENT_ID` + `GOOGLE_OAUTH_CLIENT_SECRET` are set. 20 new tests (`apps/api/test/google-install.test.ts`, `apps/api/test/gmail-webhook.test.ts`, `packages/providers/test/gmail-http.test.ts`, `packages/providers/test/gmail-conversation-live.test.ts`). **Connector-neutral invariant held — zero changes to agents / runtime / tools.** Outstanding (separate boxes below): runtime wiring of `message.received → findByThreadId` (today the event lands in pg-boss but the runtime returns `Failed` for non-`ticket.created` cases); watch-renewal cron before the 7-day Pub/Sub lease expires; full-mailbox reseed path for `startHistoryId>7d` (today it logs + bails). Microsoft Graph, IMAP/SMTP, and helpdesk providers come later via the same `ConversationService` Tag.
- [x] Customer identification on case create: when `loadOrCreateByThread` creates a fresh case for a `message.received` event, the runtime now fires `ShopifyService.searchByEmail(tenantId, payload.from.email)` via `Effect.either` and patches `cases.context` with `customerEmail` (always, when we have one) and `shopifyCustomerId` (only on a positive Shopify match). The call is best-effort — Shopify failures, no-Shopify-connector, and no-match cases all leave the tick proceeding normally. Skips entirely on the resume path (case already exists) so we don't burn API quota re-resolving on every reply. Specialists like a future refund-review agent read the stamped fields straight from the case row instead of firing their own per-tick lookup. 2 new e2e tests in `agent-runtime.e2e.test.ts`: positive match stamps both fields; no-match stamps `customerEmail` only and leaves `shopifyCustomerId` undefined.
- [x] Runtime wiring: `AgentRuntime.handleEvent` now resolves `message.received` via a new `loadOrCreateByThread` lookup variant in `packages/services/src/agent-runtime.ts` — calls `CaseRepository.findByThreadId(tenantId, threadId)`, on miss creates a case bound to the thread (channel=email, agent=support-triage, `threadId` persisted). `buildInitialMessages` projects the inbound message body as the turn-0 user prompt (same shape as `ticket.created`). The full tx (load/create + `event.received` audit) stays atomic. **Pub/Sub at-least-once safety:** duplicate `message.received` deliveries find the same case and just append another tick; audit shows multiple `event.received` rows but only one case row exists per thread. 2 new e2e tests (`apps/worker/test/agent-runtime.e2e.test.ts`): cold-create on first message + warm-resume on second message with identical thread (asserts the dedup invariant). `ConversationService.fetchThread`-seeded context is deferred — useful but not load-bearing today; the LLM gets the body inline. Outstanding: customer-side identification (set `customer_id`/`shopify_customer_id` from `payload.from.email`) is still null; a customer-resolution slice lands when the refund-review specialist is wired.
- [x] Gmail watch-renewal cron: `apps/worker/src/gmail-watch-renewal.ts` + `gmail-watch-renewal-schedule.ts`. `boss.schedule("gmail.watch-renewal", "0 */6 * * *")` fires every 6h; each pass walks `connector_connections` where `provider='gmail' AND status='active'`, renews any row whose `metadata.watchExpiresAt` is within 24h (or missing) by refreshing the access token if expired then re-calling `users.watch` and patching the metadata. 24h renewal window × 6h cadence = 4 retry windows inside the lease, so a single missed run can't lose the lease. Per-row failures are isolated via `Effect.either` so one stale connector can't poison the pass. `startGmailWatch` relocated from `apps/api/src/` to `packages/providers/src/gmail-watch.ts` so the worker can call it. 6 unit tests on `renewOne` (cover due/skipped/expired-token/missing-refresh/watch-failure branches).
- [x] Gmail full-mailbox reseed: on 404 from `users.history.list` (cursor older than Gmail's ~7-day retention), `apps/api/src/gmail-webhook.ts` now reseeds by calling `gmailListInboxMessageIds` with `q=in:inbox newer_than:7d` (capped at 50) instead of bailing. Each id is fetched + published as `message.received` exactly like the normal-history path; the cursor is then snapped forward to `gmailGetProfile().historyId`. The runtime's `findByThreadId` dedup means re-published messages join their existing case rather than opening duplicates — what makes a coarse "last 7 days" reseed safe even when the reseed window overlaps with state we already have. 4 new gmail-http unit tests (`gmailGetProfile` happy + missing-fields, `gmailListInboxMessageIds` query encoding + empty result).
- [x] Gmail unread-on-connect backfill: on successful Gmail OAuth callback, list up to 50 existing unread INBOX messages (`q="in:inbox is:unread"`) and dispatch them through the same message fetch / attachment upload / `message.received` publisher used by Pub/Sub history pushes. This closes the "merchant connects a mailbox with already-unread customer replies / hanging cases" gap without changing the ongoing webhook-driven ingestion model. SENT echoes are skipped, and failures are logged without failing the OAuth callback. 1 new unit test in `apps/api/test/gmail-webhook.test.ts`; verified by focused test, API build, workspace build, and full suite.
- [x] Gmail mark-read after successful dispatch: after a Gmail message has been fetched and successfully published as `message.received`, remove the `UNREAD` label via `users.messages.modify` (`removeLabelIds: ["UNREAD"]`) in both the webhook/history path and unread-on-connect backfill. Landed 2026-06-02 via `gmailMarkMessageRead` in `packages/providers/src/gmail-http.ts` and the shared `publishGmailMessageIds` helper in `apps/api/src/gmail-webhook.ts`. Mark-read happens only after successful publish, never before; mark-read failure logs and leaves the message unread for retry. Tests cover provider wire format/error mapping and API backfill ordering.
- [x] `PlatformMailService` Tag + Live (Resend) — for platform-originated mail only (manager invites, approval-link emails, billing). Never used for customer replies. Tag in `packages/services/src/platform-mail.ts` with `sendApprovalLink(input)` method + `PlatformMailServiceTest` (in-memory, exposes a `handle.sent` array for assertions). Live in `packages/providers/src/platform-mail-live.ts` — depends on `ResendConfig` Tag (`apiKey` + `fromAddress`, env-driven via `ResendConfigFromEnv` reading `RESEND_API_KEY` + `RESEND_FROM_ADDRESS`) and the new `TenantRepository` Tag (resolves `tenants.settings.notificationEmail` per tenant; live impl in `packages/db/src/tenant-repository-live.ts`). Null notificationEmail → `PlatformMailUnconfigured`; Resend non-2xx → `PlatformMailSendFailed`. Renders both a plain-text and minimal-inline-HTML body with `<Approve> <Reject>` buttons; `escape` runs on all interpolated fields. 4 new tests in `packages/providers/test/platform-mail-live.test.ts`.
- [ ] Connector-normalized inbound flow: provider webhook/polling event → connector fetches message/thread → normalize into `email.received` (or successor `message.received`) without leaking provider-specific payloads into `AgentRuntime`.
- [ ] Connector-normalized outbound flow: `conversation.reply` sends through the tenant's configured conversation connector; the Gmail implementation uses `users.messages.send` with `threadId`, while other connectors map to their own reply/send APIs.
- [x] Tool: `shopify.get_order` (`packages/tools/src/shopify/get-order.ts`). Wraps `ShopifyService.getOrder`; flattens the response onto a tool-output shape that's smaller than the full domain type (line items minus variant title, fulfillments with the tracking sub-object). Maps any `ShopifyError` (`OrderNotFound`, `ShopifyAuthFailed`, `ShopifyAuthMissing`, `ShopifyRateLimited`, `NetworkError`, `CustomerNotFound`) to `ToolOutputInvalid` with `issues: [<tag>]` at the tool boundary so the LLM sees structured failures. Risk: read; defaultPermission: allow; sideEffectClass: none.
- [x] Tools: `shopify.get_customer` (`packages/tools/src/shopify/get-customer.ts`) — wraps `ShopifyService.getCustomer` (by id) and `ShopifyService.searchByEmail` (by email) behind a single tool with mutually-exclusive `customerId` / `email` input; flat output (id, email, firstName, lastName, phone, ordersCount, totalSpent, defaultAddress, createdAt). Empty-string input is treated as "not set" so a model that fills both fields with `""` still hits the XOR check. `null` from `searchByEmail` → `ToolOutputInvalid { issues: ["CustomerNotFound"] }` so the LLM sees the same failure shape as a by-id miss. Registered in `apps/worker/src/bootstrap.ts` ToolRegistry; **NOT** wired into any agent yet (no agent has it in its `tools:` list) — refund / missing-package / damaged-product specialists will pick it up when they land. 5 unit tests on top of the existing 3 for `shopify.get_order`. `tracking.lookup` deferred — see "Aftership/EasyPost carrier-level tracking integration" in Phase 5; everything Shopify-side tracking-related is already on `order.fulfillments` and surfaced by `shopify.get_order`. `conversation.fetch_thread` ✅ + `conversation.reply` ✅ + `conversation.ask_customer` ✅ shipped in `packages/tools/src/conversation/`, depending only on the `ConversationService` Tag — no provider names in tool code. `conversation.reply` is `risk: "communicate"`, `defaultPermission: "ask"`, declares `idempotencyKey: (input) => input.draftId` so runtime retries dedupe before re-invoking the body (master-plan §9). `conversation.ask_customer` is `defaultPermission: "allow"`. `conversation.fetch_thread` is `risk: "read"`, `defaultPermission: "allow"`. All three map `ConversationError._tag` → `ToolOutputInvalid { issues: [_tag] }` at the boundary. 7 unit tests across the three tools. None wired into agents yet — `support-triage` + `order-status-agent` still resolve cleanly today via final-message; specialists that use `conversation.reply` (e.g. refund-review) come next.
- [x] Built-in runtime-control tool: `agent.handoff` in `packages/tools/src/agent/handoff.ts`. Schema-registered like a normal tool (so its JSON Schema reaches the LLM through `ToolRegistry.schemasFor`) but **the runtime intercepts the call** before permission/execute: validates `targetAgent` is in the calling agent's `handoffs`, swaps the active agent for the rest of the tick, persists the new `currentAgentId` via `cases.update`, and records a `tool.invoked` audit row (ok=true with target+reason on success, ok=false with `error: "target_not_in_handoffs"` on rejection). A success or rejection tool-result message is pushed back into the conversation so the new agent sees the prior agent's work and the transition. The body itself is a safe no-op fallback (`{ ok: true, targetAgent }`). 4 unit tests on the tool + 2 e2e tests on the runtime intercept (happy path + rejected target).
- [x] Agents: `support-triage` (now hands off to `order-status-agent` when classification is `where_is_order` AND `identifiedOrderId` is set) + `order-status-agent` (`packages/agents/src/order-status-agent.ts`). Order-status-agent is a `subagent` (never picked as initial agent), uses `google/gemini-3-flash-preview`, declares `tools: ["shopify.get_order", "case.update_context"]`, `handoffs: []` (terminal specialist), `maxTurnsPerTick: 5`. Prompt enforces a 2-turn shape: one `shopify.get_order` call + one plain-text final summary; refuses to retry the lookup on `OrderNotFound`. Both agents registered in `apps/worker/src/bootstrap.ts`.
- [x] Manual happy path: send a real (synthetic) inbound ticket, watch a case resolve. **Verified 2026-05-16** against the live store `support-agent-test.myshopify.com` (tenant `34ee761c-392f-4dc3-a1ca-9b8940d3923a`), case `f8db839d-6696-4de2-ade7-3376ead3cc71` resolved cleanly with the full chain: `event.received → llm.decision(tool_call) → tool.invoked(case.update_context, ok=true) → llm.decision(tool_call) → tool.invoked(agent.handoff to order-status-agent, ok=true) → llm.decision(tool_call) → tool.invoked(shopify.get_order on #1001, ok=true) → llm.decision(final_message) → case.resolved`. Final reply quoted in `audit_log.details.finalMessage`. The run surfaced and fixed four real bugs that had to land for the demo to work (see "Last checked" line). **All four fixes are pinned with regression tests (12 new):** (a) AgentRuntime conversation-history fix — `apps/worker/test/agent-runtime.e2e.test.ts` uses `LLMServiceFromFn` to assert the messages array on turn 1 contains `["user", "assistant", "tool"]` with the assistant carrying the prior tool-call. (b) LLM tool-name sanitization for `anthropic/*` — `packages/providers/test/llm-service-live.test.ts` asserts dots → underscores in tool schemas + tool-call + tool-result references, reverse-maps inbound, and verifies non-Anthropic models pass through unchanged. (c) Anthropic-only provider routing — same file, asserts `chat()` receives `{ provider: { only: ["anthropic"], allow_fallbacks: false } }`. (d) `shopify.get_order` name dispatch — `packages/tools/test/shopify.test.ts` covers `#1001` lookup, bare `1001` lookup, and null → `ToolOutputInvalid { OrderNotFound }`; plus `packages/providers/test/shopify-service-live.test.ts` covers the Live `findOrderByName` (query string, `#` auto-prepend, null result).

---

## Phase 3 — Dashboard

**Goal:** a manager can see and act on cases.

- [~] `apps/dashboard` — Next.js scaffolded 2026-05-17. Stack: **Next.js 16.2.6** (App Router, Turbopack, React 19.2.6 — latest stable, includes all CVE patches through 2026-05-15), **WorkOS AuthKit** (`@workos-inc/authkit-nextjs@4.1.0`, proxy-based session — `proxy.ts` is the Next-16 replacement for `middleware.ts`, with `/((?!_next/static|_next/image|favicon.ico).*)` matcher to avoid intercepting static assets), **Drizzle in Server Components for reads** (singleton client in `lib/db.ts` with `import "server-only"` so the pg pool never leaks to the client bundle; transpiled from `@support-agent/db` via `transpilePackages` in `next.config.ts`), **writes via apps/api** (Phase 3 implementation — scaffold leaves Approve/Reject as placeholder copy with a TODO; the existing `GET /approvals/:id/(approve|reject)?token=…` endpoints handle the email-link path today). Pages stubbed: `/` (Today view with status counts), `/cases` (last-100 list), `/cases/[id]` (timeline from `audit_log` + full context JSON), `/approvals` (pending list), `/approvals/[id]` (proposed input + reasoning render). Auth routes: `/sign-in` (kicks off WorkOS sign-in URL), `/callback` (PKCE handshake), `/sign-out`. Env added to `.env.example`: `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, `WORKOS_COOKIE_PASSWORD` (≥32 chars), `NEXT_PUBLIC_WORKOS_REDIRECT_URI`. Build verified: `next build` compiles all 8 routes (Turbopack, 2.8s) with the strict workspace tsconfig overrides (`jsx: react-jsx` set automatically by Next on first build; everything else inherited from base — `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`). Root `pnpm build` + `pnpm test` (247 passing) unchanged. **Outstanding before this can be marked done**: ✅ tenant scoping landed 2026-05-17; ✅ Approve/Reject server actions landed 2026-05-18 (via shared `applyApprovalDecision`); ✅ SSE for live case-detail updates landed 2026-05-18; ✅ audit log page landed 2026-05-18 (with cursor pagination + filters); ✅ Edit-and-Approve + Take Over case action landed 2026-05-18; full Today-view design (waiting-customer, waiting-supplier, human-takeover sections); settings pages; onboarding flow to link a WorkOS org to a tenant (currently a manual `UPDATE tenants SET workos_organization_id = 'org_…'`). Worth a separate slice each.
- [x] **Dashboard UI refactor on Tailwind v4 + shadcn/ui (avocado theme).** 2026-05-20. Replaced the hand-rolled `globals.css` with Tailwind v4 + shadcn primitives (`button`, `card`, `badge`, `table`, `input`, `textarea`, `label`, `separator`, `alert`, `skeleton`, native `select`) under `apps/dashboard/components/ui/*`. Theme tokens live in `app/globals.css` via `@theme inline`; primary accent = ripe avocado `oklch(0.72 0.14 125)` (sRGB ≈ `#91b349`) with full light + dark mode. Status-variant mapping centralised in `lib/status-variants.ts` (case / approval / risk / permission / integration / actor → Badge variant). Every page refactored: layout shell + topbar (active-route highlight in avocado), `/` Today view (Card grid + Alert banners), `/cases` list + `/cases/[id]` detail (Card timeline + Customer/Order panels + ApprovalCard + LIVE pill), `/approvals` + `/approvals/[id]` (NativeSelect filters + Button decision flow), `/audit` (filter Card + cursor pagination), `/settings/*` (landing tiles + agents list/detail + permissions matrix + integrations Connect buttons), `/onboarding`, `/no-access`, `/error`. `lucide-react` icons throughout the topbar/nav/banners. `pnpm build` green; `pnpm test` 266 passing / 51 skipped; `next build` clean across all 17 routes. shadcn CLI was NOT used — primitives checked in directly so we own them. Filter selects use a native `<select>` (no client state needed for GET-submitting forms). See [[stack-decisions-dashboard]] for the locked-in stack pick.
- [~] **Path B: dashboard → pure api client + Cloudflare Workers deploy** (decided 2026-06-02; slices 1–8b landed — **the dashboard is now a pure api client (no DB/pg-boss/Effect); only the OpenNext/wrangler deploy (slice 9) remains**, which needs the user's Cloudflare account). The dashboard will host on Cloudflare Workers, which can't run its current data layer: it reads Postgres directly via the `postgres.js` TCP driver in RSC/server-actions (`lib/db.ts` → `makeDbClient`) and publishes events via `pg-boss` (`lib/event-publisher.ts`) — neither runs on Workers. Path B (chosen over Hyperdrive) makes the dashboard a stateless edge frontend: (1) add authenticated read endpoints to `apps/api` for everything the dashboard queries directly today (today-view counts `app/page.tsx`, cases list/detail + timeline, approvals list/detail, audit log w/ pagination+filters, the SSE case-events route `app/api/cases/[id]/events`); (2) design the dashboard→api auth (forward the WorkOS session or a service token + tenant scoping); (3) rewire dashboard reads to `fetch()` the api and replace the `pg-boss` publish with an api call; (4) drop `drizzle-orm`/`postgres`/`pg-boss` from the dashboard deps; (5) deploy via `@opennextjs/cloudflare` (+ `wrangler.toml`, secrets), verify WorkOS AuthKit + `proxy.ts` under OpenNext. TDD per item. Link points to the Hetzner api: `DASHBOARD_BASE_URL` (api→dashboard redirects) and the api public origin (dashboard→api). See `DEPLOY.md` → "Dashboard". Slice breakdown:
  - [x] Slice 1 — auth foundation (`parseDashboardAuth`, shared service token + asserted WorkOS org → tenant) + `GET /dashboard/today` + `dashboard-reads` query module in `packages/db`. TDD (6 unit + 3 integration), 2026-06-03.
  - [x] Slice 2 — cases list (`GET /dashboard/cases`, offset pagination) + case detail (`GET /dashboard/cases/:id`, case + full audit timeline + approvals; 404 cross-tenant). 2026-06-03. **Pending sub-item:** the case-detail Shopify customer/order/shopDomain panels (`fetchCustomerForCase`/`fetchOrderForCase`/`fetchShopifyShopDomain`) are connector calls, not DB — moved to slice 6 with the other connector-backed reads.
  - [x] Slice 3 — approvals list (`GET /dashboard/approvals`, status/risk/tool/agent filters + status counts + tool/agent facets + pagination) + approval detail (`GET /dashboard/approvals/:id`). 2026-06-03.
  - [x] Slice 4 — audit log (`GET /dashboard/audit`, action-prefix + actor filters + offset pagination). 2026-06-03.
  - [x] Slice 5 — case-events poll (`GET /dashboard/cases/:id/events?since=<bigint>`) returning audit rows after the cursor; replaces the dashboard's DB-poll SSE route. The dashboard client will poll this on an interval. 2026-06-03.
  - [x] Slice 6 — connector-backed reads (2026-06-03). `GET /dashboard/connections` (backs integrations overview + `[provider]` pages + case-detail shopDomain + the `settings/llm` page, which filters the connections list to LLM providers and reads `metadata.baseURL`); `GET /dashboard/usage?start=&end=` (raw `llm.decision` rows; the dashboard keeps OpenRouter pricing + aggregation, both Worker-safe); **`GET /dashboard/cases/:id/shopify`** — wired `ShopifyServiceLive` (+ `ShopifyHttpLive` + `ShopifyCredentialStoreFromConnector`) into `buildApiLayers` and ported `lib/shopify.ts` resolution as best-effort Effects (customer/order/shopDomain panels; Shopify failures → null); and `GET /dashboard/agent-overrides` (per-agent model overrides for the `settings/agents` pages). Every connector-backed dashboard read now has an api endpoint.
  - [x] Slice 7 — writes (2026-06-03): `POST /dashboard/approvals/:id/{approve,reject}` (reuse `applyApprovalDecision` + `decisionToEvent` + the api's pg-boss publisher, tenant-scoped, `approvedInput` for edit-and-approve) and `POST /dashboard/cases/:id/takeover` (`takeOverCase` ported into `@support-agent/db`). `parseDashboardAuth` now carries `x-user-id` (manager UUID); `ServerHandle.close()` stops the lazily-started approval pg-boss. +7 tests. **Still TODO in this area:** move `getTenantId`/onboarding tenant creation behind the api (part of slice 8 — the dashboard's `getTenantId` still does a DB lookup today).
  - **Slice 8 split into 8a (api gaps) + 8b (dashboard cutover)** — while scoping the cutover I found the api surface was NOT complete: slices 1–7 covered reads + the approval/takeover writes only. The settings **writes** (LLM connect/revoke, agent-model override, refund policy, supplier sheet, connector disconnect) + onboarding tenant-create had no endpoints, and three reads the dashboard does in-process can't run on Workers (the `agents`/`tools` catalog transitively imports `services`' node built-ins; the model-catalog fetch needs the decrypted key; `getTenantId`/onboarding resolve org→tenant via Drizzle).
  - [x] Slice 8a — complete the api surface + shared contracts package (2026-06-04). New zero-dep **`@support-agent/dashboard-contracts`** package (depends only on `agent-core`, Worker-safe): the canonical dashboard↔api JSON types. Relocated every `dashboard-reads` view type + the pagination helpers there; `@support-agent/db` re-exports them so the api edge is unchanged. New DTOs: `CatalogResponse`/`AgentDto`/`ToolDto`, `ModelsResponse`/`ModelOption`, `TenantResponse`/`TenantInfo`, `OnboardingResult`. **3 read endpoints** — `GET /dashboard/catalog` (pure `buildCatalogResponse(ALL_AGENTS, ALL_TOOLS)` projection in `apps/api/src/dashboard-catalog.ts`), `GET /dashboard/models` (resolves the tenant's active LLM cred server-side via `ConnectorCredentialStore` + `fetchModelCatalog` — **the decrypted key never reaches the browser**; `apps/api/src/dashboard-llm.ts`), `GET /dashboard/tenant` (org→tenant or null; uses new `authenticateDashboardOrg` which doesn't require a tenant). **8 write endpoints** — `POST /dashboard/onboarding` (new `createTenantForOrg` db write, idempotent), `/dashboard/agents/:id/model` + `…/model/clear`, `/dashboard/llm` + `/dashboard/llm/revoke` (api encrypts), `/dashboard/refund-policy` (canonical minor-units body), `/dashboard/supplier-sheet` + `…/clear`, `/dashboard/connections/:provider/disconnect`. Each ports the matching dashboard server-action logic + validation. `buildApiLayers` gained `TenantRepositoryLive` + `TenantAgentOverridesServiceLive` (+ widened `ApiLayer`); `apps/api` gained `agents`/`tools`/`dashboard-contracts` deps. TDD: +8 unit (catalog projection, models response) + 18 integration (settings reads/writes, scoping, 400/401/404/503). Full suite **642 passing / 5 skipped**; `pnpm build` + dashboard `tsc --noEmit` green. **The dashboard was NOT touched — the api surface is now genuinely complete.** See [[project_deploy_hetzner_compose]].
  - [x] Slice 8b — dashboard cutover (2026-06-04). The dashboard is now a **pure api client** — its only `@support-agent/*` deps are `agent-core` + `dashboard-contracts` (both Worker-safe); `db`/`services`/`providers`/`agents`/`tools` + `drizzle-orm` + `pg-boss` are gone, and `transpilePackages` trimmed to match. New `lib/api-client.ts` (server-only typed client over `DASHBOARD_API_BASE_URL` + `DASHBOARD_API_TOKEN`): `getDashboardContext()` gates every tenant page (`withAuth`→/sign-in, no-org→/no-access, `GET /dashboard/tenant` null→/onboarding) and returns org + manager decision UUID + `tenantId`; reads send `x-org-id`, writes also send `x-user-id`. Every page + server action rewired to `fetch()` the api; pages consume `dashboard-contracts` types (ISO-string dates). **First did a small 8a addendum** (commit `bd89fd8`): two more read gaps the cutover needed — `GET /dashboard/settings` (resolved tenant settings for the refund-policy + Google-Sheets pages; `TenantSettingsView`) and relocating `isConnectorScopeGranted` into `dashboard-contracts` (the integrations capability grid uses it). **Deviation from the original plan:** `app/api/cases/[id]/events/route.ts` was NOT deleted — a client component can't hold the service token, so it's rewritten as a thin **same-origin JSON poll proxy** (server-side `withAuth` → api); `CaseLiveBoundary` polls it from a render-time cursor instead of EventSource. `lib/catalog.ts` now projects the fetched `CatalogResponse`; OpenRouter pricing for the usage page is a tiny Worker-safe public `fetch` (`lib/openrouter-pricing.ts`). Deleted `lib/{db,event-publisher,approvals,case-actions,llm-runtime,shopify,shopify-runtime,tenant}.ts`. **Security win:** the decrypted LLM key never reaches the dashboard now (the api resolves it for the model picker). Verified: dashboard `tsc --noEmit` + `next build` (22 routes, all dynamic) green; `pnpm build` + full suite **645 passing / 5 skipped**. See [[project_path_b_api_surface]].
  - [x] Slice 9 — deployed 2026-06-08 at `https://support-agent-dashboard.12anas2000.workers.dev`; public api origin, shared dashboard token, WorkOS runtime secrets, and callback configured. Automated smoke: sign-up page 200, sign-in reaches WorkOS 200, api dashboard guard rejects missing credentials with 401. Authenticated smoke passed: real WorkOS callback, org/tenant onboarding, dashboard home, cases, integrations, and settings pages all loaded successfully. Fixed the two live-only OpenNext/AuthKit cookie issues found during smoke (`7f4fb71`, `10f00d3`). Custom DNS remains intentionally deferred.
- [ ] Auth (OIDC)
- [ ] Today view, case list, case detail with timeline
- [ ] Approval list + detail with Approve / Edit & Approve / Reject / Take Over
- [ ] SSE for live case-detail updates
- [ ] Command endpoints wired (`/approvals/:id/approve`, etc.)

---

## Phase 4 — Safety & policy

- [x] Conditional permission rules (e.g. `refund.create` amount thresholds) — landed 2026-05-21. `PermissionServiceLive` in `packages/services/src/permission-service-live.ts` consults `TenantRepository.getSettings(tenantId).refundPolicy` and overlays the 3-zone decision (`allow` ≤ askAbove, `ask` in the mid range, `deny` > denyAbove) on top of the static (agent override → tool default) decision. Pure `applyRefundPolicy` + `parseRefundAmount` are exported for unit tests. Today only `refund.create` carries a conditional rule; the Tag is structured so adding rules for other money tools is a localised change. See [[project_refund_create_landed]] (if memory exists) or the 2026-05-21 session entry above.
- [x] Per-tenant policy overrides via dashboard — `apps/dashboard/app/settings/refund-policy/` page + server action writes `tenants.settings.refundPolicy` via `TenantRepository.setRefundPolicy`. Validates currency (ISO 4217), non-negative integer-cents thresholds, and `ask ≤ deny` ordering. Other policy categories (PII redaction, cost caps, tool-level allow/deny matrix) still pending — this slice covers the refund vertical specifically.
- [ ] Slack approval channel (interactive buttons)
- [x] Signed email approval links — full closed-loop arc: runtime fires approval-link email best-effort after `approvals.create` in the ask branch; `GET /approvals/:id/(approve|reject)?token=<sig>` HTTP endpoints in `apps/api` verify the signed token, mark the row decided, and publish `approval.approved` / `approval.rejected` to the `workflow.events` queue; the worker's `AgentRuntime` picks up the resume event, executes the previously-gated tool (e.g. `conversation.reply`) with `approvedInput ?? proposedInput`, audits `tool.invoked` with `viaApprovalId`, transitions `waiting_for_approval → resolved`, audits `case.resolved`. Rejection path: transition → `human_takeover`, audit `case.escalated_to_human`, return `HumanTakeoverRequired`; the customer-facing tool never runs. Tokens use HMAC-SHA256 over `<approvalId>.<expiresAt>` with `APPROVAL_SIGNING_KEY` (shared by worker signer + api verifier); same token works for both approve and reject — action encoded in the URL path. Idempotent re-click: a second click reads the already-decided row + renders an "already decided" page; no duplicate event published. Components: `packages/services/src/approval-tokens.ts` (sign/verify, 6 tests); `packages/services/src/platform-mail.ts` + `packages/providers/src/platform-mail-live.ts` (Resend, 4 tests); `packages/services/src/tenant-repository.ts` + `packages/db/src/tenant-repository-live.ts` (resolves `tenants.settings.notificationEmail`); `apps/api/src/approval-endpoints.ts` (`decideApproval`, `renderApprovalPage`, `makePgBossApprovalPublisher`, 16 tests); runtime resume branch + `approval.create` email fire in `packages/services/src/agent-runtime.ts` (+ 2 e2e: closed-loop happy path asserting customer reply landed via `ConversationServiceTest.handle.sent`, and rejection path asserting NO reply went out + case in `human_takeover`). Env: `APPROVAL_SIGNING_KEY` + `APPROVAL_BASE_URL` added to `.env.example`. Total +18 tests; suite 247 / 47 skipped; `pnpm build` green.
- [x] PII redaction in audit log — landed 2026-05-25. Opt-in via `AUDIT_LOG_REDACT_PII=1` env. `packages/services/src/audit-redaction.ts` pure `redactPii` walks the details JSON, replaces known-PII keys (`bodyText`, `bodyHtml`, `finalMessage`, `email`, `customerEmail`, `phone`, `firstName`, `lastName`, address fields) with `[redacted]`, and regex-scrubs free-form email + phone substrings out of any remaining string values. `AuditLogServiceLive` refactored into a parametric builder; worker bootstrap picks `AuditLogServiceLiveRedacted` when the flag is set. Old rows persisted before flipping the flag stay as-is (no backfill — historical fidelity vs forward-only redaction is a deliberate choice). OTel-trace-side redaction still pending (would require OTel SpanProcessor hook).
- [x] Cost tracking per case — landed 2026-05-25. `agent-core/llm.ts` gained `LLMUsage` (`{ model, inputTokens, outputTokens }`); each `LLMDecision` variant carries an optional `usage` field (non-breaking). `LLMServiceLive` captures `result.usage` from the AI SDK (both new + legacy field names) and only attaches when the SDK reports it. Runtime stamps usage into `llm.decision` audit row details. Dashboard case-detail header renders a `sumCaseTokens` rollup with input/output breakdown in tooltip. USD translation deferred to Phase 6 cost dashboard (needs per-model pricing table; tenant-vs-platform billing attribution).
- [ ] Tenant/agent/provider rollup of costs — Phase 6 cost dashboard (per-model + per-tenant aggregations; needs the pricing table to convert tokens → USD).
- [ ] Hard turn budget enforced; `max_turns_exceeded → human_takeover` path tested
- [x] **Production-gap: privacy / data processing notice** — implemented 2026-06-04. Public API route `GET /legal/data-processing` serves the merchant-facing Data Processing Notice covering customer data categories, processing purposes, subprocessors, retention, and security controls. Dashboard onboarding links it before tenant creation; Settings → Legal links it for existing tenants.
- [x] **Production-gap: Data Processing Agreement (DPA) template + acceptance gate** — implemented 2026-06-04. The public legal page includes a lightweight DPA; `tenants.settings.legalAcceptance` stores accepted notice/DPA versions + timestamp + user id. Onboarding requires acceptance; existing tenants can accept in Settings → Legal. API connector write paths block with `legal_acceptance_required` until current versions are accepted (dashboard LLM BYOK, Shopify install/callback, Google install/callback).
- [x] **Production-gap: retention sweep cron** — landed 2026-05-25. `apps/worker/src/retention-sweep.ts` + `retention-sweep-schedule.ts`: `boss.schedule("retention-sweep", "0 3 * * *")` walks every tenant, computes `cutoff = now - retentionDays * 24h` from `tenants.settings.retentionDays` (default 730d, overrideable per tenant), and deletes resolved cases past the cutoff with cascaded `case_state_transitions` + `audit_log` + `approvals` in one tx per tenant. Discriminated `kind: "ok" | "failed"` union surface so the cron records per-tenant failures without aborting the rest. `TenantSettings` widened with `retentionDays`. `docs/shopify-pcd.md` §7 commitment honored.

---

## Phase 5 — More categories

- [x] Agent: `refund-review-agent` (`packages/agents/src/refund-review-agent.ts`) — subagent reached via `agent.handoff` from support-triage when classification is `refund_request` AND an order id is identified. Tools: `["shopify.get_order", "shopify.get_customer", "case.update_context", "conversation.reply"]`; `handoffs: []`; model `google/gemini-3-flash-preview`; `maxTurnsPerTick: 6`. Drives the full ask-then-pause-then-approve arc: fetches the order, drafts a customer reply via `conversation.reply` (which is `defaultPermission:"ask"`), the runtime creates an approval row, transitions the case to `waiting_for_approval`, returns `PausedWaitingForApproval`. Nothing is sent to the customer until a human approves. Also extended `agent-runtime.ts:buildInitialMessages` so `message.received` events now prepend a `[Thread context: threadId=..., from=...]` header to the user message — the specialist needs both fields to wire `conversation.reply` without a `conversation.fetch_thread` round trip. Wired in `apps/worker/src/bootstrap.ts` (registered next to support-triage / order-status-agent) and exported from `packages/agents/src/index.ts`. Support-triage's prompt + handoffs updated to route `refund_request` cases here. 1 new scripted e2e test in `apps/worker/test/agent-runtime.e2e.test.ts`: `triage → handoff → get_order → conversation.reply(ask) → PausedWaitingForApproval` with assertions on the approval row, case status, currentAgentId, and audit trail (event.received + 3× (llm.decision, tool.invoked) + trailing llm.decision; no `tool.invoked` for conversation.reply because permission=ask short-circuits BEFORE execute).
- [x] Agent: `missing-package-agent` — landed 2026-05-24. `packages/agents/src/missing-package-agent.ts`. Subagent reached via `agent.handoff` from `support-triage` for `missing_package` classification. Three decision branches in the prompt based on order fulfillment state (delivered / stuck-in-transit / unfulfilled). Always drafts via `conversation.reply` (defaultPermission=ask). Refunds explicitly delegated back to `refund-review-agent` via the customer's confirmation flow — this agent does NOT carry `refund.create`. **2026-05-25 update**: BRANCH A (delivered but not received) now optionally calls `supplier.add_sheet_row` before drafting the customer reply. Gated on a `[Supplier escalation sheet: ...]` header injected into the system prompt by `AgentRuntime` when the tenant has `tenants.settings.supplierEscalationSheet` configured. New `TenantSettings.supplierEscalationSheet: { spreadsheetId, range, description } | null` field + `TenantRepository.setSupplierEscalationSheet` writer; dashboard page at `/settings/supplier-escalation` (Server Component + Server Action with A1-range validation). **2026-05-26 update**: merchant-facing form now asks for a pasted Google Sheets URL and extracts `spreadsheetId` server-side, while preserving raw-ID compatibility for existing/admin-entered values; URL helper covered by dashboard unit tests. Agent permissionOverride `"supplier.add_sheet_row": "allow"` downgrades the tool's default `ask` to auto-allow inside this agent (the reply still gates on operator approval; the warehouse log is internal). +8 tests (3 TenantRepository read/write/clear, 4 `buildSystemPrompt` pure helper, 1 e2e BRANCH A with-sheet flow asserting `tool.invoked(supplier.add_sheet_row)` precedes `conversation.reply` ask-pause).
- [x] Agent: `damaged-product-agent` — landed 2026-05-29. `packages/agents/src/damaged-product-agent.ts`. Subagent reached via `agent.handoff` from `support-triage` when classification is `damaged_product` AND `identifiedOrderId` is set. Tools: `["shopify.get_order", "shopify.get_customer", "case.update_context", "conversation.reply", "conversation.ask_customer"]`; `handoffs: []`; `maxTurnsPerTick: 6`. Two prompt branches: BRANCH A (photos present in the inbound message — the LLM sees them as image content parts after the photo-evidence pipeline projects attachments) → call `shopify.get_order` once, then draft a customer reply via `conversation.reply` (`defaultPermission: ask`) proposing either a replacement (default, when the item is restockable + customer didn't ask for refund) or a refund (when item is single-use / customer asked / high value). BRANCH B (no photos) → send a friendly photo request via `conversation.ask_customer` (`defaultPermission: allow`) with `remindAfterHours: 72`. Refunds explicitly NOT issued here — `refund.create` is not in the tool list; the refund-review-agent handles refunds after the customer confirms (mirroring `missing-package-agent`'s design choice). Support-triage prompt extended with a 4th DECISION RULE branch routing `damaged_product` here + `AgentId("damaged-product-agent")` added to its `handoffs` list. Registered in `ALL_AGENTS`. **+4 tests**: 2 unit (config shape + registry resolve) + 2 e2e (BRANCH A photos-present → triage → handoff → `shopify.get_order` → `conversation.reply` ask → `PausedWaitingForApproval` with the right approval row; BRANCH B no-photos → triage → handoff → `conversation.ask_customer` allow → case enters `waiting_for_customer` and no `conversation.reply` invocation occurs). Suite **472 passing / 58 skipped** (up from 468/58); `pnpm build` green across all 9 workspace projects.
- [x] `damaged-product-agent` hardening — product-match check. Landed 2026-05-29. Extended `ShopifyService` Tag with `getProduct(tenantId, productId)` (Live impl over the GraphQL `product(id:)` query returning `title` / `productType` / `vendor` / `images[].{url,altText}`; Test layer `productsById` fixture; new `ProductNotFound` tagged error added to the `ShopifyError` union). New read-only `shopify.get_product` tool (`risk: read`, `defaultPermission: allow`, `sideEffectClass: none`, `requiredConnectorScopes: { provider: "shopify", scopes: ["read_products"] }`) wired into `ALL_TOOLS` (auto-registered by the worker bootstrap). `ShopifyLineItem` gained `productId: string | null` (GraphQL `product { id }`), surfaced on the `shopify.get_order` tool output so the agent has an id to pass. `case.update_context` gained a `productMatch: "match" | "mismatch" | "uncertain"` hint field. damaged-product-agent BRANCH A now runs a 4-step flow: `shopify.get_order` → `shopify.get_product` (one call, most-relevant line item; null productId or error → `uncertain`, no retry) → `case.update_context { productMatch }` → `conversation.reply` (gated ask); a non-`match` verdict softens the reply to ask the customer to confirm the item before committing to a resolution. `shopify.get_product` added to the agent's tool list; `maxTurnsPerTick` raised 6 → 9 (the turn budget is shared with triage across the handoff — the runtime doesn't reset it). ApprovalCard renders a green/red/outline "Photo check" badge from `case.context.productMatch`. Catches the generic-broken-product-image fraud pattern cheaply, before any forensic step. **+6 tests** (3 provider `getProduct`: happy/bare-id/ProductNotFound, 3 tool: happy/error-mapping/surface) plus updated assertions on the existing BRANCH A e2e (now asserts `productMatch="match"` stamped), the get_order line-item `productId` mapping, and the agent config/prompt regressions. Suite **478 passing / 58 skipped** (up from 472/58); `pnpm build` + `next build` (19 routes) green. Note: scope `read_products` is separate from `read_orders` — merchants who want the product-match check must include it in the managed-app scopes (commonly bundled; document for the install path).
- [x] `damaged-product-agent` hardening — EXIF + perceptual-hash sanity checks on uploaded photos. **BOTH halves LANDED 2026-06-01** (EXIF `bbb51a2`; pHash store `3c8cb82` + compute/runtime/dashboard wiring in the follow-up commit). **pHash as shipped:** pure `dhashFromLuma` (9×8 difference-hash → signed 64-bit BigInt) + `hammingDistance` in `agent-core/image-hash.ts`; `computeImagePHash` in `providers/image-phash.ts` (`jimp@1.6.1` decode→resize→greyscale, **injectable decoder**, **never throws** → null on undecodable). `MessageAttachment.phash?` is a decimal string (bigint isn't JSON-serialisable over pg-boss); `processGmailImageAttachments` stamps it per image. New `image_hashes` table + migration `0010` + `ImageHashStore` (Tag + in-memory Test + Postgres Live); `findSimilar` narrows to the tenant's recent window in SQL then filters/sorts by Hamming in the pure `matchSimilar` (Test + Live identical). Runtime: per inbound photo, `findSimilar({maxDistance:5, sinceDays:90})` excluding the current case → stamp `case.context.riskFlags += duplicate_photo_seen_in_case_<id>`, then `record`. **Store is OPTIONAL in the runtime via `Effect.serviceOption` captured at layer-build time** — present in the worker bootstrap (`ImageHashStoreLive`), absent in most test layers, so no existing test layer needed widening and dedup is skipped when unwired. Dashboard ApprovalCard renders destructive "Risk flags" chips. **Decisions/deviations:** dHash (not DCT-pHash); `jimp` pure-JS decoder (not native `sharp`); Hamming computed app-side over the tenant window (not SQL `bit_count` — revisit with BK-tree/`bit_count` pushdown if volume grows); phash stored as signed bigint (bitwise distance, sign irrelevant). **Pre-existing issue surfaced:** `0009`'s drizzle snapshot was missing from `meta/`, so `db:generate` re-emitted `timers` — hand-trimmed `0010` to `image_hashes` only; `0010_snapshot.json` is a correct full-schema baseline going forward (historical `0009` snapshot gap remains, low priority). **Follow-up RESOLVED 2026-06-01:** `jimp`/`exifr` were eagerly pulled into the dashboard bundle (it transpiles `@support-agent/providers`, whose barrel re-exports `image-phash`/`image-exif`) → build-time "Couldn't load zlib/fs" warnings. Fixed by moving the codec imports inside the decode functions as lazy `await import(...)` so they leave the static module graph — chose this over a subpath-`exports` refactor (smaller, no API change, no risk to the tsc project-reference / Next transpile build). Verified: dashboard `next build` now warning-free; added a real-PNG round-trip test exercising the lazy `import("jimp")` path. Tests across both commits: +6 hash utils, +5 store Test, +1 store Live integration, +3 phash compute, +1 phash upload-stamp, +1 e2e duplicate-flag (plus the EXIF tests below). Original spec retained for reference. EXIF as shipped: `extractImageExif` in `packages/providers/src/image-exif.ts` (pure, `exifr@7.1.3`-backed, **injectable parser** so the mapping is unit-tested without image fixtures, **never throws** — a non-image/malformed input collapses to an empty summary). Maps to a privacy-conscious `ExifSummary` (`agent-core/payloads.ts`: `hasExif`, `cameraMake`, `cameraModel`, `dateTimeOriginal` ISO, `gps {lat,lon}`) — we keep ONLY these, never the full EXIF dump. `MessageAttachment.exif?` carries it; `processGmailImageAttachments` populates it per uploaded image. `summarizePhotoSignals` (`agent-core/photo-signals.ts`) rolls EXIF presence across a message's images into `PhotoSignals {count, withExif, stripped, anyStripped}`. The runtime stamps `case.context.photoSignals` on `message.received` / `customer.replied` with image attachments (best-effort; latest reply wins, mirroring `productMatch`). Dashboard ApprovalCard renders a "Photo EXIF" chip (camera-metadata present → green / stripped → red). `hasExif` is defined as "any camera-identifying field present" (Make/Model/DateTimeOriginal/GPS) — a photo with only e.g. Orientation reads as stripped, which is the intended signal. **Deviation from the original spec:** no dedicated `audit_log` row for EXIF — the `case.context.photoSignals` stamp IS the operator-readable record the dashboard reads, so a separate audit row was avoided as noise; revisit if SOC2 wants it. Tests: +7 extractor, +4 summary, +1 upload-stamping, +1 e2e context-stamp. Suite 543 passing / 5 skipped (with DB). Seed script stamps `photoSignals` on the 5 damaged-product mock cases so the chip is reviewable (the mismatch/fraud case shows stripped). Remaining: (2) **Perceptual hash** — compute a pHash (`sharp` + `image-hash` or a tiny inline implementation) for each uploaded image and persist it in a new `image_hashes` table (`tenant_id`, `phash bigint`, `case_id`, `created_at`, index on `phash`). On every new upload, query for existing rows within a Hamming distance ≤ 5 across the SAME tenant in the last 90 days. A hit stamps `riskFlags: ["duplicate_photo_seen_in_case_<id>"]` onto the case context — catches the "same broken-vase photo across three different orders" scam without any external service. Privacy: pHashes are not reversible to the original image; we keep nothing but the hash, the case id, and the tenant. New ~80 LOC service + migration; the heavy lift is the pHash function (already exists in `sharp`/`image-hash`/`blockhash-core`, pick one). AI-generation-detection as a SaaS (Hive, Sensity) is intentionally NOT in this slice — accuracy degrades fast and the cost-per-call beats the actual fraud rate at our volumes; revisit when we have data on miss rates from #1 + EXIF + pHash combined.
- [x] Tool: `supplier.add_sheet_row` (Google Sheets connector) — landed 2026-05-25. First non-Shopify, non-Gmail provider integration. `packages/tools/src/supplier/add-sheet-row.ts`. `risk: communicate`, `defaultPermission: ask`, `sideEffectClass: external_message`, `requiredConnectorScopes: { provider: "google_sheets", scopes: ["https://www.googleapis.com/auth/spreadsheets"] }`. Wraps a new `SheetsService` Tag (Test + Live in `@support-agent/services` + `@support-agent/providers`); `SheetsServiceLive` resolves per-tenant tokens from `connector_connections` (provider `google_sheets`), refreshes via the same Google OAuth2 endpoint Gmail uses (`refreshGmailToken` is shared — function name is historical). Hand-rolled HTTP wrapper (`sheets-http.ts`) over a single endpoint — `values.append` with `valueInputOption=USER_ENTERED` + `insertDataOption=INSERT_ROWS` — no `googleapis` package dep. Inputs: `spreadsheetId` + `range` (A1 with sheet name, e.g. `Escalations!A:E`) + `values` (string|number|boolean|null cells, left-to-right). Wired into `ALL_TOOLS`; worker bootstrap mirrors Gmail's gating (Live when `CREDENTIAL_ENCRYPTION_KEY` + Google OAuth env set, in-memory `SheetsServiceTest` otherwise). **NOT yet bound to any agent** — registration is enough; an agent that wants to use this for warehouse escalation can add it to its tool list in a follow-up slice. The OAuth install + callback flow + dashboard `/settings/integrations` card were already scaffolded earlier in the day (see `apps/api/src/google-install.ts:GOOGLE_SHEETS_SCOPES` + the `provider` discriminator in the callback). +16 tests.
- [x] Tool: `refund.recommend` — landed 2026-05-26. `packages/tools/src/shopify/recommend-refund.ts`. Read-only refund analysis (`risk: read`, `defaultPermission: allow`, `sideEffectClass: none`, no `requiredConnectorScopes` — uses scopes already required by `shopify.get_order` and `shopify.get_customer`). Returns `{ recommendation, amount, reasoning, riskFlags }` where recommendation ∈ `full_refund | partial_refund | deny | investigate`. Pure-logic rules over order state (refunded → deny; partially_refunded → investigate; non-paid → investigate; delivered > 30 days → deny; > tenant denyAbove → investigate; ≤ tenant askAbove → full_refund; mid-zone → full_refund) + customer-history risk flags (`first_order`, `frequent_refunder` if >30% refund rate, `new_customer` if <30d since first order, `high_ltv` if refunded total > $500 — last flag only fires when refund-history currency matches policy currency; never invents an FX rate). New `ShopifyService.getCustomerRefundHistory` Tag method + Live impl (GraphQL over `customer.orders(first:50).refunds`) aggregating ordersCount / refundedOrdersCount / totalRefundedAmount / firstOrderAt; `totalRefundedAmount` is `ShopifyMoney | null` (null when no refunds — never invents USD per [[feedback_no_hardcoded_currency]]). Refund-review PATH B prompt extended: agent calls `refund.recommend` BEFORE drafting `conversation.reply` so the operator approving sees the structured assessment. ApprovalCard.tsx surfaces the recommendation above the editable reply body (badge + amount + reasoning + risk-flag chips). +18 tests: 7 pure-logic (each rule branch + currency-mismatch + risk-flag combinations), 3 tool wire-up, 1 e2e PATH B flow (asserts both `tool.invoked(refund.recommend)` and the gated `conversation.reply` approval pending), plus shoring on neighbouring tests for the registry. Currency-correct end-to-end: every money value flows from order/refund records, no hardcoded `"USD"` anywhere in production paths.
- [x] **Structured return-intent capture (small slice, landed 2026-06-12).** Returns are still classified as
      `refund_request` and handled by `refund-review-agent` (no separate category/agent yet), but the agent now
      records _structured_ return intent instead of burying it in prose: new narrow literal fields
      `returnReason` (`defective` / `wrong_item` / `no_longer_needed` / `arrived_late` / `other`) and
      `requestedResolution` (`refund` / `replacement` / `exchange` / `store_credit` / `repair`) on
      `case.update_context` (`packages/tools/src/case/update-context.ts`). Producer: refund-review-agent's
      RETURN CAPTURE step stamps them when the message is a return, and PATH A is guarded so a return never
      auto-refunds (`refund.create` stays gated; a return is always the draft-a-reply path). Consumer:
      dashboard ApprovalCard renders "Return" chips (`apps/dashboard/app/cases/[id]/return-labels.ts` +
      `page.tsx` wiring); on `case.resumed` the fields ride back into the prompt via the (now-fenced) context
      dump, so a follow-up turn reads them as a stable fact instead of re-deriving from the thread. Tests:
      +2 case-tool (round-trip + reject out-of-vocabulary literal), +3 agent config, +3 dashboard labels,
      +1 worker e2e (return request stamps both fields end-to-end). `pnpm build` + dashboard `next build` green.
- [ ] **Dedicated returns capability (DEFERRED from the 2026-06-12 small slice).** The structured-capture slice
      above is intentionally the minimum. A full returns flow is its own feature, scoped here for a later
      session: (1) split `return_request` out of `refund_request` as a first-class triage category (or a
      sub-discriminator) so returns route deliberately; (2) a dedicated returns agent (or a clearly-separated
      returns path in refund-review) that owns the return lifecycle rather than treating it as a refund variant;
      (3) a `return.create` tool over Shopify's **returnCreate / reverse-fulfillment** APIs (RMA + return
      shipping label), with its OWN permission gating — it moves money/inventory like `refund.create` and must
      not auto-run; (4) **refund-on-receipt**: hold the refund until the item is scanned back (a returns webhook
      → resume), instead of refunding up front. Also reconsider the policy edge noted 2026-06-12: today a
      delivered+paid order where the customer says "return it for a refund" can legitimately trip PATH A and
      refund **without** securing the item back — a full returns flow should make "item back first vs keep-it"
      a per-tenant policy switch. The narrow `returnReason` / `requestedResolution` fields already landed feed
      straight into this.
- [x] Tool: `refund.create` — landed 2026-05-21. `packages/tools/src/shopify/refund.ts`. `risk: money`, `defaultPermission: ask`, `sideEffectClass: financial`. Wraps `ShopifyService.refundOrder` (Live impl in `packages/providers/src/shopify-service-live.ts` queries the order's transactions, picks the first SUCCESS SALE/CAPTURE as parent, calls the `refundCreate` mutation with `kind: REFUND`; maps `userErrors` → new `RefundFailed` tag). Conditional permission threshold is per-tenant in `tenants.settings.refundPolicy` — see Phase 4 conditional-rules entry. Refund-review-agent prompt extended with PATH A (issue refund directly) vs PATH B (draft a reply, the existing behavior). The Shopify scope needed is `write_orders` — the existing managed-install path only requests `read_orders`/`read_customers`; merchants who want refund autonomy need a re-OAuth with the wider scope. Tracked separately under Phase 2 / managed-connector scope work.
- [x] Agent: `general-inquiry-agent` — landed 2026-06-09. `packages/agents/src/general-inquiry-agent.ts`. Subagent reached via `agent.handoff` from `support-triage` for `general_inquiry` (NO order id required — the catch-all/ambiguous route). **Narrow by design: answers ONLY store / product / policy questions, grounded in a tool result; explicitly does NOT answer offers/discounts or scam messages.** Tools: `["knowledge.search", "shopify.search_products", "case.update_context", "conversation.reply"]`; `handoffs: []`; model `google/gemini-3.5-flash`; `maxTurnsPerTick: 8` (shared-with-triage budget). In-scope → grounded `conversation.reply` (defaultPermission `ask` → parks `waiting_for_approval`, human reviews every reply); out-of-scope (discount/offer/wholesale solicitation OR scam/phishing/spam/abuse) → no reply, stamp `case.update_context` reason + finish (case resolves). **Out-of-scope deliberately resolves rather than escalating to `human_takeover`:** the runtime auto-resolves on a final plain-text turn (`agent-runtime.ts:841`, guards only `!== "resolved"`) and no case-repo enforces a transition table, so an agent-set `human_takeover` would be clobbered — the durable non-resolve lever is a gated tool that parks (the ask-first reply), so the agent bias-to-replies on ambiguity (human-gated) and only resolves on clear out-of-scope. Knowledge-title system-prompt header binds automatically (holds `knowledge.search`). **New tool `shopify.search_products`** (`packages/tools/src/shopify/search-products.ts`, `risk:read`/`allow`/`read_products` scope, `SEARCH_LIMIT=5`, no `tenantControl`/`displayName` → internal, hidden from Actions UI) over a new `ShopifyService.searchProducts(tenantId, query, limit)` (Tag + Test fixture + Live `products(query:)` query; `description` plain-text trimmed/capped 600 chars; `first` clamped 1..50). New `ShopifyProductSearchResult` type in `agent-core/shopify.ts`. `support-triage` handoffs + prompt route `general_inquiry` here. Registered in `ALL_AGENTS` + `ALL_TOOLS`. **+14 tests** (4 search tool, 4 live searchProducts, 4 agent config, 2 triage handoff). `pnpm build` green; unit suite **853 passing / 4 skipped**. Not yet exercised live in runtime/browser. Branch stacked on `feat/tenant-knowledge-base`. New memory [[project_general_inquiry_agent_landed]].
- [x] **General-inquiry store grounding expansion — landed 2026-06-12** (commits `85851f2`, `db81c71`, `26f1b56`,
      `7a181c6`; one slice per item, TDD throughout). What shipped:
      (1) **Enriched `shopify.search_products`**: `priceMin`/`priceMax` (MoneyV2, store currency — never
      defaulted), `options`/`variants` (capped 10; the `Title: Default Title` placeholder collapses to `[]`),
      customer-facing `availableForSale` booleans (NO inventory counts — `read_inventory` deliberately not
      added), `onlineStoreUrl` (null when unpublished; the prompt forbids constructing links), and a
      `status === "ACTIVE"` filter so drafts/archived never reach the agent.
      (2) **`shopify.get_store_info`** (internal tool, `scopes: []` → still requires an active connection):
      name, `contactEmail` (NEVER `shop.email`, the private account login — pinned by test), primary domain,
      currency, `shipsToCountries`; ≥100 codes (rest-of-world zone) compresses to `shipsWorldwide: true` with
      the list dropped entirely (a truncated list would read as "only these countries").
      (3) **`shopify.list_pickup_locations`** (`read_locations`): the pickup filter (`localPickupSettingsV2`
      non-null + active) sits in the SERVICE contract, so raw locations (warehouses/3PLs/dropship origins)
      can never surface through any caller. Empty list grounds "no pickup offered".
      (4) **About/Contact/FAQ page import** (`read_online_store_pages`): page leg added to the post-connect
      KB import job — published pages whose handle OR title normalizes (lowercase alphanumerics) to
      about/aboutus/contact/contactus/faq/faqs/frequentlyaskedquestions become `url` docs at
      `<primaryDomain>/pages/<handle>`, sharing the policy import's contentHash dedup + per-leg silent
      best-effort boundary (page-leg failure never costs the policy leg). Deliberately conservative — decided
      with the user: under-importing beats pulling a "Wholesale pricing" page into grounding.
      **Shipping-location split enforced in the prompt** (test-pinned): ship-TO = `shipsToCountries`;
      pickup = pickup-enabled locations; ship-FROM is NEVER answered from store/location data, only from the
      knowledge base. `maxTurnsPerTick` 8 → 10 (shared triage budget; 4 grounding tools + gated reply = 7
      worst-case). Scopes added to `DEFAULT_SHOPIFY_SCOPES` + `shopify.app.toml`:
      `read_online_store_pages`, `read_locations`.
  - [ ] **Ops follow-up — scope rollout.** The authorize URL carries no scopes; Shopify reads the app config.
        SaaS/managed app: redeploy the app version (`shopify app deploy` / Partner Dashboard) so existing
        merchants get the update-permissions prompt. Pilot custom-distribution apps: update each per-tenant
        app's scopes in its Dev Dashboard, then the locked store re-OAuths. Until then the page import skips
        silently and `list_pickup_locations` is denied by the scope precheck (both by design).
  - [ ] **Not yet exercised live** against a real store (same status as the rest of general-inquiry): enriched
        search fields, store info, pickup list, page import. Worth folding into the next live demo pass.
  - [ ] **Known niggle — KB "Resync" on imported pages/policies** refetches the public URL (full storefront
        HTML incl. nav) while the import writes API-sourced text, so a resync can churn `contentHash` and
        content quality. Harmless but worth aligning (e.g. resync url-docs created by the importer back
        through the importer) if merchants start using Resync on them.
        Deferred from the original plan, still open: exact shipping rates / delivery promises (separate
        address/cart-aware capability), `read_inventory` (only if exact stock quantities are ever wanted),
        `read_markets` (market-specific domains/config). `read_shipping` stays out.
- [ ] Evidence upload (object storage), photo handling
- [x] `TimerService` Tag + Live; `timer.expired` event — landed 2026-05-27. Abstract Tag/Test layer in `packages/services/src/timer-service.ts`; Drizzle schema + migration + `TimerServiceLive` in `packages/db`; worker `timer-sweep` cron fires due timer rows into `timer.expired` workflow events using the timer id as `eventId` and case singleton key. `conversation.ask_customer` can set `remindAfterHours`, schedules a `follow_up` timer, maps timer failures to `ToolOutputInvalid`, and the runtime parks the case in `waiting_for_customer` after the ask sends. Verified with focused tool tests, `pnpm build`, worker `build:deps`, and full `pnpm test` (441 passed / 58 skipped).
- [ ] Replay/test mode for agents against historical cases
- [~] **Universal email connectors — provider-neutral inbound/outbound beyond Gmail.** All three connector slices LANDED 2026-06-10; cross-cutting runtime check VERIFIED 2026-06-10 (see below). Outlook OAuth connect verified live; Outlook **inbound→case verified live 2026-06-10** (real Graph subscription + real mailbox message → `message.received` → case opened — after fixing the revoked-row `get` bug below; outbound reply on a live case still unobserved). Remaining: Outlook reply leg, and IMAP end-to-end (needs a test mailbox + the poll cron running). Goal: a merchant on Gmail, Outlook/O365, or any IMAP/SMTP host (PrivateEmail, Zoho, Fastmail, cPanel, custom domain) connects their own mailbox and the agent reads + replies on that same connection. Strategy (2026-06-09): **one connector per _protocol_, not per _brand_** — Gmail API (done) + Microsoft Graph + generic IMAP/SMTP cover the market; PrivateEmail and Zoho are both the IMAP/SMTP connector, not separate code. All implement the existing `ConversationService` Tag (`packages/services/src/conversation-service.ts`); agents/tools/runtime stay untouched (master-plan §16 invariant). See memory `[[project_universal_email_connectors]]`.
  - [x] **Slice 1 — Per-tenant connector router (prerequisite).** LANDED 2026-06-09 (commit `877ecb4`). Today `apps/worker/src/bootstrap.ts:358` picks ONE connector statically per deployment (Gmail-or-Test). Add a dispatching `ConversationService` that resolves the tenant's installed conversation connector via `ConnectorCredentialStore.listForTenant(tenantId)` (filter to conversation providers `gmail`/`outlook`/`imap`, pick the active one) and delegates `fetchThread`/`reply`/`askCustomer` to the matching Live impl. Refactor each connector to expose its inner builder (`make…Conversation(cfg): Effect<impl, never, ConnectorCredentialStore>`) so the router holds all built impls in one context (two Layers can't both provide the `ConversationService` Tag). Bootstrap composes whichever connector env is present + falls back to `ConversationServiceTest`. Tests: dispatch by tenant provider; missing connector → `ConversationAuthMissing`.
  - [x] **Slice 2 — Microsoft Graph connector (Outlook / O365 / Exchange Online).** LANDED 2026-06-09: **2a** connector core — `graph-http`/`graph-token`/`graph-conversation-live` + router wiring (`a4af292`); **2b** OAuth install — `/microsoft/install` + `/microsoft/auth/callback`, `cfg.microsoft`, dashboard-connect routing (`6e0fe6c`); **2c** inbound — `POST /webhooks/conversations/outlook/:tenantId` (validationToken handshake + clientState verify → `message.received`), subscription creation on install + `graph.subscription-renewal` cron + create-if-missing (`d04c1b6`); **2d** dashboard `outlook` card in `_shared.tsx` (`4efd1bd`). ⚠️ **Not yet verified end-to-end** — needs an Azure app registration + public `MICROSOFT_GRAPH_NOTIFICATION_URL` + `MICROSOFT_GRAPH_WEBHOOK_SECRET` to confirm a real Outlook message opens a case (the validationToken handshake + subscription creation only exercise against a live Graph). `provider: "outlook"` (already in the `connector_connections` CHECK + `ConnectorProvider` union + dashboard `PROVIDER_LABELS`). New `packages/providers/src/graph-http.ts` (wire fns: get thread/message, send, build MIME with `In-Reply-To`/`References`; `GraphHttpError` discriminated failure; `fetchImpl` override), `graph-token.ts` (Microsoft identity refresh), `graph-conversation-live.ts` (Live `ConversationService`, refresh via `patchTokens`, error mapping). OAuth install mirroring Gmail: add `"outlook"` to `apps/api/src/install-grant.ts`; new `apps/api/src/microsoft-install.ts` + callback (scopes `Mail.ReadWrite Mail.Send offline_access openid email profile`); store via `ConnectorCredentialStore.put` (shopDomain = UPN). Inbound = Graph subscription webhook `POST /webhooks/conversations/outlook/:tenantId` (handle `validationToken` handshake + change notifications → fetch message → publish `message.received`); subscription created on install, renewed by a `graph.subscription-renewal` pg-boss cron mirroring `apps/worker/src/gmail-watch-renewal-schedule.ts` (Graph mail subscriptions expire ~3 days). Dashboard: add `outlook` to `SUPPORTED_PROVIDERS` + icon in `_shared.tsx` (label/description already present). Tests follow the Gmail set (http, conversation-live, install, webhook).
  - [x] **Slice 3 — Generic IMAP/SMTP connector (the universal catch-all).** LANDED 2026-06-10: **3a** connector core — `imap-smtp` (imapflow/nodemailer/mailparser behind `ImapSmtpOps`) + `imap-smtp-conversation-live` + migration `0017` adding `imap` to the provider CHECK + router wiring (`2a49ea8`); **3b** credential connect endpoint `POST /dashboard/connections/imap` (verifies IMAP+SMTP login then stores, `646530e`); **3c** `imap.poll` cron — per-minute, seeds cursor at top UID then publishes `message.received` past `metadata.lastUid` (`aa34370`). **3d** dashboard credential form at `/connect/imap` + integrations `imap` card + disconnect actions, and fixed the Outlook Connect allowlist gap (`372b10e`). ⚠️ Like Outlook, **not yet verified end-to-end** against a real mailbox. ORIGINAL PLAN: `provider: "imap"` (add to the `connector_connections` CHECK + `ConnectorProvider` union via a migration — the only schema touch; `metadata` jsonb + nullable `refresh_token` already absorb the rest). Credentials: app-password encrypted in `access_token_encrypted`; `metadata = { imapHost, imapPort, smtpHost, smtpPort, security }`; `shopDomain` = mailbox address; `refreshToken`/`tokenExpiresAt` null. New `packages/providers/src/imap-smtp-*.ts` — IMAP read (fetch thread via Message-ID/References, list new since stored UID) + SMTP send (RFC 5322 with threading headers); inject a client factory for tests. `imap-smtp-conversation-live.ts` Live `ConversationService`. Install is **not OAuth** — authenticated `POST /dashboard/connections/imap` that test-logs-in to IMAP+SMTP, then `store.put`; dashboard gets a credential form (host/port/user/password/security) instead of a redirect. Inbound = `imap.poll` pg-boss cron (decided 2026-06-09: polling, not IDLE) that lists new messages per active connector since `metadata.lastUid`, normalizes, publishes `message.received`, advances the cursor — mirrors the `gmail-watch-renewal` cron shape. Tests: imap/smtp wire, conversation-live, poll cursor advance, connect-validation.
  - [x] **Cross-cutting — VERIFIED 2026-06-10 (code trace + tests, no live mailbox needed).** The `message.received → findByThreadId` resume path is provider-neutral and consistent for both new connectors: the `threadId` published on inbound equals the `threadId` `ConversationService.fetchThread`/`reply` later use, so a case opens on the first message and resumes on follow-ups. **Graph:** inbound `threadId` = Graph `conversationId` (`graph-http.ts:298` via `graphGetMessage`); `fetchThread`/`send` query `conversationId eq '<threadId>'` (`graph-http.ts:220`) — Graph keeps a stable `conversationId` across a conversation, so resume is reliable. **IMAP:** inbound `threadId` = `threadRootId = references[0] ?? messageId` (`imap-smtp.ts:101`); `fetchThread` searches INBOX by `message-id|references|in-reply-to = rootId` (`imap-smtp.ts:274`) and `send` stamps `References:[root,…]` so the customer's reply carries the root back. Both connectors skip `direction:"outbound"` (graph-webhook.ts:239, imap-poll.ts:94) so our own replies don't open/resume cases. Runtime keys purely on the opaque `ThreadId` (`agent-runtime.ts:80-94,399` → `case-repository-live.ts:127` `WHERE tenantId AND threadId`). **Webhook routes conform** to §12: `POST /webhooks/conversations/outlook/:tenantId` (server.ts:4368); IMAP is poll-based (no webhook), conforming by absence. **No provider names leak** into agents/tools/runtime logic — only neutral comments and the `fetch-thread` tool description that deliberately lists connectors as interchangeable examples. **Tests:** 41 connector + 7 router green; `pnpm build`/`pnpm test` gate held per slice.
    - [ ] **Known IMAP fragility (follow-up, not a blocker).** Unlike Gmail/Graph (provider-native thread ids), IMAP resume depends on the customer's mail client preserving the `References` header. A reply that carries only `In-Reply-To` and drops `References` falls through `threadRootId` to its own `messageId` → opens a NEW case instead of resuming. Acceptable best-effort for v1; if it bites, add an `In-Reply-To`-based secondary `findByThreadId` lookup (or a Message-ID→threadId side index) before creating a new case in the IMAP path.
    - [ ] **Connect-form autodiscovery follow-ups (2026-06-12, none started).** `/connect/imap` now autodiscovers server settings (see session entry). Polish left on the table: (a) blur-time detection — call `POST /dashboard/connections/imap/discover` when the email field blurs and show a "✓ Zoho Mail detected" chip + the provider's app-password help link BEFORE submit (today discovery runs inside the submit action, so provider help only appears after a failed login); (b) self-published `autoconfig.<domain>/mail/config-v1.1.xml` lookup as a discovery leg — needs the SSRF-guarded fetch (`UrlFetchService`) since that host is merchant-controlled; skipped in v1 because ISPDB+MX+guesses covers nearly everything; (c) widen the MX-suffix preset map (`MX_PRESETS` in `imap-discovery.ts`) as real merchant domains appear — it's deliberately small and hand-curated.
  - [x] **Bugfix — Outlook/IMAP disconnect was a no-op (2026-06-10).** The dashboard Disconnect button + server-actions + api-client all routed `outlook`/`imap` to `POST /dashboard/connections/:provider/disconnect`, but the api's `CONNECTOR_PROVIDERS` allowlist (`server.ts`, `isDisconnectProvider`) only listed `shopify|gmail|google_sheets` → every Outlook/IMAP disconnect 400'd `bad_provider` and the row stayed `active`. Fix: added `outlook` + `imap` to `CONNECTOR_PROVIDERS`, and widened `RevocableProvider` + `revokeConnectorGrant` (`packages/providers/src/oauth-revocation.ts`) to handle them — both are best-effort no-ops returning `already_gone` (Outlook has no client-callable token-revoke endpoint and its Graph subscription self-expires once the renewal cron stops touching the now-revoked row; IMAP is just a stored app-password with nothing provider-side to revoke). Local `store.revoke` is authoritative for both. Tests: +2 unit (`oauth-revocation.test.ts` dispatch) + 2 integration (`dashboard-settings.integration.test.ts` outlook/imap disconnect → 200 + row flips out of `active`). Full `pnpm build` green; providers + api + worker suites green (integration run against local pg).
    - [ ] **Follow-up — account deletion still skips Outlook/IMAP provider-side.** `apps/api/src/account-deletion.ts` `REVOCABLE_GRANT_PROVIDERS` + its local `EncryptedConnectorGrant["provider"]` are still `shopify|gmail|google_sheets`, so tenant deletion never builds revoke grants for `outlook`/`imap` (rows are still wiped locally). That's currently harmless given both revokes are no-ops, but if Outlook ever gets a real provider-side revoke (e.g. `graphDeleteSubscription` threaded with the subscription id from metadata), widen that set too.
  - [x] **Multi-mailbox — a tenant can run several conversation connectors at once (2026-06-10).** Previously the router picked ONE connector per tenant (most-recently-installed active), so a Gmail+Outlook tenant opened cases from both mailboxes but could only reply on one — the other's cases stranded. Now every thread id is **provider-namespaced at the connector boundary**: `gmail:<threadId>`, `outlook:<conversationId>`, `imap:<root Message-ID>`. New `packages/services/src/conversation-thread-id.ts` (`CONVERSATION_PROVIDERS`, `namespaceThreadId`, `parseThreadId` — splits on the FIRST colon only, IMAP Message-IDs may contain colons). The three inbound edges stamp the prefix when publishing `message.received` (`gmail-webhook.ts`, `graph-webhook.ts`, `imap-poll.ts`); `makeConversationRouter` is now pure (no store dependency) and dispatches on the parsed prefix, hands the connector the RAW provider id, re-namespaces ids on results (`ConversationThread.id`/messages, `SentMessage.threadId`), and remaps connector `ThreadNotFound` errors back to the namespaced id. Un-namespaced/unknown prefix → `ThreadNotFound`; known prefix without a configured impl → `ConversationAuthMissing(provider)`. Connector impls stay provider-pure (raw ids); runtime/tools/cases schema untouched (ThreadId stays opaque). **No back-compat by decision**: pre-existing cases hold raw thread ids and won't resume — replies on old threads open fresh namespaced cases (old rows are disposable test data). Supersedes the single-mailbox threadId notes in the cross-cutting entry above. Tests: 7 helper + 10 router (rewritten from store-based resolve) + 3 edge assertions; full suite 1165 green.
    - [x] **Legacy case fallback — dashboard probes active provider/mailbox pairs for unbound rows.** 2026-06-11. Older cases with no bound mailbox/provider were failing closed with `mailbox_ambiguous` even when one of the connected mailboxes could load the thread. Dashboard `GET /dashboard/cases/:id/conversation-thread` now probes active conversation connections by `(provider, mailbox)` before giving up, so legacy rows can resolve to the right thread without reopening the mailbox-lock leak. Verified with `pnpm exec vitest run apps/api/test/dashboard-conversation-thread.test.ts` and `pnpm build`.
    - [x] **Same-provider multi-mailbox — rejected by policy, enforced for IMAP (2026-06-10).** Decision: one mailbox per provider per store, NOT mailbox-namespaced ids. The prefix resolves the _provider_; each impl resolves credentials via bare `get(tenantId, provider)`, so a second active mailbox on the same provider could reply from the wrong account. `POST /dashboard/connections/imap` now 409s `imap_already_connected` (+ the existing mailbox) when another ACTIVE imap row with a different `shopDomain` exists; the SAME mailbox still passes (upsert = password/host rotation); comparison is case-insensitive. Guard sits after parse, before the connectivity check. Dashboard: action maps 409 → `?error=imap_already_connected&mailbox=…`; `/connect/imap` renders a "disconnect first" alert linking to integrations. +2 integration tests (409 on second mailbox; same mailbox passes guard → 400 from verify).
    - [x] **OAuth single-mailbox guard (gmail/outlook) — DONE 2026-06-10.** Same invariant as IMAP, enforced at two layers via pure `apps/api/src/connect-guard.ts` (`activeMailboxConflict` — case-insensitive, revoked rows exempt, same-mailbox re-auth allowed for token repair; `alreadyConnectedRedirect`). (1) `POST /dashboard/connect/:provider` 409s `already_connected` (+ existing mailbox) for gmail/outlook while ANY active row exists — the merchant never reaches the consent screen; shopify/google_sheets exempt. (2) Both OAuth callbacks re-check before `store.put` (manual installs bypass the mint): a DIFFERENT account → browser redirect to `/settings/integrations?error=already_connected&provider&mailbox` (JSON 409 when no dashboard URL / Accept: json); same account proceeds (upsert = repair). Dashboard: `api.connectUrl` returns `{url} | {alreadyConnected}`, `/connect/[provider]` route redirects with the error params, integrations page renders a "disconnect first" alert. Tests: 7 unit (connect-guard) + 3 integration (mint 409 outlook/gmail + disconnect-clears-block + shopify stays open).
  - [x] **Bugfix — Outlook inbound silently dropped every Graph notification when a revoked sibling row existed (2026-06-10).** Symptom: subscription live on Microsoft's side, webhook publicly reachable, real mail in the inbox — yet zero `message.received` ever published and the connection row never token-refreshed. Root cause: `ConnectorCredentialStore.get(tenantId, provider)` _without_ `shopDomain` (the shape `graph-webhook.ts` uses) ran `WHERE tenant_id AND provider LIMIT 1` with **no status filter and no ORDER BY**; with two outlook rows (revoked wrong-account connect from the login_hint saga + the active reconnect) Postgres returned the revoked row → `ConnectorRevoked` → the handler's "no active connection" branch dropped the batch and acked 202, so Graph considered it delivered (no retries, nothing in pg-boss). Fix (`packages/db/src/connector-credential-store-live.ts`): the no-shopDomain branch now orders `status='active'` first, then `updated_at DESC`. TDD: failing integration test reproduced `ConnectorRevoked` exactly, +1 test pinning only-revoked → still `ConnectorRevoked`. Verified live end-to-end on a second api instance: replayed the real Graph notification → token refreshed + `message.received` published + case `f65e6f02` ("order inquiry") opened. Affects every bare `get` caller (gmail webhook, BYOK keys, etc.) — same latent bug everywhere a tenant ever reconnects a provider under a different account. NOTE: the revoked account's own Graph subscription (id `36047159…`) stays live on Microsoft's side until 2026-06-12; its notifications will fail message-fetch harmlessly (fetched via the active token → 404 → logged, acked) and it self-expires.
  - [x] **Bugfix — Connect prefilled (and on Outlook, locked) the wrong account (2026-06-10).** `apps/dashboard/app/connect/[provider]/route.ts` appended `&login_hint=<WorkOS dashboard login email>` to the OAuth URL for every non-Shopify connector. That email is the merchant's _account_, not the support mailbox they're connecting — Microsoft pre-selected / locked onto it on the consent screen so the merchant couldn't pick their mailbox. Fix (decided: drop prefill for ALL OAuth connectors): new pure `connectRedirectUrl(baseUrl, provider, email)` helper in `apps/dashboard/lib/connect-redirect.ts` that NEVER appends a hint (kept as a function so the decision has a regression guard); route now redirects through it and no longer reads `getSession`. +5 unit tests (`apps/dashboard/test/connect-redirect.test.ts`). Build + dashboard `tsc --noEmit` green. NOTE: the api install handlers (`/microsoft/install`, `/google/install`) still _accept_ an optional `login_hint` query param — now unused by the dashboard but harmless (manual installs can still pass one); left in scope-free.
  - [x] **Outlook emails rendered as raw plain-text junk → now formatted + secure (2026-06-13).** Symptom: marketing/notification mail (e.g. Azure) showed in the case thread as the plain-text MIME alternative — invisible preheader spacers (`͏ ‌` = U+034F/U+200C runs) and `<https://…>` reference links — unreadable. Root cause: the Graph connector requested `Prefer: outlook.body-content-type="text"` in both `graphGetConversation` + `graphGetMessage`, so `bodyHtml` was always null and the dashboard fell back to plain text. Gmail/IMAP already capture HTML; only Outlook was text-only. Fix (`packages/providers/src/graph-http.ts`): request `…="html"`, so `bodyHtml` flows through the existing `sanitizeEmailHtml` allowlist (no scripts/inline-styles/remote-images/tracking-pixels; http/https/mailto links only). New module-local `htmlToText` derives a clean `bodyText` for the agent (drops `<script>/<style>/<head>/comments` so CSS never leaks, block tags → newlines, decodes common entities, strips invisible spacer chars) — replaces the old naive `replace(/<[^>]+>/, " ")` that would have dumped CSS into the agent's text. Defense-in-depth: `cleanPlainTextBody` in `apps/api/src/dashboard-conversation-thread.ts` strips the same invisible spacers from the plain-text fallback so genuinely text-only mail is readable too. TDD: 3 new graph-http tests (Prefer=html, html→clean bodyText, invisible-char collapse) + 1 api projection test. Full `pnpm build` green; providers + api suites green (525 passed). FOLLOW-UP: two `htmlToText` impls now exist (graph-http + `url-fetch-html.ts` for KB snapshots) — kept separate (email needs spacer-stripping, KB drops nav/footer); dedup if a third caller appears.
  - [x] **Filtered inline-CSS allowlist so emails render formatted (2026-06-13).** Follow-up to the Outlook-HTML fix: `sanitizeEmailHtml` (`apps/api/src/dashboard-conversation-thread.ts`) previously stripped ALL styling (only `href` on `<a>`), so even HTML emails rendered as bare structure. Now it keeps `style` attributes through a per-property CSS allowlist (`SAFE_STYLES`: color/background-color/font-_/text-_/padding/margin/border*/width/height/display/vertical-align — value regexes reject `url()`/`expression()`/`javascript:` by construction; properties absent from the map like `position`, `background` shorthand, `content` are dropped) plus the presentational table attributes email layout needs (`width`/`align`/`valign`/`bgcolor`/`colspan`/`rowspan`/`cellpadding`…). Decided with user: **filtered inline CSS, NOT an iframe** (iframe explicitly rejected), and **images stay fully blocked** (`<img>` not in the tag allowlist — privacy/anti-tracking; no remote loads, no tracking pixels). Keeping `display:none` means hidden preheader `<div>`s now stay hidden (resolves the earlier preheader-visibility follow-up). Had to re-allow `class`/`id`/`type` attributes — the quoted-reply `exclusiveFilter` keys off them and the new `*`attribute wildcard otherwise hid them from the filter (inert in output; no stylesheet survives). TDD: +4 sanitizer tests (safe styles kept, dangerous css dropped, table attrs kept, display:none kept) + updated the old "strips styles" test. Build + full api suite green (272 passed). Won't match Outlook Web exactly (no`<style>` blocks, no images) but renders colors/fonts/spacing/tables.
  - [x] **`.email-html` reset class — stop the dashboard boxing table-layout email (2026-06-13).** After keeping the email's own inline CSS, marketing email rendered with a border grid: the case-thread body container (`apps/dashboard/app/cases/[id]/page.tsx`) forced `[&_td]:border [&_th]:border [&_table]:w-full [&_*]:p-1` via arbitrary variants — fine for a data table, but table-based email uses a cell per section/spacer, so every cell got boxed. Replaced the long variant string with a single `.email-html` class (plain CSS in `apps/dashboard/app/globals.css`, outside `@layer` so it beats utilities) that zeroes `td/th` border-width+padding (email's own inline `border:`/`padding:` win by specificity), caps `table { max-width:100% }`, and keeps sensible list/link/blockquote defaults. Container now `className="email-html break-words rounded-md bg-muted/30 p-3 text-sm leading-relaxed"`. Only the cases page renders email HTML (approvals page doesn't). Pure presentational change; `pnpm build` green.
  - [x] **Dashboard approve buttons recolored green → brand blue (2026-06-13).** The 4 approve `SubmitButton`s (`apps/dashboard/app/cases/[id]/ApprovalCard.tsx` ×2, `apps/dashboard/app/approvals/[id]/page.tsx` ×2) switched `variant="success"` → `variant="default"` (brand blue `#0057ff`); the email approval-confirm page button (`apps/api/src/approval-endpoints.ts`, `.btn.ok`) recolored `#065f46` → `#0057ff`. Status `<Alert>`/`<Badge>` success variants left green (indicators, not buttons). NOTE: the email confirm page still shows a green "Approve" badge pill above the now-blue button — left for consistency follow-up.
- [ ] Aftership/EasyPost carrier-level tracking integration: `TrackingService` Tag + Live impl, per-tenant carrier credentials (new provider variant in `connector_connections`), `tracking.lookup` tool returning live scan events / exception detail / carrier-normalized status, `POST /webhooks/tracking/:tenantId` for scan-event ingestion → `tracking.changed` domain event. Real per-merchant cost (~$0.01–$0.12 per shipment depending on tier/provider). Defer until a specialist agent actually needs scan-level fidelity beyond what `order.fulfillments` already exposes through `shopify.get_order`; today's "where is my order?" use case is fully served by Shopify's static tracking fields. Master-plan §11 routing table already reserves the webhook path.
- [x] **17track lookup-only integration (platform-managed credentials, graceful degrade when key absent)** — landed 2026-05-26. v1 of `TrackingService`. Single platform-held 17track API key in env (`SEVENTEENTRACK_API_KEY`), Live Layer built at worker bootstrap **when the env var is set**. **No webhook, no proactive push, no `connector_connections` row, no install flow, no `/settings/integrations` card**: the merchant doesn't even know 17track is involved. Used purely on demand from inside an agent turn — `tracking.lookup` tool calls `TrackingService.lookup(tenantId, { carrier, trackingNumber })` after `shopify.get_order` surfaces fulfillment tracking numbers, then the agent stamps the live status into `cases.context` via `case.update_context`. Scope intentionally **does not** include the Aftership/EasyPost-style `tracking.changed` push event — proactive workflows come later when an agent that consumes that event exists. **Graceful degrade**: the `SEVENTEENTRACK_API_KEY` env var is NOT required for the worker to boot or for tests to pass. The Tag's result is a discriminated union — `{ kind: "live", ...status }` when an upstream provider is configured and the call succeeds, OR `{ kind: "no_provider", carrier, trackingNumber, trackingUrl, reason: "no_api_key" | "unsupported_carrier" }` when the platform has no provider wired up (env unset) or the carrier isn't covered. In the `no_provider` branch the tool still returns a useful answer — the bare tracking number + a public tracking URL the customer can click. Agent prompt has two branches: `live` → summarize live status; `no_provider` → "Your tracking number is X — follow it here: <url>". So a fresh repo clone runs the worker + tests with zero 17track setup; turning the key on later upgrades every case to live status with no schema or code change. Tool: `tracking.lookup` (`risk: read`, `defaultPermission: allow`, no `requiredConnectorScopes`). Bind into `order-status-agent` first (its prompt already deals with fulfillment state); `missing-package-agent` picks it up next iteration. When per-tenant Aftership/EasyPost eventually lands, the existing todo entry above carries the proactive-webhook design — they're complementary, not duplicate. Cost rolls up against the platform's 17track subscription; the future cost dashboard will need a line item separate from per-tenant LLM spend. **Shipped**: `TrackingLookup` discriminated union + `TrackingError` tagged variants in `agent-core/payloads.ts` and `errors.ts`; `TrackingConfig` Tag + `TrackingService` Tag + `TrackingServiceTest` + `TrackingServiceNoProvider` in `packages/services`; `seventeentrack-http.ts` (`/track/v2.2/register` + `/track/v2.2/gettrackinfo`, header `17token: <apiKey>`) + `TrackingServiceLive` in `packages/providers`; `tracking.lookup` tool in `packages/tools/src/tracking/lookup.ts`; order-status-agent prompt extended with the optional tracking-enrichment step (skips when no tracking number present, maps "no_provider" → public URL in reply). Worker bootstrap env-gates Live vs NoProvider on `SEVENTEENTRACK_API_KEY` (absent → NoProvider → cleanly returns `kind: "no_provider"`). **+25 tests**: 5 service Test/NoProvider, 8 17track HTTP wrapper (URL/header/response shape + 401/429/500 error mapping), 6 Live (happy + no-provider rejection + rate-limit + auth-failure + register-failure-tolerated + carrier-omit), 4 tool (live + no_provider + error mapping + surface declarations), 2 e2e (order-status-agent with tracking → asserts tool.invoked chain; order-status-agent without tracking → skips tracking step). Bare `next build` + `pnpm build` + `pnpm -w run test` all green.

---

## Phase 6 — Provider abstraction in production

Most of this is absorbed by the Vercel AI SDK + OpenRouter choice (see memory `llm-abstraction`). Remaining work:

- [x] **Per-tenant per-agent model routing config.** 2026-05-21. Tenants pick the model for each agent on `/settings/agents/[id]`; the runtime substitutes that model in `ToolCallingRequest.model` instead of `AgentConfig.model`. Migration `0007_tenant_agent_overrides.sql` adds `tenant_agent_overrides(tenant_id uuid, agent_id text, model text, updated_at, PK(tenant_id, agent_id))` with cascade delete on tenant. New `TenantAgentOverridesService` Tag in `packages/services/src/tenant-agent-overrides.ts` (Test layer included) + Live impl in `packages/db/src/tenant-agent-overrides-live.ts` with upsert / clear. `AgentRuntime` loads the override map once per tick (`overrides.getForTenant(tenantId)` with `Effect.catchAll` to an empty map so DB hiccups don't kill the runtime) and applies it at both `registry.resolve` sites (initial + handoff). Model catalog: new `fetchModelCatalog(provider, apiKey, baseURL?)` in `packages/providers/src/models-catalog.ts` with per-provider fetchers (OpenRouter `/api/v1/models` public, Anthropic `/v1/models` w/ `x-api-key`, OpenAI `/v1/models` w/ Bearer). 10-min in-process TTL cache keyed by `(provider, sha256(apiKey)[0..16])`. OpenRouter filters models to those with `supported_parameters` including `tools`; OpenAI filters to chat prefixes (`gpt-`, `o1`, `o3`, `chatgpt-`). Dashboard: new `apps/dashboard/lib/llm-runtime.ts` resolves the tenant's active LLM credential + loads overrides via the same `ConnectorCredentialStoreLive` + `TenantAgentOverridesServiceLive` layer cake. `apps/dashboard/components/ui/model-combobox.tsx` is a zero-dep Client Component: searchable input + family-grouped list (Claude / Gemini / GPT / Llama / …) + sentinel "Default (agent config)" row for revert. `/settings/agents/[id]` gains a Model card showing effective model + agent default + the picker (only when a provider is connected) + a Reset button when an override exists. Mismatch warning when the override id isn't in the current provider's catalog (provider was switched). Agents list also surfaces the override badge per row. Server Actions `setAgentModelAction` / `clearAgentModelAction` upsert + delete through `TenantAgentOverridesServiceLive`; selecting the default re-clears the row so we don't materialize a dead override. Worker bootstrap wires `TenantAgentOverridesServiceLive` next to the other repos. Tests: +5 unit on the Test+Live service (`packages/services/test/tenant-agent-overrides.test.ts`), +11 unit on the catalog fetchers (`packages/providers/test/models-catalog.test.ts` — covers OpenRouter normalization + tool-call filter + non-2xx error path + cache, Anthropic header + family, OpenAI chat-prefix filter, dispatcher routing), +2 e2e on the runtime substitution (`apps/worker/test/agent-runtime.e2e.test.ts`: override propagates into `ToolCallingRequest.model` and falls through to `AgentConfig.model` when absent). Suite 292 passing / 51 skipped; `pnpm build` + `next build` (17 routes) clean; migration applied (`\d tenant_agent_overrides` shows the composite PK + FK).
- [x] **BYOK — Tenant-supplied LLM provider credentials.** 2026-05-21. Per-tenant LLM credentials land in `connector_connections` with `provider IN ('openrouter','anthropic','openai')`, encrypted via the same AES-256-GCM machinery as Shopify/Gmail. Migration `0006_byok_llm_providers.sql` widens the provider CHECK and adds a partial unique index `connector_connections_active_llm_per_tenant_unique` so at most one LLM provider is active per tenant. New `LLMCredentialResolver` Tag in `packages/services/src/llm-credential-resolver.ts` + Live impl in `packages/db/src/llm-credential-resolver-live.ts` (consults `ConnectorCredentialStore.listForTenant`). `LLMServiceLive` refactored: drops the global `LLMConfig` dep, depends on `LLMCredentialResolver`, builds the matching AI SDK adapter (OpenRouter / Anthropic / OpenAI) on first call per tenant, caches adapters by `(provider, apiKey, baseURL)` in the Layer closure. Installed `@ai-sdk/anthropic` + `@ai-sdk/openai`. `ToolCallingRequest` now carries `tenantId` (resolver lookup key). Runtime maps `LLMCredentialMissing` / `LLMCredentialRevoked` to `human_takeover` with reason `llm_credential_missing` / `llm_credential_revoked` and audits `case.escalated_to_human` — no platform-key fallback in the production path (master-plan §20 honored). Worker bootstrap picks `LLMCredentialResolverLive` when `CREDENTIAL_ENCRYPTION_KEY` is set; else falls back to `LLMCredentialResolverFromLLMConfig` (single-tenant dev, reads `OPENROUTER_API_KEY`). Dashboard `/settings/llm` page (Server Component) renders provider picker + masked-key status + Revoke. Server Actions `connectLlmAction` / `revokeLlmAction` write through `ConnectorCredentialStore`, revoking any prior active LLM row first to honor the new unique index. Surface warning lists agents whose model strings won't resolve through the chosen direct provider. Tests: +3 unit (`LLMCredentialResolverTest`), +4 unit (`LLMServiceLive` per-provider adapter selection + hard-fail), +1 e2e (runtime BYOK hard-fail → human_takeover). Suite 274 passing / 51 skipped; `pnpm build` + `next build` (17 routes incl. `/settings/llm`) clean. Migration applied to local Postgres — `\d+ connector_connections` confirms new CHECK + index.
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
- [x] Migrate `apps/api` from manual `node:http` routing to Fastify (done 2026-06-02). Raw-body HMAC webhooks via `removeAllContentTypeParsers()` + `addContentTypeParser("*", { parseAs: "buffer" })`; route JSON Schemas (`apps/api/src/schemas.ts`) for validation + serialization; OpenAPI via `@fastify/swagger` (`/openapi.json` + `/docs`); pino structured logging; Effect Service Tags unchanged as the business-logic boundary. All 23 install/callback/webhook integration assertions preserved byte-for-byte.
- [x] Refresh `DEPLOY.md` after Path B — verified 2026-06-07. The current front-end section documents the actual OpenNext/Workers build/deploy commands, required runtime/build-time secrets, dashboard middleware-less AuthKit trade-off, custom-domain sequence, and mandatory Cloudflare Access/network gate for `apps/admin`.
- [x] Refresh `docs/shopify-pcd.md` before any merchant-facing filing/contract: updated 2026-06-04 for implemented privacy/DPA acceptance, retention sweep, and audit-log PII redaction status. OTel trace redaction remains a separate hardening follow-up.
- [ ] First real merchant dry run checklist: fresh VPS + real domains + real `deploy/compose/.env`, migrations, `api` health check, WorkOS org/onboarding, Shopify OAuth, Gmail OAuth + Pub/Sub push, R2 attachments/backups, Resend approval mail, merchant BYOK LLM key, inbound message → pending approval → approved reply.
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
