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

- [x] Dashboard SPA GlassSwitch resting treatment refined (2026-07-06):
      `apps/dashboard-spa/components/ui/glass-switch.tsx` now keeps the thumb
      as an opaque solid surface at rest, reveals the glass/refraction layers
      only while the switch is changing state or being pressed/dragged, slows
      the shared switch motion to 450ms, and reduces the disabled fade so
      disabled scenarios stay readable. Verified with
      `pnpm --filter @support-agent/dashboard-spa build` and `pnpm build`.
- [x] Dashboard SPA composer beam theme mapping fixed (2026-07-06):
      `ChatComposer` now reads the persisted dashboard theme preference from
      the existing `theme` localStorage-backed store, maps app `system` to
      Beam `auto`, and resolves the OS color scheme only for strength: dark
      idle/typing strength `0.45`, light idle/typing strength `0.7`, and
      machine work (`processing` or rephrase in flight) stays `0.8`. Verified
      with `pnpm vitest run apps/dashboard-spa/test/composer-beam.test.ts`,
      `pnpm --filter @support-agent/dashboard-spa build`, and `pnpm build`.
- [x] Dashboard SPA settings simplification (2026-07-06): renamed the UI route
      `/settings/resolution-policy` to `/settings/scenarios` with a client
      redirect from the old path; replaced the multi-agent settings UI with a
      single `/settings/agent` page pinned to `scenario-resolution-agent`; and
      removed the standalone `/settings/permissions` matrix in favor of the
      agent page's Actions card under a Permissions heading. Verified by the
      nav-model regression test, `pnpm build`, full `pnpm test` outside the
      sandbox, and commit-hook local CI (build + migrations + full tests).
      Intentional follow-ups/deviations to remember: the dashboard API contract
      still uses `/resolution-policy` / `qk.resolutionPolicy` /
      `lib/parse-resolution`, and custom agents remain functional in the
      backend (`tenant_custom_agents`, resolver, API) while merchants no longer
      have UI to create/edit/delete them.
- [x] `apps/dashboard` (Next) declared obsolete (2026-07-06): its tests are
      excluded from the vitest suite (`apps/dashboard/**` in
      `vitest.config.ts` exclude). `apps/dashboard-spa` is the dashboard.
      Its Cloudflare Worker (`support-agent-dashboard`) was deleted 2026-07-06
      (workers.dev now 404s; no custom domain pointed at it — the
      `app.nacirianas.com` mapping was never created; SPA Worker
      `support-agent-dashboard-v2` unaffected, still 200). The Next source
      tree itself still exists (and still builds via `tsc -b`); deleting it
      is a separate decision.
- [x] Concurrent wait states: a ticket can wait on approval AND a supplier at
      once. Status stays the single `primaryWaitStatus` pointer (approval wins);
      both waits are row-derived and shown as chips; a supplier update on a
      waiting-for-approval ticket redrafts (supersedes pending approvals + resumes).
- [x] SPA settings OVERVIEW fixed (2026-07-05): the `/settings/$` splat
      Placeholder route was SHADOWING the exact `/settings` route, so the
      overview rendered "This page is being ported to the SPA" instead of
      `SettingsPage`. TanStack ranks a same-prefix splat above the bare static
      route for the bare path (verified: `matchRoutes("/settings")` →
      `/settings/$`). The splat was a leftover from the incremental port and is
      now obsolete (all settings pages are routed), so it was removed; unknown
      `/settings/*` now correctly hit the NotFound component. Regression test:
      `test/settings-route-matching.test.ts`.
- [x] Dashboard SPA audit page hidden (2026-07-05): `/audit` is no longer
      registered in `apps/dashboard-spa/router.tsx`, and the Audit item is
      hidden from the icon rail and ticket timeline. The page/source and hidden
      timeline path remain in place with "do not delete" comments so they can
      be restored later. Regression test:
      `apps/dashboard-spa/test/audit-page-hidden.test.ts`; verified with the
      focused test, `pnpm build`, and full `pnpm test` outside the sandbox
      because local server tests need bind permissions.
- [x] Dashboard SPA 404 fallback added (2026-07-05): unknown routes now render
      a dedicated `NotFoundPage` with a "Back home" button linking to `/`,
      instead of the generic porting Placeholder. Regression test:
      `apps/dashboard-spa/test/not-found-page.test.ts`; verified with the
      focused test and `pnpm build`.
- [x] Re-swept apps/dashboard → dashboard-spa: every Next page has a real SPA
      route + component (no Placeholder stubs remain outside the router's
      NotFound fallback). Earlier sweep fixed /sign-up, /workspaces/new, dead
      View-notice URL; the only remaining defect was the settings-overview
      splat shadow above.
