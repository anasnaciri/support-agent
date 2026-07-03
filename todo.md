# Support Agent - Working Checklist

This is the feature-focused checklist for the AI Support Operations Platform.
Architectural detail lives in [`master-plan.md`](./master-plan.md). Working
rules live in [`AGENTS.md`](./AGENTS.md).

Keep this file about:

- Features and fixes already implemented.
- Features, hardening, and follow-ups still to implement.
- Architecture deviations that future work must respect.
- Invariants and verification gates.

Do not use this file for rollout logs, git bookkeeping, or incident transcripts.

---

## Current Focus

- [ ] Replay or explicitly handle held `supplier.updated` context after a
      pending approval is decided.
- [ ] Finish case-recovery hardening follow-ups: non-Gmail send dedup where
      feasible, and epoch handling for timer/supplier events.
- [ ] Add deterministic automated-mail guards before triage and before sending
      customer replies.
- [ ] Improve connector-health surfacing when live thread load or manual reply
      detects revoked credentials.
- [ ] Tighten API rate-limit keying so limits are per actor, not per proxy or
      server egress IP.
- [ ] Ensure CI runs DB-gated integration suites, especially Drizzle seam tests.
- [ ] Add LLM fallback chains and cost dashboards.

---

## Implemented Feature Ledger

### Runtime And Case Lifecycle

- [x] Effect runtime spine with typed services, state-machine guarded case
      transitions, audit logging, approvals, and pg-boss workflow queue.
- [x] Permission service is enforced for tool execution, including refund and
      customer-reply approval gates.
- [x] Case lifecycle writes centralized through `CaseLifecycleWriter` for
      runtime, dashboard, worker recovery, and manual case actions.
- [x] Dashboard manual status changes, take-over, resume, retry last step, and
      restart-from-triage.
- [x] Restart-from-triage rebinds to triage, clears stale classification, and
      cancels pending approvals from the abandoned route.
- [x] Resumed cases can replay the full conversation thread so triage and
      specialists re-orient from actual messages.
- [x] Human-takeover guard prevents autonomous handling until a manager resumes
      the case.
- [x] Failed customer-reply delivery parks the case, persists a retryable
      delivery row, and exposes manual retry.
- [x] Approved-but-not-sent replies are detected and can be resent from the
      dashboard without leaving human takeover.
- [x] Approval bundles support per-row decisions, approve-all, and
      reject-remaining.
- [x] Approval reminder pass nudges still-pending approvals instead of relying
      only on first notification.
- [x] Approval row age no longer blocks dashboard decisions; stale drafts show
      a non-blocking warning.
- [x] Workflow consumer runs multiple case keys concurrently while preserving
      per-case ordering.
- [x] Workflow ticks, LLM calls, tool calls, and Shopify HTTP calls have bounded
      timeouts.
- [x] Out-of-credits LLM failures map to terminal human takeover instead of
      retry exhaustion.
- [x] Delivery-scoped tool execution markers prevent one customer message from
      deduping another distinct customer message.
- [x] `deliveryScopeFor` falls back to non-bare keys so legacy markers cannot
      collide with malformed events.
- [x] Case recovery hardening added approval epochs, resumed markers,
      event-level dedup, Gmail deterministic Message-ID dedup, and stale
      approval-event handling.
- [x] Order identity mismatch cannot auto-resolve on a bare final message; the
      runtime and lifecycle writer enforce this.
- [x] Identity mismatch now acts as an agent judgment hint while preserving
      human approval before first cross-email disclosure.

### Conversations And Connectors

- [x] Provider-neutral conversation/mailbox service with Gmail, Outlook, and
      IMAP/SMTP connector paths.
- [x] Cases record the exact provider and mailbox, and thread lookup is scoped
      by tenant/provider/mailbox/thread.
- [x] Gmail and Outlook OAuth flows use verified dashboard identity where
      required and avoid account-prefill mistakes for support mailboxes.