- [ ] Remove `waiting_for_approval` / `waiting_for_supplier` from the
      agent-settable `ticket.update_status` enum (`packages/tools/src/ticket/update-status.ts`)
      — those are runtime-owned parks, not agent-settable; agent-visible schema
      change, own slice.
- [x] Completed the deliberate ticket domain vocabulary migration: product
      docs, code symbols, UI copy, routes/RBAC, tool/audit names, DB
      tables/columns, and new migration now use ticket terminology. Verified
      with the codemod dry-run, targeted old-identifier sweeps, full Vitest
      run, DB-gated suites, and `pnpm build`; historical migrations keep prior
      names as migration history. Post-review cleanup removed stale duplicate
      route-alias tests after the old aliases were dropped.
- [x] Backfilled persisted `context.riskFlags` that the vocabulary rename missed
      (2026-07-05): the case→ticket rename (40084e6) changed only what the
      perceptual-hash guard STAMPS, so existing tickets still carried
      `duplicate_photo_seen_in_case_<id>` and the dashboard rendered a mix of
      "seen in case <uuid>" (stale flag humanized) and "seen on another ticket".
      Migration `0037_backfill_duplicate_photo_flags.sql` rewrites the leading
      marker to `duplicate_photo_seen_in_ticket_<id>` in place (id + array order
      preserved, other flags untouched) AND de-duplicates the array: the runtime
      dedupes flags with a Set keyed on the raw string, so a prior ticket flagged
      under both vocabularies over time kept both, and the rename would otherwise
      yield two identical `..._in_ticket_<id>` entries — the pass keeps each
      flag's first occurrence. Verified against local Postgres:
      `packages/db/test/backfill-duplicate-photo-flags.integration.test.ts`
      (6 cases) + `drizzle-kit migrate` applies cleanly and is idempotent.
      Lesson: a value-rename that touches strings persisted in JSON columns needs
      a data backfill, not just a code/table rename.
- [x] General `context.riskFlags` de-dup (2026-07-05): 0037 only de-duplicated
      rows that still had a legacy `_case_` flag, so pre-`includes()`-guard
      arrays with a pure `duplicate_photo_seen_in_ticket_<id>` twin survived and
      the card still counted "N tickets" with a repeat. Migration
      `0038_dedup_risk_flags.sql` collapses ANY exact-duplicate array entry
      (order-preserving, first occurrence), gated on `length > distinct count`.
      Verified: `packages/db/test/dedup-risk-flags.integration.test.ts` (5 cases)
      + local `drizzle-kit migrate`. The dashboard `buildRiskFlagBadges` also
      counts DISTINCT tickets now, so the chip is correct even before the
      backend redeploys and runs 0038.
- [ ] Finish ticket-recovery hardening follow-ups: non-Gmail send dedup where
      feasible, and epoch handling for timer/supplier events.
- [ ] Add deterministic automated-mail guards before triage and before sending
      customer replies. (The manual blocked-senders list landed 2026-07-05;
      this item is the automatic complement: Auto-Submitted / Precedence:bulk /
      no-reply detection.)
- [ ] Surface dropped blocked-sender mail to the merchant (counter or audit
      trail) — v1 only writes a worker log line for each drop.
- [ ] Improve connector-health surfacing when live thread load or manual reply
      detects revoked credentials.
- [ ] Tighten API rate-limit keying so limits are per actor, not per proxy or
      server egress IP.
- [ ] Ensure CI runs DB-gated integration suites, especially Drizzle seam tests.
- [ ] Isolate DB-gated integration test data so the full Vitest suite can run
      with file parallelism; 2026-07-04 ticket-migration verification needed
      `--fileParallelism=false` because teardown tests mutate shared DB state.
- [ ] Add LLM fallback chains and cost dashboards.

---

## Implemented Feature Ledger

### Runtime And Ticket Lifecycle

- [x] Effect runtime spine with typed services, state-machine guarded ticket
      transitions, audit logging, approvals, and pg-boss workflow queue.
- [x] Permission service is enforced for tool execution, including refund and
      customer-reply approval gates.
- [x] Ticket lifecycle writes centralized through `TicketLifecycleWriter` for
      runtime, dashboard, worker recovery, and manual ticket actions.
- [x] Dashboard manual status changes, take-over, resume, retry last step, and
      restart-from-triage.
- [x] Manual escalate-to-supplier from the ticket page (⋮ menu → dialog):
      `POST /dashboard/tickets/:id/escalate-supplier` writes the escalation row
      (the notify outbox) and parks via `parkWaitingForSupplierManually` —
      bridges from `human_takeover`, keeps `waiting_for_approval` primary.
- [x] Ticket-header actions rework: Refund is a text button, Resolve carries its
      label, retries live in a dedicated ↺ dropdown ("Retry last step" /
      "Retry ticket"), ⋮ menu holds status changes + supplier escalation.
- [x] Restart-from-triage rebinds to triage, clears stale classification, and
      cancels pending approvals from the abandoned route.
- [x] Resumed tickets can replay the full conversation thread so triage and
      specialists re-orient from actual messages.
- [x] Human-takeover guard prevents autonomous handling until a manager resumes
      the ticket.
- [x] Failed customer-reply delivery parks the ticket, persists a retryable
      delivery row, and exposes manual retry.
- [x] Approved-but-not-sent replies are detected and can be resent from the
      dashboard without leaving human takeover.
- [x] Approval bundles support per-row decisions, approve-all, and
      reject-remaining.
- [x] Approval reminder pass nudges still-pending approvals instead of relying
      only on first notification.
- [x] Approval row age no longer blocks dashboard decisions; stale drafts show
      a non-blocking warning.
- [x] Workflow consumer runs multiple ticket keys concurrently while preserving
      per-ticket ordering.
- [x] Workflow ticks, LLM calls, tool calls, and Shopify HTTP calls have bounded
      timeouts.
- [x] Out-of-credits LLM failures map to terminal human takeover instead of
      retry exhaustion.
- [x] Delivery-scoped tool execution markers prevent one customer message from
      deduping another distinct customer message.
- [x] `deliveryScopeFor` falls back to non-bare keys so legacy markers cannot
      collide with malformed events.
- [x] Ticket recovery hardening added approval epochs, resumed markers,
      event-level dedup, Gmail deterministic Message-ID dedup, and stale
      approval-event handling.
- [x] Order identity mismatch cannot auto-resolve on a bare final message; the
      runtime and lifecycle writer enforce this.
- [x] Identity mismatch now acts as an agent judgment hint while preserving
      human approval before first cross-email disclosure.

### Conversations And Connectors

- [x] Provider-neutral conversation/mailbox service with Gmail, Outlook, and
      IMAP/SMTP connector paths.
- [x] Tickets record the exact provider and mailbox, and thread lookup is scoped
      by tenant/provider/mailbox/thread.
- [x] Gmail and Outlook OAuth flows use verified dashboard identity where
      required and avoid account-prefill mistakes for support mailboxes.
- [x] `Reply-To` is honored so replies to Shopify contact-form mail go to the
      real customer instead of the relay address.
- [x] IMAP replies correlate through an indexed message-id table before minting
      a new ticket.
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
- [x] Order lookup binds one canonical Shopify order id on the ticket and stores
      fuzzy customer-provided refs separately.
- [x] Customer resolution falls back through email, labelled phone, and display
      name; manual ticket-detail edit can override customer and order metadata.
- [x] Verified order email is runtime-stamped and surfaced on identity-mismatch
      tickets.
- [x] Order/customer mismatch checks compare the resolved customer id as well as
      the order email for read-only disclosure.
- [x] Refund modal supports line items, restock options, shipping refund, reason,
      and maximum-refundable validation.
- [x] Agent-recommended refunds can be issued from the ticket page.
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
- [x] Live ticket tracking card fetches fresh tracking data when a ticket has a
      tracking number.
- [x] Shopify integration capability grid distinguishes scopeless tools from
      real missing scopes and shows platform capabilities.

### Suppliers

- [x] Supplier portal closes the escalation loop: agent escalates, ticket waits,
      supplier posts an update, and the agent drafts the customer reply.
- [x] Supplier notification uses a durable outbox ledger rather than
      best-effort send.
- [x] Supplier updates re-engage the agent from all allowed resting states a
      person can leave the ticket in.
- [x] Supplier update payloads carry escalation ids so repeat escalations do not
      cross-dedup.
- [x] Suppliers can be bound to many merchant workspaces through an
      org-independent binding model.
- [x] Merchant and supplier workspaces merge into one switcher, with permissions
      resolved per active workspace kind.
- [x] Supplier portal pages use a constrained projection and do not expose full
      customer thread data.
- [x] Suppliers can fix the order's tracking number from the escalation page
      (a reship went out under a new number): `POST
      /dashboard/supplier/tickets/:id/tracking` → unit-tested
      `updateSupplierTracking` core → `ShopifyService.updateFulfillmentTracking`
      (Shopify `fulfillmentTrackingInfoUpdate`, `notifyCustomer: false` — the
      customer hears it from the agent, never a store email). Open escalations
      only (404 walls, 409 once resolved). Fulfillment picked by matching the
      escalation's tracking projection, else the order's single fulfillment;
      several-without-match is refused (`ambiguous_fulfillment`), not guessed.
      Bookkeeping tx: escalation tracking re-stamped + stale
      `context.liveTrackingStatus` cache dropped + `supplier.tracking_updated`
      audit row. Does NOT resolve the escalation — the supplier's posted
      update stays the thing that re-engages the agent.