- [x] `Reply-To` is honored so replies to Shopify contact-form mail go to the
      real customer instead of the relay address.
- [x] IMAP replies correlate through an indexed message-id table before minting
      a new case.
- [x] Outlook fetches sanitized HTML email bodies and derives clean plain text
      for the agent.
- [x] Sanitized email HTML keeps safe inline formatting, table layout attrs, and
      blocks remote images and dangerous CSS.
- [x] Dashboard email rendering no longer boxes table-layout emails or overflows
      long tokens.
- [x] Dark-mode email paper treatment is adaptive: only inbound HTML with its
      own colors gets a light paper surface.
- [x] Connector health metadata is rendered in integrations when already present.

### Shopify, Orders, Refunds, Discounts, And Tracking

- [x] Shopify service covers customer, order, fulfillment, refund, cancellation,
      policy import, and store-info paths.
- [x] Order lookup binds one canonical Shopify order id on the case and stores
      fuzzy customer-provided refs separately.
- [x] Customer resolution falls back through email, labelled phone, and display
      name; manual case-detail edit can override customer and order metadata.
- [x] Verified order email is runtime-stamped and surfaced on identity-mismatch
      cases.
- [x] Order/customer mismatch checks compare the resolved customer id as well as
      the order email for read-only disclosure.
- [x] Refund modal supports line items, restock options, shipping refund, reason,
      and maximum-refundable validation.
- [x] Agent-recommended refunds can be issued from the case page.
- [x] Shopify `refundCreate` no longer queries invalid `code` on `UserError`.
- [x] Shopify `refundCreate` uses the required `@idempotent` directive with a
      deterministic idempotency key.
- [x] Shopify GraphQL top-level errors map to typed, descriptive errors instead
      of generic network failures.
- [x] Built-in "cancel my order" scenario uses `order.cancel` behind the same
      permission path as refunds.
- [x] Discount/coupon tool issues bounded, single-use, customer-locked goodwill
      coupons through tenant discount policy.
- [x] 17track lookup-only `TrackingService` enriches order-status flows and
      gracefully returns public tracking URLs when no provider is configured.
- [x] Live case tracking card fetches fresh tracking data when a case has a
      tracking number.
- [x] Shopify integration capability grid distinguishes scopeless tools from
      real missing scopes and shows platform capabilities.

### Suppliers

- [x] Supplier portal closes the escalation loop: agent escalates, case waits,
      supplier posts an update, and the agent drafts the customer reply.
- [x] Supplier notification uses a durable outbox ledger rather than
      best-effort send.
- [x] Supplier updates re-engage the agent from all allowed resting states a
      person can leave the case in.
- [x] Supplier update payloads carry escalation ids so repeat escalations do not
      cross-dedup.
- [x] Suppliers can be bound to many merchant workspaces through an
      org-independent binding model.
- [x] Merchant and supplier workspaces merge into one switcher, with permissions
      resolved per active workspace kind.
- [x] Supplier portal pages use a constrained projection and do not expose full
      customer thread data.

### Dashboard And SPA

- [x] Merchant dashboard includes Today, case list, case detail, approvals,
      audit, settings, members, integrations, policies, knowledge, and supplier
      surfaces.
- [x] Case detail page uses the inbox-style layout with left case navigation,
      center conversation, and right/floating context panels.
- [x] Manual reply composer supports approve/reject flows, direct replies,
      rephrase-with-AI, model picker, and locked agent-owned state.
- [x] Cases list has richer rows, reference-style tabs, status filtering,
      search, priority/status/order metadata, and subject fallbacks.
- [x] Case tracking checkpoint rail renders as a continuous timeline in both
      dashboard surfaces.
- [x] Case context renders friendly labelled rows instead of raw JSON.
- [x] Dark-mode palette and theme switch landed for the SPA.
- [x] SPA port uses Vite, TanStack Router, TanStack Query, cookie BFF auth,
      workspace context, and route-level read/write pages.
- [x] SPA case page supports mutations, approval decisions, refund modal,
      supplier update form, live refetch boundary, and settings forms.
- [x] SPA onboarding self-heals org-less sessions and avoids redirect loops
      when the current user has no accessible workspace.
- [x] BFF auth supports login, callback, session refresh, logout, onboarding,
      CSRF guard, and credentialed CORS.
- [x] Public onboarding page redirects signed-in users with existing workspaces.

### Auth, Workspaces, RBAC, And Admin

- [x] Dashboard API verifies WorkOS access tokens instead of trusting shared
      dashboard tokens or self-asserted headers.
- [x] BFF cookie auth is additive to existing bearer-JWT dashboard auth.
- [x] Workspaces are tenant rows under one WorkOS org; dashboard requests pin
      the active workspace by validated `x-workspace-id`.
- [x] Workspace switcher, workspace creation, workspace delete, and account
      delete are implemented.
- [x] Member RBAC supports code permission catalog, editable roles,
      per-workspace assignments, and WorkOS invitations.
- [x] Refund approvals require `refunds.issue` in addition to approval-decision
      permission.
- [x] Admin console supports tenant inspection, Shopify provisioning, connector
      health, and account deletion workflows.
- [x] Pilot Shopify provisioning enforces per-tenant custom app credentials,
      install-link support, deterministic shop routing, and compliance webhooks.
- [x] Pilot and SaaS are runtime/config variants of this repo, not forked source.

### Agents, Policy, Knowledge, And Models

- [x] Vercel AI SDK + OpenRouter-first provider abstraction is wrapped by
      `LLMService`.
- [x] Tenant-supplied LLM credentials are encrypted connector credentials, with
      OpenRouter, Anthropic, and OpenAI support.
- [x] Tenants can override the model per agent from the dashboard.
- [x] Knowledge base supports tenant docs, SSRF-guarded URL import, and Shopify
      policy import.
- [x] General-inquiry, order-status, missing-package, damaged-product,
      refund-review, and scenario-resolution flows exist.
- [x] Resolution Policy stores per-scenario playbooks in tenant settings, with
      built-ins and merchant-authored custom scenarios.
- [x] Scenario-resolution agent runs alongside legacy specialists behind a
      tenant flag and can queue multiple gated actions before parking.
- [x] Merchant notification fan-out supports email plus linked Telegram where
      configured.
- [x] Custom merchant agents can be authored and assigned.

### Platform Hardening

- [x] `apps/api` uses Fastify with raw-body webhooks, schemas, OpenAPI, pino, and
      feature-first route modules.
- [x] Account deletion captures provider grants before data wipe and retries
      revocation failures.
- [x] Credential encryption supports primary and previous keys for rotation.
- [x] Shopify PCD handling, legal/DPA acceptance, retention sweep, and audit PII
      redaction are implemented at the documented level.
- [x] Test teardown purges leaked tenants in dependency order.
- [x] API feature modules replaced the old large composition file.
- [x] Agent runtime was decomposed into named phases while keeping stateful
      runtime behavior in one module.

---

## Implementation Backlog

### Runtime And Reliability

- [ ] Add replay/resume behavior for held `supplier.updated` events after
      approval decisions.
- [ ] Add merchant-facing recovery when supplier notification attempts exhaust
      and the case is still waiting for supplier.
- [ ] Allow a supplier correction or second update to the same escalation, or
      make the required new escalation flow explicit in the UI.
- [ ] Add epoch handling to timer and supplier events, building on
      `cases.epoch`.
- [ ] Evaluate IMAP/SMTP pre-send dedup scan; Graph cannot rely on custom
      Message-ID.
- [ ] Dedup approval-maintenance republish by case key when a job is already
      pending or active.
- [ ] Stop the scenario-resolution `get_order -> OrderNotFound` retry loop and
      review its max-turn budget.
- [ ] Consider prioritizing approval events over message-received events.
- [ ] Enrich `timer.expired` ticks with thread/context like `case.resumed`.
- [ ] Make failed reply-delivery capture atomic with case park and audit writes,
      or document the intentional best-effort boundary.