- [x] Concurrent wait states: a ticket can hold a pending approval AND an open
      supplier escalation at once. `tickets.status` stays the single
      `primaryWaitStatus` pointer (approval wins); both waits are row-derived
      (pending approvals / open escalations) and surfaced as `waitingOn` chips.
      The tick that queues an ask-gated reply then escalates parks the bundle
      (`waiting_for_approval`), the supplier notify outbox keys on the open
      escalation row (not status), an approval resume parks on the supplier
      while an escalation is open, and a supplier update on a
      waiting-for-approval ticket redrafts (supersedes pending approvals + resumes
      so the agent drafts fresh).

### Dashboard And SPA

- [x] Merchant dashboard includes Today, ticket list, ticket detail, approvals,
      audit, settings, members, integrations, policies, knowledge, and supplier
      surfaces.
- [x] Ticket detail page uses the inbox-style layout with left ticket navigation,
      center conversation, and right/floating context panels.
- [x] Manual reply composer supports approve/reject flows, direct replies,
      rephrase-with-AI, model picker, and locked agent-owned state.
- [x] Tickets list has richer rows, reference-style tabs, status filtering,
      search, priority/status/order metadata, and subject fallbacks.
- [x] Ticket tracking checkpoint rail renders as a continuous timeline in both
      dashboard surfaces.
- [x] Ticket context renders friendly labelled rows instead of raw JSON.
- [x] Floating context card is trimmed to non-duplicated facts (customer ask,
      return reason, photo evidence, risk flags, notes) plus a quoted-vs-bound
      order mis-quote heads-up; card and toggle hide when there is nothing to
      show.
- [x] Duplicate-photo risk flags merge in the context card: the runtime's
      per-hit `duplicate_photo_seen_in_ticket_<id>` flags collapse into one chip
      (`buildRiskFlagBadges`) — one match links the ticket inline (`#<short>`),
      several show a counted chip ("… in N tickets") with a hover tooltip listing
      each linked ticket. Copy says "ticket" not "case". Context-card chips
      truncate and reveal the full label in a portaled hover tooltip
      (`components/ui/tooltip.tsx`, fixed-position to escape the card's
      `overflow-y-auto` clip) only when clipped. `buildRiskFlagBadges` counts
      DISTINCT tickets (a repeated id / repeated non-photo flag collapses), and
      the same merge now also drives the approval signal strip + card via the
      shared self-contained `riskFlagChipText`.
- [x] Dark-mode palette and theme switch landed for the SPA.
- [x] Ticket-detail inbox compacts on small laptop screens (sub-`2xl`): narrower
      details column (`lg:w-72 xl:w-80 2xl:w-96`), tighter card/panel padding,
      and the floating context card starts closed below 1536px viewport width
      (header toggle unchanged). `2xl+` keeps the previous layout.
- [x] Sub-`2xl` viewports use a 15px root font size (app.css), scaling all
      rem-based type/spacing ~6% down on laptops; `2xl+` keeps 16px. All
      arbitrary `text-[Npx]` utilities were converted to rem equivalents so
      micro text scales with it — new code must use rem (e.g.
      `text-[0.8125rem]`), never `text-[13px]`.
- [x] SPA port uses Vite, TanStack Router, TanStack Query, cookie BFF auth,
      workspace context, and route-level read/write pages.
- [x] SPA ticket page supports mutations, approval decisions, refund modal,
      supplier update form, live refetch boundary, and settings forms.
- [x] Approval UI hides the unused approval `reasoning` field and raw proposed
      input JSON; approval cards/pages show the ticket context note instead.
- [x] SPA onboarding self-heals org-less sessions and avoids redirect loops
      when the current user has no accessible workspace.
- [x] BFF auth supports login, callback, session refresh, logout, onboarding,
      CSRF guard, and credentialed CORS.
- [x] BFF logout ends the WorkOS AuthKit session too: the route decodes the
      access token's `sid` and returns the WorkOS end-session URL; the SPA
      navigates there so sign-in after sign-out shows the account picker
      instead of silently re-entering the previous account. Requires the SPA
      origin's `/goodbye` to be allowlisted in WorkOS → Redirects → Logout.
- [x] Public onboarding page redirects signed-in users with existing workspaces.
- [x] SPA `/sign-up` route exists as a pure bounce into the WorkOS-hosted
      sign-up (`screen_hint=sign-up`, `returnTo` honored) — no self-hosted
      legal-checkbox form: consent is enforced server-side at onboarding.
      `/sign-in` now carries `?returnTo` through the handshake instead of
      dropping it. NOTE: `lib/auth-redirect.ts` (audit B2 resolver) and
      `lib/legal-consent.ts` remain unwired in the SPA — the session gate
      still auto-starts `login()` on 401; decide whether B2's
      "logged-out → /sign-up" rule should replace that.
- [x] SPA `/workspaces/new` ported (WorkspaceSwitcher's target was a dead
      link): `createWorkspaceOutcome` routes `legal_acceptance_required` to
      the legal page; success switches into the new workspace and lands on
      `/?workspace_created=1`.
- [x] SPA Legal "View notice" fixed: `lib/legal.ts` now derives the notice
      URL from `VITE_API_BASE_URL` (was reading the Next-only
      `DASHBOARD_API_BASE_URL`, so the button linked to itself).

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
- [x] Ticket retention is two-stage: resolved tickets archive after 30 days, and
      archived tickets delete after 12 months with audit/approval cleanup.
- [x] Ticket retention sweep re-checks status/cutoff predicates under row locks
      before archive/delete, so reopened tickets are not archived or purged by a
      stale sweep selection.
- [x] Test teardown purges leaked tenants in dependency order.
- [x] API feature modules replaced the old large composition file.
- [x] Agent runtime was decomposed into named phases while keeping stateful
      runtime behavior in one module.
- [x] Manager can fix the order's shipping address from the ticket page (SPA):
      Ship-to pencil on the Order card → `POST
      /dashboard/tickets/:id/shipping-address` →
      `ShopifyService.updateOrderShippingAddress` (Shopify `orderUpdate`, a
      REAL store write under operator authority). Fields are three-state
      (absent = keep, blank = clear, text = set — the pencil posts the whole
      prefilled form, so blanking a field removes it); records a
      `ticket.shipping_address_updated` audit row; gated on the dedicated
      `orders.edit` RBAC permission (implies `tickets.view`, granted separately
      from `tickets.set_status`, like `refunds.issue` is for money).
- [x] SPA CustomerPanel shows the edit-customer pencil in the
      matched-customer state again (it was dropped there, so the pencil
      vanished exactly when a Shopify customer resolved — the Next dashboard
      passes it in all three states).
- [x] Blocked senders (2026-07-05): per-tenant blocklist of email addresses
      and whole domains (domain entries cover subdomains) so marketing/spam
      mail never opens tickets or burns LLM tokens. Runtime gate at the top of
      the tick (after the processed-message dedup read) drops a matching
      `message.received` — From AND Reply-To are checked — BEFORE the advisory
      lock, ticket create, and agent tick; blocked messages are still claimed
      so redeliveries stay cheap; replies onto already-open tickets are dropped
      too; fail-open on settings-read errors (a DB hiccup never drops customer
      mail). Storage: `blockedSenders` `{emails, domains}` sibling key in
      `tenants.settings` JSONB (no migration) + full-replace
      `setBlockedSenders` on `TenantRepository`; pure matcher module
      `packages/services/src/blocked-senders.ts`. API: GET/add/remove
      `/dashboard/blocked-senders` (server-side normalize + email-vs-domain
      classification, dedupe, 500-per-list cap) and
      `/dashboard/tickets/:id/block-sender` (address derived server-side from
      ticket context; 409 when absent) — all gated on the new
      `settings.blocked_senders` RBAC permission. SPA:
      `/settings/blocked-senders` page (add input with live classification
      hint, domains/addresses lists) + "Block sender" in the ticket ⋮ menu.
- [x] SPA ticket page: drafted-reply approval now fills the composer live
      (2026-07-05). When a live refresh flipped the composer from locked →
      approval, the Approve/Reject controls appeared but the textarea stayed
      empty until a page refresh — `ChatComposer` seeds its text state only on
      mount and was keyed by ticket id alone. Fix: key it with
      `composerKey(id, mode)` (`apps/dashboard-spa/lib/composer-key.ts`) so it
      remounts on locked→approval, on a different pending approval, and on a
      redraft of the same approval (new body), while staying stable across
      refetches of the same draft so manager edits survive. Tests:
      `apps/dashboard-spa/test/composer-key.test.ts`.