- [ ] Add immediate sweep after manual reply-delivery retry instead of waiting
      for the scheduled pass.
- [ ] Add cumulative discount aggregation by case.
- [ ] Prototype bounded `agent.delegate` / structured-report subagents on one
      narrow read-only flow.

### Connectors And Email Safety

- [ ] Add pre-triage automated/bulk/no-reply/bounce detection using sender
      patterns and preserved headers.
- [ ] Add hard send-recipient guard so customer replies cannot be sent to
      no-reply, bounce, or automated addresses.
- [ ] Preserve automated-mail headers across Gmail, Outlook, and IMAP inbound
      payloads where connectors expose them.
- [ ] Stamp connector health as broken when case-thread load or manual reply
      sees auth failure.
- [ ] Explain old revoked-IMAP cases clearly when the active mailbox is now
      Gmail and cannot fetch old provider thread ids.
- [ ] Deepen IMAP thread view to use indexed message ids instead of a single
      root-only `fetchThread` lookup.
- [ ] Consider connector-side draftId send dedup as a second layer below runtime
      tool-execution markers.
- [ ] Consider a worker-local connector supervisor for Gmail watch renewal,
      Graph subscription renewal, and IMAP poll passes.

### Shopify, Refunds, Orders, And Tracking

- [ ] Migrate `orderCancel` from deprecated `refund` argument to `refundMethod`.
- [ ] Add per-keystroke `suggestedRefund` re-quote for exact tax on partial
      refund selections.
- [ ] Expand discount policy for products, collections, and minimum
      requirements when merchants need it.
- [ ] Resolve customer panels from verified order email or resolved order
      customer id.
- [ ] Decide whether refund mismatch guard should use resolved customer id or
      remain email-strict.
- [ ] Add Aftership/EasyPost carrier integrations with per-tenant credentials
      and proactive `tracking.changed` webhook ingestion.

### Suppliers

- [ ] Add merchant-facing supplier list and pending invitation management if the
      invite-only settings surface is insufficient.
- [ ] Add per-vendor supplier routing instead of one default supplier.
- [ ] Revisit `supplierMode` semantics in autonomous loop so wait vs
      notify-and-proceed is enforced after gated supplier actions.
- [ ] Keep supplier access binding-based; never fall back to org membership for
      supplier portal authorization.

### Dashboard And SPA

- [ ] Surface canceled approval count after restart-from-triage.
- [ ] Fix legacy relay cases where corrected `customerEmail` updates display but
      connector replies still target original thread recipients.
- [ ] Mirror dark-mode or email-rendering improvements between dashboard apps
      only for the app that remains user-facing.
- [ ] Add optional polish: AI-suggest reply chips, bubble avatars, status/priority
      pill audit, and order/case timeline rail.
- [ ] Add workspace rename UI.
- [ ] Add a distinct workspace-deleted platform email template if merchants need
      receipts for single-workspace deletion.
- [ ] Add stable handling for simultaneous last-workspace deletes.
- [ ] Reintroduce shareable URL filters in SPA tables if needed; current SPA
      filtering is local state.

### Auth, RBAC, Workspaces, And Admin

- [ ] Add per-workspace member visibility and roles; current org members can
      see all workspaces in their org.
- [ ] Track WorkOS membership ids so member removal can remove org membership,
      not only local assignments.
- [ ] Harden pending-invite revoke with WorkOS-side revoke when possible.
- [ ] Add one-shot backfill for existing multi-member orgs if owner assignment
      gaps appear.
- [ ] Make `createTenantForOrg` idempotency index-backed again or lock the
      two-tab onboarding race.
- [ ] Add per-operator admin identity and richer admin audit controls.
- [ ] Decide whether admin shared-password auth remains acceptable past pilot.

### Policy, Agents, Models, And Cost