- [x] SPA ticket page: live-activity animations (2026-07-06). The reply
      composer is wrapped in `border-beam`'s `<BorderBeam>` (new dashboard-spa
      dependency) — `size="md"`, `colorVariant="ocean"` (matches the blue
      brand), with Beam theme mapped from the dashboard preference
      (`light`/`dark` passthrough, app `system` → Beam `auto`) — and the beam
      is `active` while the ticket is processing or a Rephrase-with-AI call is
      in flight (machine-work strength 0.8), or while the manager is typing in
      the input (theme-tuned strength: dark 0.45, light 0.7, with a 1.5s linger
      after the last keystroke so it doesn't flicker per key). The
      active/theme/strength decision is the pure `composerBeam` helper
      (`apps/dashboard-spa/lib/composer-beam.ts`, test:
      `test/composer-beam.test.ts`); only real keystrokes count as typing —
      programmatic setText (rephrase success) doesn't. "Processing" =
      `triaging | in_progress | approved_action_running`
      (`apps/dashboard-spa/lib/ticket-processing.ts`, fail-safe false for
      `new`/waits/terminal/unknown; test:
      `apps/dashboard-spa/test/ticket-processing.test.ts`). While processing,
      the locked composer hint carries the beam (that's what's on screen when
      the agent works) and the header status chip gets a `.chip-shimmer`
      highlight sweep (`app.css`, reduced-motion safe). Reworked so the
      shimmer is clipped to the label text only (background-clip: text over a
      currentColor gradient), not swept across the whole chip background.
      The tickets-list status chips shimmer the same way (primary chip only —
      extra wait chips are parked states, never processing). Follow-up
      candidate, not done: shimmer on the sidebar status chips.
- [x] Scenarios page: replaced the two native checkboxes (page-level "route to
      resolution agent" + per-scenario "Active") with a liquid-glass switch
      (`apps/dashboard-spa/components/ui/glass-switch.tsx`, Aave-glass style).
      The thumb is a lens: a canvas-generated displacement map feeds an SVG
      `feDisplacementMap` (3 chroma-split passes) that refracts a
      counter-translated copy of the track; CSS layers add specular/rim.
      Wraps a real `<input type="checkbox" role="switch">`, so uncontrolled
      FormData usage (`enabled` → "on") and the controlled toggle both work
      unchanged; visuals are pure CSS `:has(:checked)`. Degrades to a clean
      translucent thumb if canvas/filter is unavailable. Geometry literals in
      Tailwind classes (`--x:20px`/`--px:-20px`) must stay in sync with
      `TRAVEL` — noted in the component header.
- [x] Glass switch press-grow + finger drag: pressing swells the lens past the
      track bounds (`data-pressed` / `group-active` → `--sx:1.3`/`--sy:1.45`,
      scale on its own element so it animates while the slide transition is
      cut) and the thumb is draggable — pointer capture, inline `--x`/`--px`
      overrides, `data-dragging` disables transform transitions, release
      commits past the track midpoint. Tap-vs-drag decision is pure
      (`apps/dashboard-spa/lib/glass-switch-drag.ts`, test
      `test/glass-switch-drag.test.ts`; drag latches at 3px so a returned drag
      never re-reads as a tap). Toggling goes through `input.click()` and the
      root cancels non-input clicks so the wrapping `<label>` can't
      double-toggle. Not machine-verified in a real browser (auth-gated page)
      — QA by hand: tap, keyboard space, drag past/short of midpoint, drag on
      the disabled pending switch.
- [x] Glass switch dark-mode fix: the lens is now always `bg-white` (the old
      `bg-card` / checked `bg-primary-foreground` both resolve dark in
      `.dark`, turning the thumb near-black). In light mode this is a no-op
      (both tokens were `#ffffff`). Scenarios page: inactive scenario cards
      dim to `opacity-55` (Active toggle is now controlled local state, still
      submits via FormData `name`), so disabled scenarios read as disabled.
      Color transitions (track + refracted track copy) run 200ms ease-out
      (`COLOR_MOTION` / per-property `duration-[200ms,450ms]`) instead of the
      450ms slide spring, which read sluggish on color.

---

## Implementation Backlog

### Runtime And Reliability

- [x] Add replay/resume behavior for held `supplier.updated` events after
      approval decisions. (Redraft: a supplier update on a
      waiting-for-approval ticket supersedes the pending approvals and resumes;
      the event is no longer held.)
- [ ] Add merchant-facing recovery when supplier notification attempts exhaust
      and the ticket is still waiting for supplier.
- [ ] `escalateSupplierNotifyFailure` keeps `onlyFromStatus:
      "waiting_for_supplier"`, so a waiting-for-approval ticket with an open
      escalation that exhausts supplier-notify attempts no-ops instead of
      escalating to a human. Acceptable for now (the merchant is already engaged
      via the approval), but revisit if suppliers go unreachable under
      concurrent waits.
- [ ] `supplier_unreachable` risk flag is not stamped on waiting-for-approval
      tickets (same `onlyFromStatus` gate as above).
- [ ] Multi-escalation supplier note history is audit-trail only:
      `context.supplierUpdate` is last-write-wins, so a second escalation's note
      overwrites the first in context (the audit log preserves both).
- [ ] Allow a supplier correction or second update to the same escalation, or
      make the required new escalation flow explicit in the UI.
- [ ] Add epoch handling to timer and supplier events, building on
      `tickets.epoch`.
- [ ] Evaluate IMAP/SMTP pre-send dedup scan; Graph cannot rely on custom
      Message-ID.
- [ ] Dedup approval-maintenance republish by ticket key when a job is already
      pending or active.
- [ ] Stop the scenario-resolution `get_order -> OrderNotFound` retry loop and
      review its max-turn budget.
- [ ] Consider prioritizing approval events over message-received events.
- [ ] Enrich `timer.expired` ticks with thread/context like `ticket.resumed`.
- [ ] Make failed reply-delivery capture atomic with ticket park and audit writes,
      or document the intentional best-effort boundary.
- [ ] Add immediate sweep after manual reply-delivery retry instead of waiting
      for the scheduled pass.
- [ ] Add cumulative discount aggregation by ticket.
- [ ] Prototype bounded `agent.delegate` / structured-report subagents on one
      narrow read-only flow.

### Connectors And Email Safety

- [ ] Add pre-triage automated/bulk/no-reply/bounce detection using sender
      patterns and preserved headers.
- [ ] Add hard send-recipient guard so customer replies cannot be sent to
      no-reply, bounce, or automated addresses.
- [ ] Preserve automated-mail headers across Gmail, Outlook, and IMAP inbound
      payloads where connectors expose them.
- [ ] Stamp connector health as broken when ticket-thread load or manual reply
      sees auth failure.
- [ ] Explain old revoked-IMAP tickets clearly when the active mailbox is now
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

- [x] Manual escalate-to-supplier auto-fills the order projection (`orderRef`,
      ship city/country, newest tracking number) server-side from the ticket's
      canonically-bound order (`identifiedOrderId` GID only — never the
      customer's quoted ref; wrong-order data must not reach a supplier).
      Best-effort: an unreachable Shopify degrades to nulls, never blocks the
      escalation. `escalation-projection.ts` + handler wiring in apps/api.
- [ ] Add merchant-facing supplier list and pending invitation management if the
      invite-only settings surface is insufficient.
- [ ] Add per-vendor supplier routing instead of one default supplier.
- [ ] Revisit `supplierMode` semantics in autonomous loop so wait vs
      notify-and-proceed is enforced after gated supplier actions.
- [ ] Keep supplier access binding-based; never fall back to org membership for
      supplier portal authorization.
- [ ] Supplier tracking edit needs the `write_fulfillments` Shopify scope —
      add it to the Partner Dashboard "Required access scopes" (pilot custom
      apps + SaaS app). Stores that haven't re-authorized surface the failure
      as a sanitized 502 toast; consider a capability-grid row like
      `read_inventory`'s.

### Dashboard And SPA

- [x] Context card no longer flashes the "Customer-quoted order" heads-up on
      mount: `buildContextCardRows` order arg is tri-state (`"loading"` while
      the Shopify fetch is pending renders the slot as a skeleton row; `null` =
      settled-without-order keeps the unprovable-match heads-up). Ticket page
      passes `shopifyQuery.isPending ? "loading" : …`. Size changes animate:
      card body wrapped in `AnimateHeight` (ResizeObserver → px height →
      transition, `components/ui/animate-height.tsx`), and the aside stays
      mounted so an emptying card slides out via the existing translate
      transition instead of unmounting with a pop.
- [x] Context card shows the supplier's answer: `context.supplierUpdate`
      (stamped by `recordSupplierUpdate`) renders as bespoke "Supplier note" /
      "Supplier suggests" multiline rows in `lib/ticket-context.ts` instead of
      being invisible (it was filtered out of `CARD_KEYS` and would have
      JSON-dumped via the fallback). Internal `supplierId` deliberately hidden.
- [ ] Surface canceled approval count after restart-from-triage.
- [x] `ApprovalSignalsStrip` / `ApprovalCard` now merge risk flags via
      `buildRiskFlagBadges` + the shared self-contained `riskFlagChipText`
      (duplicate-photo hits collapse to one counted chip), matching the context
      card. The compact surfaces show the count only (no inline links).
- [ ] `apps/dashboard` (Next) has no Ship-to pencil — the shipping-address
      edit landed SPA-only (the api endpoint is shared, so porting is just the
      popover + action).
- [ ] `apps/dashboard` (Next) still has the old ticket-header layout (icon-only
      refund, retries in the ⋮ menu, no manual supplier escalation) — port the
      SPA's rework only if that app stays user-facing.
- [ ] Fix legacy relay tickets where corrected `customerEmail` updates display but
      connector replies still target original thread recipients.
- [ ] Mirror dark-mode or email-rendering improvements between dashboard apps
      only for the app that remains user-facing.
- [ ] Add optional polish: AI-suggest reply chips, bubble avatars, status/priority
      pill audit, and order/ticket timeline rail.
- [x] Micro-interaction polish pass on the ticket-page actions + dialogs (169df73):
      scale-on-press + property-scoped transitions baked into the shared
      `Button`, cross-faded pending spinners in `TicketHeaderActions`, 40px hit
      areas on icon triggers/checkboxes, dropdown enter animation, tabular-nums
      on live refund amounts, `text-balance`/`text-pretty` on dialog copy.
      Extend the same treatment to other screens opportunistically.
- [ ] Add workspace rename UI.
- [ ] Add a distinct workspace-deleted platform email template if merchants need
      receipts for single-workspace deletion.
- [ ] Add stable handling for simultaneous last-workspace deletes.
- [ ] Reintroduce shareable URL filters in SPA tables if needed; current SPA
      filtering is local state.
- [x] Integrations page paints a card-grid skeleton (`IntegrationsLoading`,
      mirrors the provider-card layout) instead of the plain "Loading…" line
      while connections/settings/shopify-gate queries resolve.
- [ ] Other settings pages (Agents, AgentDetail, Members, Notifications,
      Knowledge doc, Permissions, Refund policy, Integration detail, Legal)
      still render plain "Loading…" text — port the skeleton treatment
      opportunistically.

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
- [ ] Add cost dashboards by model, provider, agent, ticket, and tenant.
- [ ] Add platform vs tenant-billed LLM cost reporting for 17track and future
      shared services.
- [ ] Remove hardcoded specialist prompt paths only after the scenario agent
      proves equivalent behavior on the target flows.
- [ ] Add tone/brand tests for customer-facing replies.
- [ ] Add replay/test mode for agents against historical tickets.

### Security, Compliance, And Operations Hardening

- [ ] Rename Next middleware/proxy code once the Next version decision settles.
- [ ] Fix API rate-limit keying behind proxies and for server-side dashboard
      egress.
- [ ] Ensure CI sets `DATABASE_URL` for real Drizzle integration tests.
- [ ] Finish OTel trace redaction follow-up from Shopify PCD review.
- [ ] Add load testing for 10k tickets/day per tenant.
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
- [x] Ticket retention archives resolved tickets after 30 days and deletes archived
      tickets after 12 months; `archived` is runtime-owned and can reopen on a
      customer reply before deletion.
- [x] "Archive now" is merchant-settable from the ticket-page status menu, but
      ONLY on `resolved` tickets: `archived` is entry-restricted in the §10
      matrix (`to === "archived"` requires `from === "resolved"`), so neither
      the menu nor any code path can archive a live ticket early.
- [x] Member RBAC uses plain dashboard DB functions, not an Effect service tag,
      because agents do not consult human RBAC.
- [x] Scenario-resolution agent was added beside legacy specialists behind a
      flag instead of replacing specialist prompts in one step.
- [x] `supplier.notify` was not built; `supplier.escalate` is the supplier
      contact primitive.
- [x] SPA keeps the existing flat dashboard package layout instead of moving
      code under `src/`.
- [x] Concurrent wait states do NOT make `tickets.status` a set. Status stays the
      single "who acts next" pointer; both wait facts are derived from rows
      (pending approvals / open escalations). Precedence is encoded once in
      `primaryWaitStatus` (agent-core) — approval wins, because the merchant is
      the next unblocker and the supplier wait is passive (carried by the open
      escalation row + notify outbox). This preserves the CHECK constraint, the
      `(tenant,status)` index, `groupBy` rollups, list filters, and the cron
      mutex-guards.
- [x] A supplier update on a ticket parked `waiting_for_approval` REDRAFTS: it
      supersedes every pending approval (they may be stale in light of the
      supplier's note) and resumes the ticket so the agent drafts fresh, rather
      than holding the event. No epoch bump — stale approve links are inert
      (`already_decided` → 409), and the bundle filter/reminder sweep read
      pending only.

---

## Always-True Invariants

- `agent-core` imports nothing from `services`, `tools`, `db`, or `providers`.
- `PermissionService` is consulted before every tool execution.
- Audit-log writes share the transaction with ticket state changes.
- Ticket state machine guards every status transition.
- Effect service tags stay abstract in `packages/services`; live impls live in
  `packages/db`, `packages/providers`, or feature packages.
- Customer-facing replies and money actions stay approval-gated unless tenant
  policy explicitly allows the exact action.
- A ticket in `human_takeover` never runs the agent until an explicit resume.
- Failed customer-reply delivery must never resolve the ticket.
- Delivery-scoped side-effect markers must not dedup distinct inbound messages.
- Supplier portal access is by supplier binding, never by WorkOS org membership.
- Concurrent wait states: `tickets.status` is the single `primaryWaitStatus`
  pointer (approval wins); both wait facts are row-derived (pending approvals /
  open escalations), never a status set. The supplier notify outbox keys on the
  open escalation row, not on `tickets.status`.
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