- [ ] Implement LLM fallback chains.
- [ ] Add cost dashboards by model, provider, agent, case, and tenant.
- [ ] Add platform vs tenant-billed LLM cost reporting for 17track and future
      shared services.
- [ ] Remove hardcoded specialist prompt paths only after the scenario agent
      proves equivalent behavior on the target flows.
- [ ] Add tone/brand tests for customer-facing replies.
- [ ] Add replay/test mode for agents against historical cases.

### Security, Compliance, And Operations Hardening

- [ ] Rename Next middleware/proxy code once the Next version decision settles.
- [ ] Fix API rate-limit keying behind proxies and for server-side dashboard
      egress.
- [ ] Ensure CI sets `DATABASE_URL` for real Drizzle integration tests.
- [ ] Finish OTel trace redaction follow-up from Shopify PCD review.
- [ ] Add load testing for 10k cases/day per tenant.
- [ ] Add chaos tests for provider failure, DB failover, and queue lag.
- [ ] Polish SOC 2 audit-trail reporting.
- [ ] Write incident playbooks and on-call runbook.
- [ ] Build tenant onboarding checklist and setup wizard.

### Plugins

- [ ] `definePlugin` SDK in `packages/plugins/sdk` plus loader.
- [ ] Slack plugin richer than approval-only interactions.
- [ ] ShipStation or supplier-specific plugin as first proof.
- [ ] Plugin settings UI in dashboard.

---

## Architecture Decisions And Deviations

- [x] LLM stack uses Vercel AI SDK with OpenRouter first. `LLMService` is a thin
      Effect wrapper, not hand-rolled per-provider Effect layers.
- [x] Customer conversations use provider-neutral mailbox connectors. Gmail is
      only the first implementation; the same tenant connection reads and sends.
- [x] Platform/system email uses Resend from a platform domain. Customer replies
      never use Resend.
- [x] Pilot and SaaS modes are runtime/config variants of one repo, not forked
      source.
- [x] 17track v1 is platform-managed and lookup-only. Proactive tracking belongs
      to later Aftership/EasyPost style integrations.
- [x] Supplier identity is binding-anchored and can span many merchant
      workspaces, superseding the old one-supplier-one-workspace decision.
- [x] Approval rows do not expire by age; email approval links remain bounded,
      and stale drafts are warned rather than blocked.
- [x] Member RBAC uses plain dashboard DB functions, not an Effect service tag,
      because agents do not consult human RBAC.
- [x] Scenario-resolution agent was added beside legacy specialists behind a
      flag instead of replacing specialist prompts in one step.
- [x] `supplier.notify` was not built; `supplier.escalate` is the supplier
      contact primitive.
- [x] SPA keeps the existing flat dashboard package layout instead of moving
      code under `src/`.

---

## Always-True Invariants

- `agent-core` imports nothing from `services`, `tools`, `db`, or `providers`.
- `PermissionService` is consulted before every tool execution.
- Audit-log writes share the transaction with case state changes.
- Case state machine guards every status transition.
- Effect service tags stay abstract in `packages/services`; live impls live in
  `packages/db`, `packages/providers`, or feature packages.
- Customer-facing replies and money actions stay approval-gated unless tenant
  policy explicitly allows the exact action.
- A case in `human_takeover` never runs the agent until an explicit resume.
- Failed customer-reply delivery must never resolve the case.
- Delivery-scoped side-effect markers must not dedup distinct inbound messages.
- Supplier portal access is by supplier binding, never by WorkOS org membership.
- Path-B dashboard data arrives over JSON; Date-typed API fields must be coerced
  before calling Date methods.
- `pnpm build` must be green before stopping.

---

## Working Agreement

1. Read this file first at the start of every session.
2. Read `master-plan.md` after this file for architectural context.
3. Keep this checklist focused on features, pending implementation work,
   architecture decisions, and invariants.
4. Verify before ticking a checkbox.
5. Add discovered implementation follow-ups here instead of silently widening
   scope.
6. Record any master-plan deviation here and in memory.
7. Do not end with a broken `pnpm build`.
