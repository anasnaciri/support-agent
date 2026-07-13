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

- [x] **Google Sheets, Outlook, and IMAP / SMTP integrations are marked Beta**
      (2026-07-13). Their cards on the Integrations overview and headings on
      the corresponding Manage pages now carry the same compact informational
      badge, driven by one shared provider rule. Shopify and Gmail remain
      unbadged. Per user request, no test was added; verified with the dashboard
      SPA production build (including strict TypeScript), `pnpm build`, and a
      targeted source grep.

- [x] **Restored and refreshed the existing per-scenario action envelope at
      runtime** (2026-07-13). The
      Scenarios UI and `ResolutionPolicy.enabledActions` again describe the
      action checklist + allow/ask choice as authoritative, but the wired
      runtime still calls steering-only `applyScenarioSteering` (the temporary
      2026-06-28 behavior), leaving every resolution-agent remedy available
      under its agent-level permission after both initial selection and a
      same-run reroute. Fixed TDD by deriving a fresh effective agent from the
      clean agent binding plus the ticket's current scenario at every model
      boundary using the already-defined `applyScenarioEnvelope`; it now
      refreshes the playbook, filters schemas, and installs defense-in-depth
      denies for disabled actions. It re-resolves the same
      envelope immediately before every scenario-gated tool execution and on
      approval resume, using fresh ticket context + tenant settings, so a
      stale model turn or approval cannot bypass a reroute/settings change.
      Coverage proves scenario A -> scenario B changes for ask -> allow,
      allow -> ask, allow -> disabled,
      schema replacement, execution denial, and approval resume. Keep the
      supplier-mode execution backstop as a specialized second wall. This task
      uses only the permission semantics already stored in `enabledActions`;
      the generic precedence model remains separate below. The old
      steering-only helper/tests and contradictory comments were removed.
      Verified with 102 focused runtime/helper tests, 1,555 package + worker
      tests, 15 socket-binding provider tests rerun outside the sandbox, and
      `pnpm build`.

- [ ] **SECOND: generalize scenario-over-agent permission precedence.** After
      the refresh defect above is fixed, define a generic scenario permission
      overlay for any tool the resolved agent already owns (a scenario cannot
      add capabilities absent from the agent tool list). The selected scenario
      is the more specific merchant policy and may override the agent/default in
      either direction, including `ask` -> `allow`; independent runtime safety
      backstops, connector scopes, and tenant conditional/hard-cap policy apply
      afterward and may only make the result stricter. Keep optional remedy
      availability (`enabledActions`) separate, and normalize both inputs behind
      one effective-scenario-policy helper. This precedence/model/UI work is not
      required to repair the existing same-run permission refresh bug.

- [x] **Dashboard scenario label read stale `tickets.category` after a
      same-run reroute** (confirmed 2026-07-13 on prod ticket
      `115f43d5-429d-44bb-b338-3be53a0107be`). The live row has
      `category = where_is_order`, `context.classification = where_is_order`,
      and `context.scenarioKey = delivery_issue`. The scenario agent therefore
      DID reroute, but both dashboard ticket surfaces render `category` and do
      not expose `scenarioKey`. `ticket.update_context` mirrors
      `classification` into `category`, while a scenario-only reroute updates
      neither, creating two competing labels. Fixed as a full source-of-truth
      migration: `context.scenarioKey` is now the only persisted scenario
      identity; migration 0047 backfills it from the legacy column only when a
      canonical key is absent. The Ticket domain
      and repository no longer accept or return category, and
      `ticket.update_context` no longer mirrors classification into a second
      field. Dashboard contracts now expose `scenarioKey`; Today, inbox,
      detail, search, both dashboard clients, and mock seeds all consume it.
      TDD regression reproduces the prod split and proves list/detail render
      `delivery_issue`; search coverage proves the canonical key is queried.
      Focused DB integration (5 passed), repository/tool tests (29 passed), and
      `pnpm build` are green. A broad run passed 3,132 tests; its remaining
      failures were pre-existing local-DB fixture collisions from an earlier
      interrupted run, not this migration.
      - [ ] **Contract migration:** after this release has replaced every old
        API/worker machine, drop the deprecated `tickets.category` column in a
        later migration and remove its compatibility declaration from
        `schema.ts`. It is intentionally retained for one expand/contract
        deploy because Fly runs release migrations before rolling old binaries,
        which still select that column. Current code neither reads nor writes
        it, so `context.scenarioKey` is already the sole logical source.

- [x] **PROD BUG (FIXED 2026-07-13): same-run scenario reroute did not
      refresh the active scenario playbook** (ticket
      `115f43d5-429d-44bb-b338-3be53a0107be`, tenant `4f685543`). The scenario
      agent initially selected `where_is_order`, then `tracking.lookup`
      returned structured `status: "exception"` with a delivery-exception scan
      and it correctly changed `context.scenarioKey` to `delivery_issue`.
      Despite that scenario's explicit note ("On an exception, escalate to the
      supplier to reship") and `supplierMode: escalate_and_wait`, it skipped
      `supplier.escalate` and queued only a customer reply telling the customer
      to contact the post office. Production audit confirms there was no
      escalation attempt, denial, tool error, or escalation row. The supplier
      tool was available (`ask` by default), the selected scenario permits it,
      and the 20-turn loop stopped voluntarily at turn 5, ruling out policy and
      turn-budget causes. Root design gap: `withScenario(...)` is applied only
      at initial agent binding and handoff; a successful
      `ticket.update_context` inside the tool loop refreshes ticket state but
      does not reapply `applyScenarioSteering`, so the dedicated trusted
      `[Scenario playbook]` for the newly selected scenario is never added in
      that run. The entry menu did contain the delivery scenario's notes, so
      the immediate event was also a model instruction-following miss. Fixed
      TDD: the runtime now retains a clean, unsteered agent binding and
      reapplies scenario steering at every model-call boundary. After a
      successful `ticket.update_context`, it folds the validated `scenarioKey`
      patch into the in-memory ticket, so the next turn replaces the old
      dedicated playbook with the new one without stacking headers or losing
      any customer message / assistant tool-call / tool-result history.
      Supplier escalation remains judgment-based; no mandatory-action guard
      was added. Regression coverage captures all three prompts across initial
      selection and reroute, asserts old-playbook removal, and verifies the
      message history continues growing. Verified with focused red -> green,
      89 worker runtime/scenario tests, and `pnpm build`.

- [x] **`supplierMode: none` now overrides contradictory scenario notes**
      (2026-07-13). The trusted playbook header explicitly states that the
      structured setting wins over free-text notes. More importantly, the
      runtime denies `supplier.escalate` at execution time by resolving the
      ticket's selected `scenarioKey` against the current tenant policy. The
      guard refreshes ticket context and settings at the call boundary, so an
      agent cannot select a supplier-disabled scenario and escalate later in
      the same tool loop. Approval resume re-checks the same constraint, so an
      older queued escalation cannot execute after the scenario disables
      suppliers. Covered in `scenario-resolution-loop.test.ts` (same-run and
      approval-resume regressions) and `agent-runtime.test.ts` (prompt
      precedence). Same-run scenario resteering now replaces the full Scenario
      Action Policy (playbook, tool list, and permissions). The dedicated
      supplier denial remains a separate execution-time second wall resolved
      from the ticket's current `scenarioKey`.

- [x] **PROD BUG (FIXED 2026-07-12): tracking-destination gate false-positives
      on ISO code vs country name and suppressed a supplier escalation** (found
      2026-07-12, prod ticket `03649e6f-640d-44dc-b805-e770da635069`, tenant
      `4f685543`). Both fixes landed TDD (red → green), verified with
      `npx vitest run packages apps/worker apps/api` (2065 passed) +
      `pnpm build`:
      - `normalizeCountryForMatch` now expands ISO 3166 alpha-2 codes to CLDR
        English region names via `Intl.DisplayNames(["en"], {type: "region",
        fallback: "code"})` and folds informal aliases (USA / U.S. / U.S.A. /
        united states of america / UK / Great Britain) before comparing; an
        unrecognized two-letter token stays verbatim. Regression tests in
        `packages/services/test/order-identity.test.ts` (`("US", "United
        States")` → null, real mismatches still flag, "ZZ" verbatim).
      - `stringToStatus` (seventeentrack-http.ts) maps `DeliveryFailure` →
        `exception` and `AvailableForPickup` → `in_transit` (mirrors numeric
        code 30 — waiting on the customer is not a carrier problem). Tests in
        `packages/providers/test/seventeentrack-http.test.ts`.
      - NOT fixed (noted, needs a decision): `numericToStatus` maps 35
        (undelivered) → `in_transit` while the string mapper sends
        "undelivered" → `exception` — inconsistent, but untouched to keep this
        fix narrow. Also unchanged: the prompt-vs-runtime gap where the agent
        ignored the directive's merchant.notify half; only the forced reply
        approval engaged. Needs a Fly deploy to reach prod.
      - [x] **Follow-up (FIXED 2026-07-12): Tracking card showed a superseded
        tracking number after `order.update_tracking`** (observed on the same
        prod ticket, 2026-07-12 21:53). The card followed
        `context.liveTrackingStatus` — the snapshot of the agent's LAST
        `tracking.lookup` — so a supplier reship synced onto the Shopify
        fulfillment never reached it. Fixed in three layers, TDD, full suite
        green (`npx vitest run packages apps/worker apps/api
        apps/dashboard-spa`, 2675 passed) + SPA `tsc --noEmit`:
        - **API endpoint priority inverted** — `handleDashboardTicketTracking`
          previously looked up the STAMP's number and only fell back to the
          order; now `pickTrackingSource`
          (`apps/api/.../dashboard/ticket-tracking-source.ts`, unit-tested)
          resolves the order first and follows its live fulfillment number
          (stamp = fallback only). Because the fulfillment is re-read live on
          every card load, this also picks up numbers edited directly in the
          Shopify admin — there is NO webhook for fulfillment edits (only
          APP_UNINSTALLED + compliance), the app's model is pull-on-read.
          Same-number case keeps the stamp's 17track carrier code as the
          lookup hint.
        - **Runtime invalidation** — `stampTrackingLookup` (agent-runtime.ts)
          now also handles `order.update_tracking`: a successful update whose
          stored number differs from the snapshot's clears
          `liveTrackingStatus` (facts header stops describing the superseded
          shipment); a same-number re-store keeps it. Tests in
          `tracking-lookup-runtime.test.ts`. (The supplier-portal pencil edit
          already cleared it inside `recordSupplierTrackingUpdate` — verified,
          untouched.)
        - **SPA fallback cross-check** — `dropSupersededStamp`
          (`lib/tracking-panel-data.ts`, unit-tested) suppresses the on-ticket
          stamp fallback when the live order tracks under a different number,
          so even the endpoint-unavailable path can't render the old number.
        - **Runtime heal on order reads (added 2026-07-13, user request):**
          the agent now heals the stamp too. The get_order /
          find_customer_order context fold (the same place
          `identifiedOrderId` + `orderShipCountry` stamp) calls
          `trackingSnapshotSupersededByOrder` (pure, unit-tested in
          order-identity.test.ts): when the snapshot names a number absent
          from the resolved order's `fulfillments[].tracking.numbers` (and
          the order HAS tracking numbers — conservative fail-open), the
          runtime drops `liveTrackingStatus` in the same context update, so
          the facts header stops describing the old shipment even in a run
          that never calls `tracking.lookup`. Covers the merchant editing
          tracking in the Shopify admin before an agent run. Runtime test in
          tracking-lookup-runtime.test.ts.
        - **Endpoint self-heal (added same day, user request):** the tracking
          endpoint now converges the SAVED stamp to Shopify's number instead
          of just out-ranking it. After a successful live lookup,
          `restampTicketLiveTracking` (packages/db `dashboard-writes.ts`,
          integration-tested) replaces `context.liveTrackingStatus` with the
          fresh serialized lookup — guarded in SQL: only a ticket that HAS a
          stamp naming a DIFFERENT number is touched (never invents a stamp,
          never clobbers a concurrent same-number runtime stamp, tenant-
          scoped, `updated_at` untouched so the inbox doesn't re-sort on page
          views). Best-effort: a write failure never fails the GET. Covers
          Shopify-admin edits: the next time anyone opens the ticket, the DB
          stamp is healed. Nothing is surfaced to the merchant (deliberate).
        - [x] **Review follow-up (FIXED 2026-07-13): multi-fulfillment tracking source can heal to
          the wrong shipment.** `order.update_tracking` and the supplier portal
          correctly pick the fulfillment carrying the old tracking number, but
          the dashboard tracking endpoint later follows the FIRST fulfillment
          carrying any tracking number. On an order with multiple fulfillments,
          a ticket/escalation about fulfillment B can update B in Shopify while
          the card/self-heal reads fulfillment A and may restamp the ticket to
          A. Need a stable fulfillment identity or ticket-scoped tracking source
          before restamping. **Validated 2026-07-13: real, high-impact correctness
          issue behind a narrower multi-fulfillment trigger.** The Shopify order
          model already exposes fulfillment ids and `order.update_tracking`
          returns the selected id, but neither ticket context nor the escalation
          projection persists it; `pickTrackingSource` is explicitly tested to
          choose the first tracked fulfillment. A wrong choice affects the live
          card and can then persist the wrong shipment into the ticket stamp.
          Fixed TDD by persisting the exact Shopify fulfillment id as
          `context.trackingFulfillmentId` after both `order.update_tracking`
          and supplier-portal edits. The dashboard source picker now prefers
          that bound fulfillment; legacy tickets first associate by the
          stamped number, then fall back to the first tracked fulfillment. A
          missing bound fulfillment returns no tracking instead of guessing
          another shipment. No migration is needed because ticket context is
          schemaless and the legacy association path remains supported.
        - [ ] **Review follow-up: app-owned tracking writes clear the DB stamp
          but do not recreate it.** `order.update_tracking` drops
          `liveTrackingStatus`; the supplier portal pencil does the same. The
          endpoint restamp intentionally refuses to invent a stamp when one is
          absent, so after these successful writes the DB stamp stays absent
          unless a later agent run calls `tracking.lookup`. Decide whether the
          invariant is "no stale stamp" or "stamp synced to Shopify", and change
          the write/restamp path accordingly. **Validated 2026-07-13: not a
          correctness bug under the current cache/snapshot semantics.** The live
          dashboard endpoint still reads Shopify and shows fresh carrier data;
          absence merely leaves the agent facts header without cached tracking
          until its next lookup. Creating a stamp on a dashboard read would add
          page-view side effects and is unsafe until fulfillment identity is
          solved. Defer unless the product explicitly requires an always-present
          stamp (low gain today).
        - [x] **Review follow-up (FIXED 2026-07-13): tracking removal was not
          treated as supersession.** Removal was a real medium/high correctness
          issue: all
          three guards deliberately keep/fall back to the old stamp when the
          resolved order has zero tracking numbers, so a merchant removing an
          invalid number can still see that shipment presented as current.
          The API picker, SPA fallback, and runtime order-read healer now treat
          a successfully resolved, numberless order as authoritative "no
          tracking", while retaining the stamp only when order resolution
          fails. Covered by focused API, SPA, helper, and runtime tests.
        - [ ] **Deferred: same-number carrier metadata changes keep the prior
          stamp/carrier hint.** This remains low priority: the endpoint
          deliberately prefers the stamp's provider carrier code because it
          previously produced a successful lookup; only Shopify-admin metadata
          edits bypass the app-owned paths that already clear the stamp. Revisit
          only with a reproduced carrier-routing failure or an explicit metadata
          synchronization requirement.
      - [x] **Stale `tracking_destination_mismatch` flags clear after a proven
        match** (fixed 2026-07-13). A successful `tracking.lookup` whose current
        destination and the order's shipping country are both known and match
        now removes only this risk flag, preserving unrelated flags. Failed
        or no-provider lookups replace it with `tracking_lookup_failed`, while
        live results lacking comparable destination data replace it with
        `tracking_destination_unavailable`; these are distinct cases and do not
        inject the mismatch directive. Every lookup replaces only the previous
        tracking-outcome flag and preserves unrelated flags. This lets a
        supplier-corrected tracking number remove the injected warning without
        mislabeling an unavailable lookup as a mismatch. The directive was also
        shortened without dropping its reason, different-order warning,
        `merchant.notify`, or verification-only `supplier.escalate` guidance.

      Original diagnosis:
      17track returned `destinationCountry: "US"` (ISO 3166 alpha-2) while the
      runtime had stamped `orderShipCountry: "United States"` (Shopify country
      name). `trackingDestinationMismatchFlag` compares normalized *strings*
      ("us" ≠ "united states") → false `tracking_destination_mismatch`. The
      injected directive ("do NOT … escalate off it") then stopped the
      scenario agent from calling `supplier.escalate` on a shipment with a
      genuine carrier delivery exception (transitDays 27 vs the store's
      20-day delayed threshold) — the exact playbook case the merchant
      configured (`supplierMode: escalate_and_wait`, "On an exception,
      escalate to the supplier"). The 2026-07-10 entry below predicted the
      representation-mismatch risk but judged the failure mode as "parks a
      healthy ticket for a human"; in reality the flag also *suppresses
      legitimate escalation*, and the forced-approval backstop only reviews
      the reply text, not the missing escalation (the operator approved the
      reply and the ticket auto-resolved).
      - Fix: normalize both sides to a canonical form before comparing —
        e.g. expand 2-letter ISO codes with `Intl.DisplayNames(["en"],
        {type: "region"})` (plus a small alias map for "USA", "UK", …) in
        `normalizeCountryForMatch`; keep fail-open semantics. Regression test:
        `("US", "United States")` → null.
      - Secondary gap, same ticket: 17track `latest_status.status`
        `"DeliveryFailure"` / `"AvailableForPickup"` fall through
        `stringToStatus` to `"unknown"` (providers/seventeentrack-http.ts),
        so the lookup carried `status: "unknown"` while the last scan text
        literally said "Delivery exception". Map `deliveryfailure` →
        `exception` (and decide a mapping for `availableforpickup`) so the
        playbooks' "exception status" trigger fires from the structured field.
      - Also observed: the agent violated the mismatch directive's other half
        (it summarised the tracking as this order's and never called
        `merchant.notify`) — the reply force-approval was the only backstop
        that actually engaged. Prompt-vs-runtime gap to keep in mind when
        fixing.
      - [x] **Tracking-destination directive now permits verification-only
        supplier escalation** (2026-07-13). The trusted runtime prompt still
        explains the destination-country mismatch and that the tracking may
        belong to a different order, but no longer suppresses every supplier
        contact. It forbids claims or escalation based on the suspect delivery
        state, requires `merchant.notify`, and—when supplier escalation is
        enabled—directs `supplier.escalate` to ask the supplier to verify the
        order's tracking number without repeating claims from scans/status.

- [x] **Supplier-reported tracking numbers sync onto the order** (2026-07-12).
      Verified with `npx vitest run packages apps/worker apps/api
      apps/dashboard-spa` (all green) and `pnpm build`. A supplier typing
      "reshipped #TRACK123" as a portal MESSAGE previously only re-engaged the
      agent to draft a reply — the number could never reach the order because
      no agent tool wrote tracking (only the portal card pencil's HTTP handler
      did). Closed with a new `order.update_tracking` tool
      (`packages/tools/src/shopify/update-tracking.ts`), a thin wrapper over
      the SAME `ShopifyService.updateFulfillmentTracking` the portal uses,
      with the portal's fulfillment-picking rule (the fulfillment carrying
      `currentTrackingNumber` wins; no match → only a single-fulfillment order
      is safe, `AmbiguousFulfillment` otherwise; carrier carried over when the
      supplier named none; `notifyCustomer: false` always). The
      `supplier.updated` branch of `buildInitialMessages` now steers the agent:
      sync a supplier-reported new/corrected tracking number with the tool
      BEFORE drafting the reply, passing the order's old number as
      `currentTrackingNumber`, and only ever a number the supplier explicitly
      stated. Registered in `ALL_TOOLS`, `TOOL_DISPLAY_NAMES` ("Update the
      tracking number"), the scenario agent's tool list, the `/` action
      catalog (`ACTIONABLE_TOOLS`), and `summarizeApprovalAction` (shows the
      number).
      - **`defaultPermission: "allow"`** — user decision (2026-07-12), unlike
        every other order write: the number's authority is the supplier's own
        statement, and the supplier already holds an UNGATED manual edit of the
        same field in their portal. Tenants can flip it to Ask per-agent.
      - **Deliberately NO `requiredConnectorScopes`:** the mutation accepts ANY
        ONE of the two `SHOPIFY_FULFILLMENT_TRACKING_SCOPES`, and the precheck
        is all-of. A store missing both scopes surfaces Shopify's refusal as
        `FulfillmentUpdateFailed` (needs the same re-OAuth as the portal
        tracking edit).
      - **`SCENARIO_REMEDY_TOOLS` deliberately not extended** — the scenario
        envelope is unwired (per-agent config governs); revisit if
        `applyScenarioEnvelope` is ever resurfaced, else the tool rides as
        baseline there.

- [x] **Facts and Agent pages warn before leaving with unsaved changes**
      (2026-07-12). Verified with
      `pnpm test -- apps/dashboard-spa/test/settings-unsaved-changes.test.ts`,
      the full `apps/dashboard-spa` suite, `pnpm build`, and a stubbed-API
      Playwright run over both pages: a clean page navigates freely; an edit in
      either Facts form (they save separately) or in the Agent model picker /
      system prompt blocks navigation; Stay keeps the edit; undoing an edit by
      hand clears the warning. The dirty-flag registry from the Scenarios work is
      now shared (`useDirtyFlags` / `useReportDirty` in `lib/unsaved-changes.ts`).
      Two rules keep the warning honest: `trimmedFormValuesDirty` ignores padding
      the save would strip, and `agentEditsDirty` treats re-picking the agent
      default model as a reset (it clears the override) rather than an edit. The
      Ask/Auto permission toggles save on the spot, so they are not tracked.
      `ModelCombobox` gained an optional `onValueChange` — the selection lives
      inside it, so a page has no other way to see an unsaved model pick.

- [x] **Scenarios page warns before leaving with unsaved changes** (2026-07-11).
      Verified with `pnpm test -- apps/dashboard-spa/test/unsaved-changes.test.ts`,
      the full `apps/dashboard-spa` suite, `pnpm --filter
      @support-agent/dashboard-spa build`, `pnpm build`, and a stubbed-API
      Playwright run at 1400px and 390px: a clean page navigates freely; one
      keystroke in a playbook note blocks in-app navigation (sidebar link and
      mobile drawer alike) with a "Leave without saving?" dialog; Stay keeps the
      edit; Leave discards and navigates. The scenarios form is uncontrolled, so
      dirtiness is a `resolutionPolicySnapshot` of the DOM compared against the
      snapshot taken at load / last save (an edit the save would normalize away,
      or an edit undone by hand, leaves the page clean). Each Facts sidebar card
      reports its own flag; the page ORs them and `useBlocker`'s
      `enableBeforeUnload` covers reload/close-tab.

- [x] **Dialogs animate as a centre fade + scale, not a top-left diagonal**
      (2026-07-11). Verified with
      `pnpm test -- apps/dashboard-spa/test/dialog-motion.test.ts`, `pnpm build`,
      and computed-style reads in a real browser (enter: `enter` 200ms ease-out,
      no X/Y drift, scale .95; exit: `exit` 150ms ease-in, scale .95). The
      shadcn template's `slide-in-from-left-1/2` + `slide-in-from-top-[48%]` pair
      re-applies the centring translate from inside the keyframe — a Tailwind v3
      idiom. Under v4 the centring lives on the `translate` property, so the pair
      only dragged every dialog in diagonally from the top-left. Motion now lives
      in `components/ui/dialog-motion.ts` (shared by any future modal surface):
      centre fade + scale both ways, and below `sm` the dialog rises 1.5rem from
      the bottom on entry and drops back down on exit.

- [x] **Outbound merchant/supplier copy avoids LLM em dashes** (2026-07-11).
      Verified with
      `npx vitest run packages/providers/test/platform-mail-live.test.ts packages/providers/test/telegram-notification-live.test.ts packages/services/test/merchant-notification.test.ts`
      and `pnpm build`. Two layers: seeded scenario notes and authored
      notification copy no longer feed em dashes to the model, and the Telegram
      + Resend send boundaries rewrite `—` to ` - ` so LLM-written bodies
      (merchant notes, draft previews) can't smuggle them out. Dashboard SPA
      scenario/notification copy was cleaned the same way.
      **Deliberately untested:** there are NO tests about em dashes, neither
      asserting their absence in authored copy nor pinning the send-boundary
      rewrite. This is copy style, not behavior worth defending: such a test
      fails the moment a human intentionally writes one, which is allowed. Do
      not add em-dash tests or em-dash fixtures.

- [x] **Em dashes removed from the prompts and the whole dashboard/portal UI**
      (2026-07-11). Verified with `npx vitest run` (2666 pass), `pnpm build`, and
      `pnpm --filter @support-agent/dashboard-spa build`. Three layers:
      1. **Prompts (the root cause).** Cleaned the scenario-resolution agent's
         `promptTemplate`, the runtime context headers in
         `agent-runtime-helpers.ts`, `UNTRUSTED_PREAMBLE`, every tool
         `description`, and the dashboard Rephrase prompt. A model mimics the
         style of what it reads, so em dashes in the prompt were teaching it to
         write them.
      2. **A `WRITING_STYLE` block appended by `buildSystemPrompt`** (the one
         choke point every agent's prompt passes through, custom agents
         included). It forbids em dashes outright, which is the only protection
         customer replies get: nothing rewrites them on the way out.
      3. **UI prose**: all ~110 em-dash strings across the dashboard SPA and the
         supplier portal pages, plus the Shopify post-connect page title and the
         Shopify refund note.
      Bare `"—"` used as an empty-value placeholder (`{value ?? "—"}`) is a
      legitimate typographic dash and was deliberately left in six spots.
      **Deliberately skipped:** the other agents' prompts (`missing-package`,
      `damaged-product`, `general-inquiry`, `order-status`, `refund-review`,
      `support-triage`, `order-resolution`, `custom-agent-scaffold`). Only the
      scenario-resolution agent is in use; revisit if any of them is reinstated.
      Also still dirty: `apps/admin` (operator-only) and the approval
      magic-link pages in `apps/api/src/features/approvals/`.

- [x] **Knowledge docs can be referenced with `@` in scenario notes**
      (2026-07-11). Verified with
      `pnpm test -- packages/services/test/fact-references.test.ts`,
      `pnpm test -- packages/services/test/agent-runtime.test.ts -t "buildSystemPrompt"`,
      `pnpm test -- apps/dashboard-spa/test/playbook-notes-field.test.ts`,
      `pnpm vitest run apps/api/src/features/dashboard/tests/settings.integration.test.ts -t "fact-references"`
      (DB-gated, skipped locally because `DATABASE_URL` was unset),
      `pnpm build`, and
      `pnpm --filter @support-agent/dashboard-spa build`. The existing
      scenario-note `@` menu now includes tenant knowledge docs as stable
      `@docs.<document-id>` references alongside Facts. Stored notes still keep
      the raw token; at prompt-build time the token resolves to a short
      instruction naming the document and telling the agent to call
      `knowledge.search` with that title, without inlining the document body.

- [x] **Scenario note `@` menu distinguishes docs from facts** (2026-07-11).
      Verified with
      `pnpm test -- apps/dashboard-spa/test/playbook-notes-field.test.ts`,
      `pnpm build`, and
      `pnpm --filter @support-agent/dashboard-spa build`. The dropdown now
      keeps the original compact one-line option style while adding a small
      leading `FileText` icon for knowledge docs and `Database` icon for
      structured Facts. Keyboard navigation now scrolls the highlighted option
      into view inside the dropdown.

- [x] **Scenario note `@` menu scrolls one row at a time** (2026-07-11).
      Verified with
      `pnpm test -- apps/dashboard-spa/test/playbook-notes-field.test.ts`,
      `pnpm --filter @support-agent/dashboard-spa build`, and `pnpm build`.
      Keyboard navigation now scrolls the menu element itself with smooth
      behavior, advances by one option height as the highlighted row crosses the
      visible bottom edge, and no longer delegates to `scrollIntoView`, avoiding
      page jumps while keeping the focused option anchored at the dropdown's
      bottom during downward navigation.

- [x] **Scenario doc refs stay visible when many facts match** (2026-07-11).
      Verified with
      `pnpm test -- apps/dashboard-spa/test/playbook-notes-field.test.ts`.
      The `@` dropdown no longer caps matches at 8 before rendering; it relies
      on the existing scroll container, so knowledge docs appended after the
      structured Facts catalog still appear in real workspaces such as Elva Labs.
      The DB-gated API check
      `pnpm vitest run apps/api/src/features/dashboard/tests/settings.integration.test.ts -t "fact-references"`
      was attempted and skipped locally because `DATABASE_URL` was unset.

- [x] **Scenarios page quick Facts sidebar** (2026-07-11). Verified with
      `pnpm test -- apps/dashboard-spa/test/scenarios-facts-sidebar.test.ts`,
      `pnpm --filter @support-agent/dashboard-spa build`, `pnpm build`, and a
      local Vite route smoke check (`GET /settings/scenarios` returned 200).
      `/settings/scenarios` now has a right-side Store facts sidebar collapsed
      by default, with the open/closed state persisted in localStorage. When
      expanded, it shows catalog-driven Shipping/Returns fact cards and compact
      save forms for members with `knowledge.manage`; members without that
      permission see the current facts read-only.

- [x] **Scenario agent can suggest partial refunds** (2026-07-11). Verified
      with `pnpm test -- packages/tools/test/shopify.test.ts`,
      `pnpm test -- packages/providers/test/shopify-service-live.test.ts`,
      `pnpm test -- packages/services/test/tenant-repository.test.ts`, and
      `pnpm build`. `refund.recommend` now emits `partial_refund` with a
      policy-capped amount when a full-order refund exceeds the tenant hard cap
      instead of only returning `investigate`. `shopify.get_order` now exposes
      each line item's `unitPrice` from Shopify `discountedUnitPriceSet`, so the
      default scenario-resolution agent can offer a one-line-item partial refund
      on multi-item orders without inferring from the order total. Built-in
      `refund_request`, `damaged_product`, and `wrong_item` notes now tell the
      scenario agent to use the affected line's `unitPrice` (times clearly
      affected quantity) as the `refund.create` partial amount, and to ask/flag
      a human when the affected item or price is ambiguous. Also pinned the
      literal "Where is my order?" label/recognition mapping to `where_is_order`.

- [x] **Store Facts + `@`-references in scenario notes** (designed 2026-07-10,
      BUILT 2026-07-11 across slices 1–4, each committed with full `ci:local`
      green). One deliberate scope cut: the legacy `missing-package-agent` prompt
      was NOT rewritten to reference `@shipping.lost_after` — it is off the live
      path (nothing auto-routes to it; the resolution agent's `delivery_issue`
      scenario is the live path and DOES carry the ref) and its logic is
      escalate-never-refund (`Never call refund.create`), so the make-whole
      threshold doesn't map onto it. Optional follow-up if that specialist is
      ever resurfaced. Lets a merchant state structured operational facts once and
      reference them by name inside a scenario playbook, so the load-bearing
      number lives in exactly one place and the scenario prose stays in sync with
      it by construction. Generalizes the `shippingFacts` header pattern.
      - **Vocabulary — Facts vs Policy (deliberate, load-bearing).** "Policy" is
        already taken in this codebase for the ENFORCEMENT structures
        (`refundPolicy`, `discountPolicy`, `resolutionPolicy`, `ScenarioPolicy`,
        `RefundPolicyMode`) — the walls `PermissionService`/the runtime enforce.
        **Facts** are the merchant's stated operational *grounding* facts the
        agent may quote (return window, who pays return shipping, refund method,
        processing times, delay/investigation thresholds). Keeping the two nouns
        distinct is the whole point — it draws the line the design depends on. Do
        NOT name any new block `*Policy`.
      - **Three homes — a fact field belongs to exactly one, and mixing them is
        the drift bug this design prevents:**
        1. **Enforcement policy (already exists — never re-store as a Fact).**
           Refund approval threshold = `refundPolicy.askAboveMinorUnits` /
           `denyAboveMinorUnits` (`/settings/refund-policy`). "Can cancel before
           ship? Y/N" = `order_cancellation` scenario `enabled` + `order.cancel`
           permission. "Address change on unshipped: agent directly / through
           you" = `shipping_address_update` → `order.update_shipping_address`
           permission `allow` vs `ask`. "Address change once shipped: check
           carrier/supplier first" = that scenario's `supplierMode:
           escalate_and_wait` + notes. These are walls; a contradicting sentence
           can only make the model promise something the wall blocks. The Facts
           forms DEEP-LINK to these pages, they do not copy the value.
        2. **Facts blocks (new — structured, decoded, header-injected, like
           `shippingFacts`).** The numbers/enums a scenario branches on:
           return window (days), return-shipping payer, refund method, refund
           processing time to quote, lost-package investigation days, and
           (optionally) damaged/wrong-item default resolution. Decoded
           all-or-nothing on required fields (a half-written block ⇒ `null` ⇒
           the pre-existing `knowledge.search` fallback), each optional field
           degrading individually — same discipline as `decodeShippingFacts`.
        3. **Free-text knowledge doc (already exists — paste/URL).** Pure prose:
           return condition, return address, non-returnable-items list, exchange
           details, partial-refund nuance.
      - **New Facts blocks + fields.**
        - `returnsFacts` (new `tenants.settings` block): `returnWindowDays`
          (required, the only all-or-nothing field), `returnShippingPayer`
          (`customer|merchant|depends`), `refundMethod`
          (`original|store_credit|customer_choice`), `refundProcessingTime`
          (string the agent quotes). Optional fields omit from the header when
          unset (a bare "Refund method:" reads as a default — same rule as the
          shipping header).
        - `shippingFacts` gains `lostPackageInvestigationDays` next to
          `delayedAfterDays`. Two DIFFERENT numbers on one timeline:
          `delayedAfterDays` = when `delivery_issue` opens a supplier check;
          `lostPackageInvestigationDays` = when we stop waiting and make the
          customer whole (refund/reship). This is the direct answer to "how long
          do you investigate a lost package… they should both be in sync": one
          number, one home, referenced by the `delivery_issue` /
          `missing-package-agent` notes — never hardcoded, never in prose only.
        - ~~Open sub-decision: rename `shippingProfile` → `shippingFacts`?~~
          **DONE (2026-07-11), and it went all the way down.** Symbols, module
          (`shipping-facts.ts`), the `[Store shipping facts …]` prompt header (and
          the two agent prompts that name it), the dashboard contract, and the
          POST route. The user rejected the read-time fallback the earlier
          recommendation assumed — **migration `0046_shipping_facts_rename` moves
          the persisted JSONB key**, so there is exactly one name for the block
          and no `?? settings.shippingProfile` anywhere. The migration is
          value-preserving (moves the block verbatim, drops a stale duplicate if
          both keys are somehow present) and is pinned by
          `packages/db/test/shipping-facts-rename.integration.test.ts`, which runs
          the migration's own SQL against a seeded pre-rename row — the test DB is
          already migrated, so a seeded legacy row would otherwise never be
          touched. **Deploy order: run 0046 before shipping the new code — the
          renamed reader does not look at the old key.** The pre-rename POST path
          (`/dashboard/shipping-profile`) stays registered as an alias, since the
          SPA and API deploy separately and a cached dashboard build would
          otherwise fail to save; drop it once a dashboard build carrying the new
          path has shipped.
      - **`@`-reference system (the merchant-facing mechanism).**
        - **Catalog is code-defined + single-source** (same spirit as
          `TOOL_DISPLAY_NAMES`). Each referenceable field carries: an id
          `{namespace}.{field}` (`@returns.return_window`, `@shipping.delivery_time`);
          a dropdown label; an *inline-render* fn `TenantSettings → string | null`
          (enum → sentence, like `CUSTOMS_DUTIES_SENTENCE`; distinct from the
          header-line render); and a per-field neutral **fallback phrase** for
          the null case. The `@` menu is generated from this catalog.
        - **Grammar:** resolve `@ns` (whole-block summary) and `@ns.field` ONLY
          when the id is in the catalog; leave every other `@…` (email addresses,
          unknown ids) verbatim. An unknown id is treated as dangling.
        - **Dangling ref is UNIDIRECTIONAL — one condition only.** A scenario
          references a field; the field references nothing back, so the profile
          can never be the dangling party. The single condition is "a scenario
          ref resolves to `null`", reached two ways (author the ref before
          filling the field, or clear the field after authoring the ref) — same
          state, same rule. Consequence: **all validation/warning lives on the
          scenario side.** The Facts editor needs to know nothing about who
          references it. Resolution: substitute the field's fallback phrase AND
          flag the scenario as carrying a dangling ref for a non-blocking
          Scenarios-page warning. Do NOT hard-couple the two editors' validation.
        - **Store the token, resolve on every render — never store resolved
          text** (else editing a fact wouldn't update old notes, defeating the
          point). This ENDS the `ScenarioPolicy.notes` "injected verbatim"
          contract: `buildSystemPrompt` now runs the notes through
          `resolveFactReferences(notes, tenantSettings)`. Behavior-changing →
          own tests. The dashboard note preview resolves too, so the merchant
          sees exactly the agent-visible text including the fallback state.
        - **Headers coexist with refs.** The header injection
          (`buildShippingFactsHeader` + a new returns-facts header) stays the
          scenario-AGNOSTIC baseline (`where_is_order` and the base-prompt blocks
          benefit with no note authoring). `@`-refs are for precise inlining at
          the decision point inside one playbook. Accept minor header/inline
          duplication for now; suppressing the header for a fully-inlined block
          is a later optimization.
        - **Enforcement values are read-only, auto-synced refs — not editable
          through a note.** Include `@refunds.approval_threshold` sourced from
          `refundPolicy` (auto-stays-in-sync with the wall, framed "this is what
          your settings currently say"). Leave scenario permission toggles OUT of
          the catalog for v1 — describing an allow/ask wall in prose invites the
          merchant to think the note controls it.
      - **Frontend scope.** v1: `@` in the notes textarea opens a catalog-driven
        menu that inserts the plain token text at the cursor (no rich chips,
        works in the existing `<textarea>`), plus a resolved-preview panel below
        that shows the expansion and highlights dangling refs. Later: token chips
        / inline dangling underline via a mention editor.
      - **Coverage gaps (new scenarios).** `wrong_item` is a genuine gap (only
        `damaged_product` exists) — add it as a built-in. Confirm "marked
        delivered but never arrived" is intended to ride `delivery_issue` /
        `missing-package-agent` (likely fine). "Change items before it ships" has
        no tool — omit from v1.
      - **Build order (TDD, own slices):** (1) plumbing —
        `returnsFacts` type+decode+repo get/set+contract+API+KnowledgePage form,
        add `lostPackageInvestigationDays` to shipping facts, returns-facts
        header injection; (2) `factReferenceCatalog` + `resolveFactReferences`
        (pure, unit-tested null/dangling contract) wired into `buildSystemPrompt`;
        (3) frontend `@` menu + resolved preview + Scenarios-page dangling
        warning; (4) `wrong_item` scenario + rewrite `delivery_issue` /
        `missing-package` / returns notes to reference the new facts.
      - **Slice 1 LANDED (2026-07-11).** All six sub-slices committed with full
        `ci:local` green each time:
        - `returns-facts.ts`: `ReturnsFacts` + `decodeReturnsFacts`
          (`returnWindowDays` all-or-nothing; `returnShippingPayer`
          `customer|merchant|depends`, `refundMethod`
          `original|store_credit|customer_choice`, `refundProcessingTime`
          degrade individually). Mirrors `decodeShippingFacts`.
        - `shippingFacts` gained `lostPackageInvestigationDays` (optional,
          degrades individually — an existing profile without it still decodes).
          Threaded through decode / `parseShippingFactsInput` / contract /
          api-client / Knowledge base form.
        - Repo: `TenantSettings.returnsFacts` + `setReturnsFacts` (Tag + Test +
          Live JSONB `||` merge + `getSettings` decode).
        - API: `ReturnsFactsView` contract, `parseReturnsFactsInput`,
          `POST /dashboard/returns-facts` (gated `knowledge.manage`), settings
          read-back, `api.setReturnsFacts`.
        - Header injection: `buildReturnsFactsHeader` into `buildSystemPrompt`
          under the same `knowledge.search` gating as the shipping header;
          `lostPackageInvestigationDays` surfaced in the shipping header
          (make-the-customer-whole threshold, judged from the carrier's
          tracking days — the elapsed number comes from 17track's `transitDays`,
          never a client-side day calc; per user instruction).
        - Knowledge base "Returns & refunds" form card.
      - **Slice 2 LANDED (2026-07-11).** `packages/services/src/fact-references.ts`:
        code-defined single-source `FACT_REFERENCE_CATALOG` (id, label,
        inline-render fragment, neutral fallback per field) covering
        `returns.*` (window / return_shipping / refund_method /
        refund_processing_time), `shipping.*` (processing_time / delivery_time /
        shipping_cost / customs / delayed_after / lost_after), the read-only
        `refunds.approval_threshold` (rendered from `refundPolicy`, currency via
        `Intl.NumberFormat`), and `@returns` / `@shipping` whole-block
        summaries. `resolveFactReferences(text, settings)` → `{ resolved,
        dangling }`: resolves catalog ids only; leaves emails verbatim; a
        known-namespace typo is left verbatim BUT flagged dangling; an unset
        field falls back to its neutral phrase AND is flagged dangling. Wired
        into `buildSystemPrompt` over the whole composed body (injection-safe —
        no customer text flows through the system prompt) — this ENDS the
        `ScenarioPolicy.notes` injected-verbatim contract. Unit-tested +
        buildSystemPrompt behavior tests. Exposed via the services barrel for
        the dashboard preview (slice 3).
      - **Slice 3 LANDED (2026-07-11).** Exposed the catalog + resolver to the
        pure-api-client SPA via two endpoints (NOT a contract mirror — keeps
        single-source): `GET /dashboard/fact-references` (the `{id, namespace,
        field, label}` catalog for the menu) and
        `POST /dashboard/fact-references/resolve` (`{text}` → `{resolved,
        dangling}` against the caller's tenant settings), both gated
        `settings.agents`, plus `FactReferenceEntryView` / `ResolvedReferencesView`
        contracts and api-client methods. New `PlaybookNotesField` component
        (controlled textarea, still form-`name`d so FormData submit is unchanged)
        replaces the plain notes textarea in `ScenarioCard`: typing `@` opens a
        catalog-driven menu (keyboard + mouse; anchored so it never fires inside
        an email), inserts the plain `@id` token at the cursor, and a debounced
        live preview shows the agent-visible resolved text with dangling refs
        flagged (amber). Trigger detection is the pure `matchTokenAtCaret`
        helper (unit-tested); endpoints covered by a settings integration
        round-trip. The per-card preview's dangling flag IS the Scenarios-page
        dangling warning (v1); a page-level banner summarizing all cards is a
        possible later enhancement. (The menu originally opened under the whole
        field, far from the caret; it is caret-anchored as of slice 5 below.)
      - **Slice 4 LANDED (2026-07-11) — every built-in note now points at the
        Fact that owns its numbers.** `wrong_item` landed earlier; this closes
        the notes rewrite. The defaults predated the Facts blocks, so they still
        sent the agent to `knowledge.search` for values the merchant had already
        stated — retrieval over prose to fetch a number the reply branches on.
        - `where_is_order`: quotes `@shipping.processing_time` /
          `@shipping.delivery_time` (a real expectation, not "soon"), and
          re-classifies to `delivery_issue` once `transitDays` passes
          `@shipping.delayed_after` instead of reassuring the customer.
        - `delivery_issue`: judges lateness by `@shipping.delayed_after` rather
          than searching for a delivery window. The search survives as the
          FALLBACK when the merchant stated no threshold, and so does the safety
          property that matters — with no window from either source the agent
          "cannot confirm lateness" and must say so rather than assert the order
          is on schedule (pinned by test).
        - `refund_request`: adds `@returns.return_shipping` (who pays) and
          `@returns.refund_method` (how it's paid out) next to the window and the
          processing time — the four things a refund reply has to get right.
        - `damaged_product`, `order_cancellation`, `shipping_address_update`,
          `general_inquiry`: quote the windows/timings they were vague about.
          `damaged_product` deliberately does NOT inherit
          `@returns.return_shipping` / `@returns.return_window` as constraints —
          those govern change-of-mind returns, and a broken item is our fault.
        - **Deviation — no whole-block `@shipping` / `@returns` summaries in the
          defaults.** The summary render joins its field fragments UNLABELED
          ("1–2 business days; 7–12 days; Free over $50; …"), so the model cannot
          tell processing from delivery from delayed-after. Field refs only.
          Worth fixing the summary render to emit `label: value` pairs before
          anyone leans on `@shipping` in a note — the `@`-menu still offers it.
        - **Deviation — two catalog fallbacks were the wrong grammatical shape.**
          `returns.return_shipping` rendered a clause ("the customer pays return
          shipping") but fell back to a noun phrase ("our return shipping
          policy"), so no sentence frame fit both: the fallback produced broken
          prose for exactly the tenants it exists for (the unconfigured ones).
          Same for `refund_method`. Shape-matched both and wrote the rule onto
          `FactReference.fallback`: **a fallback must fit the same sentence frame
          as its render.** New defaults are covered both ways — resolved-with-
          Facts and degraded-to-fallback — by tests over every built-in note.
      - **Slice 5 LANDED (2026-07-11) — Facts get their own page, and a
        reference renders as a chip.**
        - **Settings nav: Knowledge base is now a SECTION with two children,
          Docs (`/settings/knowledge`) and Facts (`/settings/facts`).** They are
          different jobs — prose the agent *searches* vs. numbers it *acts on* —
          and burying the structured forms under a page called "documents" hid
          them. `SettingsNavItem` gained `children`; a parent with children is a
          label, NOT a link (`activeSettingsHref` always resolves to a child),
          and it disappears entirely when a member can see none of its children.
          The two fact forms moved off `KnowledgePage` to a new `FactsPage`;
          Docs links across to Facts in its intro.
        - **Form layout:** fields sit in two-column rows that TOP-align
          (`sm:items-start`) instead of stretching, so a field carrying a hint no
          longer pads out the height of the field beside it, and the two shipping
          thresholds (delayed-after / lost-after) now pair up in one row instead
          of stacking as two lonely `max-w-sm` inputs. Every field carries a hint
          (an "Optional." where there's nothing to say) so the rows stay even.
        - **`GET /dashboard/fact-references` now carries each entry's `value`** —
          the tenant's current value for that fact, rendered by the SAME catalog
          `render` fn the runtime uses — so a chip can read `Return window:
          30 days` without a second round trip and cannot drift from the prompt.
          `null` = the fact isn't set (what the chip and the warning flag). The
          endpoint is no longer static; it reads tenant settings.
        - **`PlaybookNotesField` is now a contenteditable chip editor**, not a
          textarea. `@returns.return_window` renders inline as an atomic
          `Return window: 30 days` chip (`contenteditable=false`, so backspace
          removes the whole reference). Two pure inverse functions own the
          mapping and their round-trip is unit-tested (jsdom): `buildNotesFragment`
          (stored token text → chips) and `serializeNotes` (live editor → token
          text, absorbing the `<div>`-per-line + bogus-`<br>` markup a browser
          produces on Enter, and normalizing `&nbsp;`). **What is stored is still
          the `@id` token** — resolve on render, never resolve-and-store — so
          editing a fact still updates every note referencing it. The
          contenteditable is not a form control, so a hidden input carries the
          value to the unchanged FormData submit.
        - **The resolved-text preview panel is GONE** (the chips ARE the preview
          now); the amber **dangling-ref warning stays**, still resolved
          server-side by the runtime's own resolver so it also catches a mistyped
          id that never became a chip. Saving a fact invalidates
          `qk.factReferences`, so chips repaint with the new value.
        - Caret geometry got simpler: a contenteditable exposes a real caret rect
          (`Range.getBoundingClientRect`), so the textarea mirror-div measurement
          is gone. `clampCaretMenuLeft` survives unchanged.
        - Added `jsdom` as a root devDependency — the SPA had no DOM test
          environment, and the editor's DOM↔text mapping is the part that must
          not regress. The test file opts in with `// @vitest-environment jsdom`;
          the rest of the suite still runs in node.
        - **Menu keyboard fix (2026-07-11).** Arrowing down re-selected the first
          option: `onKeyUp` re-ran `syncMenu` for EVERY key, and `syncMenu` resets
          the highlight (a new token means a new match list). The arrow had
          already been handled on keydown and the caret never moved, so the sync
          had nothing to learn and only undid the arrow. Same root cause made
          Escape a no-op — the keyup reopened the menu it had just closed. An open
          menu now marks the keydown it consumed (`menuHandledKeyRef`) and the
          matching keyup skips the sync. Keys the menu does NOT consume still sync
          (they move the caret, which is exactly what a sync is for).
        - **The menu's keyboard behaviour is now covered** by two tests that mount
          the real component (React `act` + `createRoot` — no testing-library in
          this repo) and drive it with key events. Two jsdom limits are worked
          around IN THE TEST, and neither touches what is asserted: jsdom does no
          layout (`Range.getBoundingClientRect` is stubbed) and cannot focus a
          contenteditable, so React's commit collapses the selection — the caret
          is re-parked before each key, which is the state a browser is already in.
        - **STILL not verified in a real browser** (no Playwright in this repo):
          inserting a chip mid-sentence and pasting are unexercised. Worth a
          click-through on `/settings/scenarios` before trusting it.

- [x] Damaged-product handling on the scenario-resolution agent + order-scoped
      duplicate-photo guard (2026-07-10). The damaged-product specialist was
      orphaned by the resolution-agent cutover; its photo logic now lives where
      the default agent reads it, and the dedup guard no longer punishes a
      legitimate re-send on the same order.
      - **Scenario steering.** The built-in `damaged_product` scenario `notes`
        (`tenant-repository.ts` `defaultResolutionPolicy`) now tell the agent to:
        ask for photos with `conversation.ask_customer` when none are attached
        (then stop); when photos ARE present, `shopify.get_product` for the
        damaged line item and compare against its reference images, stamping
        `productMatch` (match/mismatch/uncertain) via `ticket.update_context`;
        on mismatch/uncertain, `merchant.notify` to flag it (never accuse/deny)
        and draft a softened confirm-the-item reply; on `match`, prefer a
        supplier replacement, refund only if no replacement. The scenario agent
        already carries all those tools — this was steering, not wiring.
        - Merchant-editable built-in: tenants with a persisted resolutionPolicy
          that customized these notes keep theirs (read path + write normalizer
          preserve sent `notes`); everyone else picks up the new default. Same
          model as the `delivery_issue` notes update.
      - **Order-scoped dedup.** `image_hashes` gains a nullable `order_id`
        (migration `0045_image_hash_order_id.sql`, additive, no backfill).
        `ImageHashStore` grew `orderId` on record/find/hit, a `bindOrder` (fills
        NULLs once the order is known), and `listPhashesForTicket`. `matchSimilar`
        suppresses a hit only when BOTH the lookup and the stored row know the
        order AND they match — an un-bound row still hits (conservative).
      - **Two-phase flagging.** Ingestion (`agent-runtime.ts` step 2b) still
        flags provisionally (order usually unknown on the first message, passes
        `identifiedOrderId` when a re-reply already has it). Once `get_order`
        stamps the canonical GID, a reconcile block binds the ticket's hashes to
        that order and RECOMPUTES the `duplicate_photo_seen_in_ticket_*` flags:
        same-order hits drop, different-order hits stay. Best-effort — a store
        failure leaves the ingestion-time flags untouched.
        - Residual: a brand-new ticket's very first message is flagged before
          its order is known; the reconcile clears it on the same tick if
          `get_order` runs. A ticket that never identifies an order keeps the
          provisional flag (acceptable — it's an operator advisory).
      - Tests: `image-hash-store.test.ts` (order exclusion, bindOrder,
        listPhashesForTicket), `image-hash-store-live.integration.test.ts`
        (order column round-trip + bindOrder), two worker e2e reconcile cases
        (same-order clears / different-order keeps), and a `damaged_product`
        notes assertion in `tenant-repository.test.ts`.

- [x] The scenario-resolution agent is THE entry agent, for every tenant
      (2026-07-10). The per-tenant `resolutionAgentEnabled` A/B flag is gone —
      not defaulted to true, **removed**: settings field, `setResolutionAgentEnabled`
      (Tag + Test layer + Live), `POST /dashboard/resolution-agent`, the
      `ResolutionPolicyView.resolutionAgentEnabled` contract field, the
      api-client method, and the /settings/scenarios Status toggle.
      - Routing: `agent-runtime.ts` swaps `support-triage` → the resolution agent
        at entry unconditionally, and always injects the `[Resolution scenarios]`
        menu. The swap is still *conditional on resolving* the agent for the
        tenant — a resolve miss leaves the ticket on triage, which is the one
        remaining path to the legacy specialists and the safe failure mode.
      - **The legacy specialists are not deleted.** They stay registered in
        `ALL_AGENTS`, keep their tests, and remain reachable by an explicit
        `agent.handoff`. Nothing routes to them on its own any more.
      - Tickets are still CREATED bound to `support-triage` (`PRIMARY_AGENT_ID`
        in `ticket-lifecycle-writer.ts`), and rebound on the first tick. That is
        deliberate: "restart from triage" rebinds to triage, re-enters, and swaps
        again. Don't "simplify" this by making the resolution agent the primary
        without reworking that retry mode.
      - **This flips behaviour for existing tenants who had the flag off.** The
        stored `resolutionAgentEnabled` key in `tenants.settings` JSONB is now
        ignored, not migrated away; it lingers harmlessly until someone writes a
        cleanup. Reading it back would be a mistake.
      - Watch: a tenant who disables *every* scenario now reaches the resolution
        agent with no `[Resolution scenarios]` menu (`applyResolutionAgentEntry`
        no-ops on an empty active list). The base prompt's "fits NONE of these →
        merchant.notify and stop" rule parks the ticket for a human, which is the
        right outcome, but it gets there without a menu to compare against.
      - `apps/dashboard` (the obsolete Next app, excluded from `tsc -b` and
        vitest) still references the removed contract field + api-client method.
        Left alone deliberately; it is dead code.

- [x] Delivery lateness is judged from carrier scalars, not customer wording
      (2026-07-10). The `delivery_issue` scenario's `recognition` said "lost,
      stuck in transit, or **very late**", but nothing in code ever measured
      lateness: the scenario agent stamps `scenarioKey` from the customer's
      message *before* any tool call, and the resolution branch pivoted only on
      `tracking.lookup` returning `status: "exception"`. A parcel scanning
      `in_transit` for six weeks read as "moving normally".
      - Root cause: 17track returns `time_metrics.days_of_transit`, the provider
        parsed it (`transitDays`), and the dashboard tracking card rendered it —
        but `tracking.lookup`'s output schema omitted the field and `execute`
        rebuilt its result field-by-field, so **the agent never saw it**. The
        stale comment in `payloads.ts` said as much ("the agent-facing tool
        ignores them").
      - `tracking.lookup` live results now carry `transitDays` (provider
        pass-through) and `daysSinceLastScan` (derived from `lastScan.occurredAt`
        via Effect's default `Clock`, floored, clamped at 0 for carrier clock
        skew). Both null when unknown. `ticket.update_context`'s closed
        `liveTrackingStatus` schema mirrors both.
      - **`checkpoints` stays dashboard-only, on purpose.** A long-haul parcel
        carries dozens of near-identical scans; the derived `daysSinceLastScan`
        captures the stuck-parcel signal for one number instead of thousands of
        context tokens. Don't "fix" this by forwarding the array.
      - The two scalars are *relative*, so no current-date header is needed in
        `buildSystemPrompt` — an earlier plan to inject one, and to add order
        `createdAt` to `get_order`, is **obsolete**. Don't do it.
      - Seeded `delivery_issue` notes now name the test: `transitDays` against
        the store's shipping window (`knowledge.search`), `daysSinceLastScan`
        for a stall, and withhold the lateness claim when either is null.
      - Caveat to watch: `transitDays` falls back to 17track's
        `days_after_order` when `days_of_transit` is absent, so for a
        slow-fulfilling store it can measure *since order placed* rather than
        *since first scan*. Treat it as approximate.
      - `missing-package-agent` BRANCH B now reads both scalars too (2026-07-10):
        B1 gains a STALLED trigger (escalates even while the carrier still says
        `in_transit` — a moving parcel scans, a stalled one does not); B2 gains a
        LATE-BUT-MOVING path that replies honestly and spends the ticket's one
        `merchant.notify` instead of implying the order is on schedule. A null
        scalar is explicitly *not* evidence of timeliness — it routes to B3.
      - **Both thresholds are the merchant's, not ours.** The agent fetches the
        store's delivery window with `knowledge.search` BEFORE choosing B1 vs B2:
        `transitDays` past the window is late; `daysSinceLastScan` *reaching* the
        window means the parcel went silent for as long as the entire promised
        delivery time, so it is stalled. No hardcoded day count exists in the
        prompt, and an undocumented window routes to B3 rather than a fallback
        guess — a test asserts the absence (`not.toContain("7 or more")`).
        An earlier draft hardcoded 7 days; that was invented, and the merchant's
        own policy is the only defensible anchor. Don't reintroduce a constant.
      - `scenario-resolution-agent` gets the same rule in its base prompt
        (2026-07-10), as a `JUDGING LATE OR STUCK` block next to the existing
        `TRACKING CAUTION`. It stays scenario-agnostic on purpose: the block
        teaches how to *read* `transitDays` / `daysSinceLastScan` against the
        store's delivery window, and leaves what to *do* about it to the
        `[Scenario playbook]` header — so `where_is_order` benefits too, not
        just `delivery_issue`.
      - Note the two thresholds measure different things against the same number:
        a delivery window bounds *total transit*, and reusing it as the
        silence bound for a stall is a deliberate approximation (carriers don't
        publish scan cadence). It is strictly safer than a guess — a stall can
        only fire once the parcel is already at the window — but it will miss a
        parcel that dies early in a long international window.
      - Follow-up (not done): **seeded defaults only reach tenants who never
        saved a resolution policy** — existing tenants keep their old
        `delivery_issue` notes and gain nothing here. Decide whether to backfill
        or surface the new guidance in the scenario editor.

- [x] Tracking destination is checked against the order's shipping country
      (2026-07-10). The agent can now confirm a `tracking.lookup` result belongs
      to the order it's answering about, instead of summarising whatever the
      tracking number returns.
      - The domain `TrackingLookup` already carried `destinationCountry` (17track
        `recipient_address.country`) and the live impl already populated it — but
        it was **dashboard-only**: the tool's output schema omitted it, so the
        agent never saw it (the same shape of gap the `transitDays` fix closed).
        `tracking.lookup`'s live-arm output now projects `destinationCountry`
        (nullable), and `execute` passes `result.destinationCountry ?? null`
        through. `ticket.update_context`'s closed `liveTrackingStatus` schema
        mirrors it too, so a takeover operator sees the value the agent compared.
      - The comparison is now a **runtime flag, mirroring the email identity
        gate** (upgraded 2026-07-10 from the initial prompt-only version). The
        runtime — never the model — owns the check:
        - **Stamp the order's country.** After a concrete order resolves
          (`shopify.get_order` / `find_customer_order` single), the runtime
          persists `context.orderShipCountry` from `shippingAddress.country`,
          alongside the existing `identifiedOrderId` binding.
        - **Compute the flag on the lookup.** `stampTrackingLookup` (the single
          place the runtime already folds a `tracking.lookup` result into
          context) now also calls `trackingDestinationMismatchFlag(dest,
          orderShipCountry)` and, on a hit, appends `tracking_destination_mismatch`
          to `riskFlags` (deduped). Pure helper, unit-tested; fail-OPEN when
          either country is null/blank.
        - **Enforce it two ways**, exactly like the email gate:
          `shouldForceReplyApproval` forces any `conversation.reply` on a flagged
          ticket to human approval (regardless of classification — this fires in
          `delivery_issue`/scenario too, not just `where_is_order`), and a bare
          `final_message` on a flagged ticket parks for human takeover
          (`hasTrackingDestinationMismatch`) instead of auto-resolving.
        - **Tell the agent.** `trackingDestinationDirective` injects a trusted
          `[Tracking may not match this order: …]` header (outside the untrusted
          fence) on the inbound / reply / resume ticks, same slot as
          `orderIdentityDirective`. Dashboard chip via `riskFlagLabel` →
          "Tracking may belong to a different order".
        - **No customer-driven clear.** Unlike the email gate (a customer can
          confirm their order email), the flag is **sticky** — only a human
          taking the ticket over resolves it. `identityVerified` does NOT lift it.
        - The three agents' prompt blocks stay as defense-in-depth (the email
          gate keeps its prompt guidance too); the runtime is now the backstop.
      - **Country granularity + representation caveat.** Both sides are country
        *names* (Shopify `shippingAddress.country` vs 17track
        `recipient_address.country`), compared normalized (trim / lowercase /
        collapse whitespace). A match means "same country", not "same address".
        Risk to watch: if the two providers ever disagree on representation
        ("USA" vs "United States"), the flag false-positives and parks a healthy
        ticket for a human — accepted as the safe direction, same fail-toward-human
        tradeoff the email gate makes. Fail-open on any null keeps first-touch
        and carrier-omits-country flows untouched.
      - No provider/17track change was needed — the field was already parsed.
        Watch: `TrackingPanel.tsx` still does `tracking.destinationCountry ??
        order.shippingAddress.country`, i.e. it *substitutes* the order's country
        when the carrier omits one. That's fine for display but means the panel
        can't itself reveal a mismatch — the check lives in the runtime, not the UI.

- [x] Store shipping profile — the merchant states the delay threshold
      (2026-07-10). Closes the "where does the number come from" hole the
      lateness work left open: agents were told to derive a delivery window from
      whatever `knowledge.search` ranked highest in the merchant's pasted prose.
      Retrieval is a poor way to fetch a number a policy branches on.
      - New `shippingFacts` block on `tenants.settings` (JSONB), edited on the
        Knowledge base settings page: order processing time, delivery time,
        shipping cost + free-shipping threshold, customs/duties payer, and
        `delayedAfterDays` — the day count past which the agent opens a supplier
        check. Three fields are required; cost and customs are optional.
      - **All-or-nothing decode.** `decodeShippingFacts` returns `null` unless
        all three required fields are valid. A half-written block must never hand
        an agent a window it can act on — `null` sends it back to
        `knowledge.search`, exactly as before this existed. An unrecognised
        customs payer degrades to `null` rather than coercing to `customer`,
        which would have the agent tell a buyer they owe duties the merchant
        actually absorbs.
      - Reaches the agent as a trusted `[Store shipping profile: ...]` prompt
        header from `buildSystemPrompt`, gated on the agent declaring
        `knowledge.search` (same shape as the knowledge-titles header). NOT
        through `knowledge.search` itself: that would have coupled the tool to
        `TenantRepository`, and it would have left the load-bearing number
        subject to ranking. Optional fields are omitted from the header rather
        than printed empty — a bare "Shipping cost:" reads to a model as "free".
      - `scenario-resolution-agent` and `missing-package-agent` now resolve the
        threshold in a stated order: **(1) the header's number wins if present;
        (2) else `knowledge.search` for the documented window; (3) else no
        lateness claim at all.** Still no hardcoded constant anywhere — the
        number is the merchant's in every branch. The `not.toMatch(/\b(7|14|30)
        \s*days\b/)` guards stay.
      - Rewrote one older assertion in `missing-package-agent.test.ts`: it pinned
        `/knowledge\.search[\s\S]{0,400}before[\s\S]{0,200}B1/`, which encoded the
        *word order* of the old sentence rather than the rule. It now anchors on
        `GET THE WINDOW FIRST` and asserts both facts (window precedes the B1/B2
        branch; `knowledge.search` is the fallback source) so a reordering that
        preserves the rule doesn't fail it.
      - Follow-up (not done): the profile is write-only from the UI — there's no
        "clear" action, though `setShippingFacts(tenantId, null)` supports it.
      - Follow-up (not done): `deliveryTime` is free text (`"7–12 days"`) and only
        `delayedAfterDays` is machine-readable. The agent still reads the former
        as prose. If the stall rule ever needs a real number, parse it there
        rather than adding another field.

- [x] De-flake `install.test.ts` "fails on tampered state" (2026-07-10). Fired
      ~1 run in 1024 in `ci:local`, unrelated to whatever was being committed.
      - The test built its tampered string as `state.slice(0, -2) + "AA"`. When
        the signature already ended in `AA` the "tampered" state was byte-identical
        to the original, so `verifyState` correctly accepted it and the assertion
        inverted.
      - Subtlety that makes the obvious fix wrong: a 32-byte HMAC is 43 base64url
        chars, and the **final char carries 4 significant bits + 2 that decode to
        nothing**. `A` and `B` decode to the same byte. Flipping only the last
        char changes the string while leaving the signature bytes untouched — it
        still verifies. Tamper a char with 6 significant bits (we use the first
        char of the signature segment) and pin the nonce via `signState`'s third
        arg so there is no randomness left to flake on.
      - Fallout, **now fixed** (2026-07-10). Chasing the above surfaced a real
        malleability in `verifyState`, wider than the final-char quirk that led
        us to it. Node's base64 decoder *drops* characters outside the alphabet
        rather than rejecting them, so junk injected anywhere in **either**
        segment decodes away and the HMAC still passes: `sig` with a `!` or a
        newline spliced in, trailing `==`, or `***` inside the payload segment
        all verified. The variant set is unbounded, not ~4. (Corollary: the
        `try/catch` around `fromB64url` was dead — `Buffer.from("!!!!",
        "base64url")` returns an empty buffer, it never throws.)
      - Never a forgery risk, for the reason the old note gave: junk vanishes at
        decode, so the decoded bytes are unchanged, and altering those bytes
        still demands the signing key. The risk was **replay**. An attacker
        holding one valid state — and states ride in redirect URLs, so they leak
        into `Referer` headers, proxy logs, and browser history — could mint
        unlimited distinct raw strings that all verify to the same
        `tenantId` + `nonce`. Against any dedup keyed on the raw string that is
        a full bypass, no key needed.
      - Fix: `verifyState` now requires each segment to be the canonical
        encoding of its own bytes (re-encode the decoded buffer, compare to the
        input segment). Regression test: "rejects non-canonical spellings of a
        valid state".
      - **Invariant** for anything that binds or dedups an OAuth state: key off
        the **decoded** `nonce` returned by `verifyState`, never the raw state
        string. `dashboard-auth-routes.ts:172` already does this (compares
        `state.nonce` to the cookie) and is the pattern to copy.
      - `verifyGoogleInstallState` (`mailbox/google-install.ts:88`) had the same
        gap and is **fixed** the same way (2026-07-10).
      - **The root cause is the shape, and there are four copies of it.** Every
        verifier that HMACs the *decoded* payload is malleable; one that HMACs
        the *encoded* string is not. `verifyOAuthState`
        (`auth/dashboard-session.ts:209`) MACs `body` before decoding it and is
        immune by construction — that is the pattern to converge on.
      - Still vulnerable, **not fixed** (same one-line fix each):
        - `verifyInstallGrant` (`auth/install-grant.ts:61`) — highest value of
          the three; install grants are what authorize a Shopify install at
          all. Junk in either segment is accepted.
        - `verifyMicrosoftInstallState` (`mailbox/microsoft-install.ts:74`) —
          the same function as the Google one, line for line.
        - `verifyTelegramLinkToken` (`telegram/link.ts:56`) — **much narrower**:
          the `/^[A-Za-z0-9_-]+$/u` charset guard at line 61 blocks injected
          junk, so only the ~4 trailing-char variants (final char carries 4
          significant bits + 2 dead ones) decode identically. Low severity.
      - Follow-up worth taking: these are copy-paste of one function. Extract a
        single `verifySignedToken` helper that MACs the encoded form, and delete
        the copies, rather than patching each site a fifth time.

- [x] Order card action row: Refund / Cancel / Change address (2026-07-10). The
      ticket page's Order card gained a footer button row, rendered only once a
      real order resolves.
      - **Cancel is new backend work.** `POST /dashboard/tickets/:id/cancel-order`
        → pure DI core `cancelTicketOrder` (`ticket-cancel-order.ts`, same shape
        as `issueTicketRefund` / `updateTicketShippingAddress`) →
        `ShopifyService.cancelOrder`. Gated on **`refunds.issue`**, not
        `orders.edit`: a cancel refunds captured money by default, so it is
        governed by the grant that lets a member move money. Idempotency key is
        stable over (ticket, order) so a double-click cannot cancel-and-refund
        twice. Guards: order must resolve → must not already carry `cancelledAt`
        → a non-`accepted` Shopify response is a failure, never a reported
        success. Audit row `ticket.order_cancelled` is best-effort (once Shopify
        has queued the cancellation, an audit hiccup must not tell the operator
        it failed). Confirm dialog exposes Shopify's real choices: refund /
        restock toggles (both default ON; only an explicit un-tick withholds
        either, so a malformed flag fails SAFE for the customer), a reason, and
        a staff note.
      - **Refund and Cancel are never gated in the UI** (decided 2026-07-10):
        both render for ANY linked order — a fully-refunded or already-shipped
        order still opens its dialog. The short-lived `orderCancelState`
        eligibility helper was written and then deleted. Rationale: Shopify is
        the authority on what it will accept; a client-side guess can only be
        wrong in one of two directions (block a legal write, or promise an
        illegal one), and every refusal now surfaces as a precise toast
        (`already_cancelled` 409, `already_refunded` 409, Shopify's own refusal
        → 502 → `*_failed`). The ONLY remaining condition is that an order is
        linked to the ticket — there is nothing to act on otherwise. RBAC
        (`refunds.issue`) is unchanged and still enforced server-side; "not
        gated" means no eligibility guess, not no authorization.
      - No-order tickets show NO money button (2026-07-10). The Order card's
        action row was already structurally safe (both `OrderPanel` no-order
        branches return before rendering `actions`), but `IssueRefundCard` —
        the agent's PATH-B refund recommendation — rendered off the audit trail
        alone, so a ticket with a recommendation but no resolved order showed an
        "Issue refund" button whose only possible outcome was `order_not_found`.
        It is now gated on `order` like the rest.
      - **Refund shows in both places** (header + card) — deliberate, per
        request. `RefundDialog` gained a `size` prop so the card trigger matches
        its `sm` neighbors.
      - Change address REPLACED the Ship-to pencil rather than joining it: two
        triggers for one popover on one card is clutter. `CardEditPopover` gained
        `trigger: "pencil" | "button"`; the address field list is now hoisted to
        one `shippingAddressFields` const instead of being duplicated.
- [x] **502 store-write outcomes now reach the operator** (2026-07-10). `call`
      throws on `status >= 500`, so every 502 the dashboard's store-write routes
      return — the status meaning "SHOPIFY refused", not "our api faulted" — was
      landing in the mutation's `onError` as a generic "Something went wrong".
      That made `ticketActionFeedback`'s `refund_failed` copy ("Shopify rejected
      the refund. No money moved…") **unreachable**, which is the worst possible
      place for a vague toast: the operator could not tell whether the money had
      moved. Fixed with one shared `recover502(kind, run)` helper in
      `api-client.ts`, applied to `issueRefund` (`refund_failed`) and
      `cancelOrder` (`cancel_failed`). Only 502 is recovered — a genuine
      500/503 still throws, because we don't know what the server did and must
      not narrate an outcome. Pinned by `test/order-write-client.test.ts` (both
      paths, each verified red first).
- [x] Empty LLM completions are retryable, not decisions (2026-07-09):
      production ticket `4746d9d6-9931-4645-944a-f1036949d78c` took a
      `supplier.updated` tick, ran three good turns
      (`ticket.update_context`, `find_customer_order`, `get_customer`), then
      OpenRouter/`google/gemini-3.5-flash` returned a response with no tool
      calls, blank text, and a ZEROED usage block — `inputTokens: 0` on a prompt
      that was ~6.7k tokens the turn before, i.e. never billed, so the model
      never saw it. `llm-service-live.ts` mapped that straight to
      `final_message`; the runtime's `autonomous_no_action` guard then correctly
      refused to silently resolve and parked the ticket in `human_takeover` with
      no draft. "Retry last step" re-sampled and succeeded, which is what
      identified it as transient. Fixed: an empty completion (no tool calls AND
      blank/whitespace/absent text) now fails with `ProviderUnavailable`, which
      the runtime maps to a retryable `Failed` so pg-boss re-samples with
      backoff. Deliberately keyed on blank TEXT, not zero-token usage — a
      provider that under-reports usage must not turn valid final messages into
      a retry storm. Verified with red/green provider regressions and full
      `pnpm test` (2893 passing).
      - The `autonomous_no_action` guard was NOT at fault and must not be
        loosened: it is the thing that stopped a live customer ticket from being
        closed with nothing sent.
- [x] `supplier.updated` ticks re-engage the agent with the thread transcript
      (2026-07-09): the prefetch at the top of the tick was gated on
      `event.type === "ticket.resumed"` alone, so a supplier responding put the
      agent back in the loop blind — the payload is the SUPPLIER's note, not the
      customer conversation. On ticket `4746d9d6` the agent burned turns 1-2
      re-hunting the order (`find_customer_order` → `get_customer`) before it
      could act; the retry tick, which DID get the transcript, went straight to
      `get_order` and had a draft queued by turn 2 (turn-0 prompt 6,615 vs 7,208
      tokens — the gap is the missing transcript). Extracted the gate into the
      pure, unit-tested `shouldPrefetchThread(eventType)` and widened it to
      `supplier.updated`; `buildInitialMessages` now inlines the transcript
      (untrusted-fenced, oldest-first, before the supplier note). Confirmed
      `manual.takeover` needs no transcript — it parks the ticket in
      `human_takeover`, where the runtime holds every event before the loop.
- [x] `supplier.updated` prompt injects the bound-order directive + ticket-facts
      header (2026-07-09): it was the only agent-facing branch of
      `buildInitialMessages` that injected neither, while `ticket.created`,
      `customer.replied`, `message.received` and `ticket.resumed` all do. This
      was the *other* half of why ticket `4746d9d6` re-hunted the order on the
      supplier tick — without the directive the agent never saw the canonical
      bound order GID, so it re-searched by customer (`find_customer_order` →
      `get_customer`) instead of loading by id. The transcript masked that
      symptom; the directive fixes the cause. Precedence mirrors every sibling
      branch: `orderIdentityDirective || boundOrderDirective`, so an unverified
      order/customer mismatch still challenges before it discloses (a supplier
      tick ends in a customer-facing reply, so the identity gate applies there
      too). Both stay OUTSIDE the untrusted fence, pinned by tests.
- [x] Diagnose Elva Labs supplier redirect for `anasncri@gmail.com`
      (2026-07-09): production data showed the user is correctly bound as a
      supplier to both `477168f6-a0cc-4f52-b1a9-70d28ac4c42f` (Elva Labs) and
      `4f685543-53d4-4a8b-a73c-71eb6155d1b4`, but Elva's persisted Supplier
      role still grants legacy `supplier.cases.view/respond` permissions from
      before the case→ticket rename. Current API/SPA gates require
      `supplier.tickets.view/respond`, so the supplier client gate redirects to
      `/`. Added migration `0044_supplier_ticket_permissions` to map old ids to
      current ids, and made `ensureSupplierRole` remove stale supplier-case
      permissions before ensuring the current supplier-ticket permissions.
      Verified with a red/green supplier-store integration regression, local
      migration, and `pnpm build`. Production repair was not applied in-session:
      the approval reviewer rejected the live RBAC write because the user had
      asked for diagnosis rather than explicitly approving a production data
      mutation; deploy/run the migration or explicitly approve the narrow repair
      to restore Elva immediately.
- [x] Supplier portal deep links select a supplier workspace (2026-07-09):
      suppliers with both a merchant/default workspace and a supplier binding
      could land on `/`, fire the merchant Today summary, see "Couldn’t load
      your summary", and never reach `/supplier/tickets`. Fixed the SPA session
      bootstrap to prefer a supplier workspace on `/supplier/*` routes, even
      when the stored workspace is merchant, while preserving normal merchant
      defaults elsewhere; if no supplier workspace exists, the supplier route
      falls back to the normal active workspace so RBAC handles accidental visits
      cleanly. Verified with the focused session-context regression, dashboard
      SPA build, and `pnpm build`.
- [x] Ticket attachments can render under every message that carried them
      (2026-07-09): `ticket_attachments.message_id` made attachment↔message
      effectively one-to-many, so re-sending the same ticket file in a later
      reply left it visually bound only to the first message. Fixed by moving
      message bindings into `ticket_attachment_messages`, backfilling existing
      non-null bindings in migration `0043_attachment_message_join`, and having
      the dashboard thread projection read the join-backed binding list while
      the composer picker still reads the ticket-level attachment index.
      Verified with focused conversation/retry/thread regressions and
      `pnpm build`.
- [x] Bundle approval reply rows have attachment controls (2026-07-09): when
      multiple approvals were pending, the ticket rendered `BundleApprovalBar`
      instead of `ChatComposer`, so the bundled `conversation.reply` textarea
      had no `Attach` button or `Ticket files` picker. Fixed by adding the same
      raw upload + ticket-file staging controls to bundle reply rows and by
      sending edited reply inputs, including staged `attachmentIds`, through
      both per-row Accept and whole-bundle Approve all. Verified with the
      bundle attachment regression, attachment-picker tests, dashboard SPA
      build, and `pnpm build`.
- [x] Harden first-look tracking failures for order-status / scenario replies
      (discovered 2026-07-08): production ticket
      `12626e22-d367-40aa-950b-f3065406a711` initially stamped
      `context.liveTrackingStatus.kind=no_provider` /
      `reason=unsupported_carrier` for `LZ408772868CN`, so the
      scenario-resolution agent drafted a generic "has shipped, track here"
      reply. A later live provider probe returned carrier `3011`,
      `status=exception`, `transitDays=60`, latest scan
      `DEVOLUCION, Finalizado plazo retirada...`. Likely cause: first
      `tracking.lookup` ran immediately after 17track registration and mapped a
      transient rejected/not-yet-synced response to permanent
      `unsupported_carrier`. Note: the provider already has a `sync_pending`
      error, but only when `gettrackinfo` returns neither `accepted[]` nor
      `rejected[]`; any `rejected[]` returned `null` and the live service
      converted it to `no_provider/unsupported_carrier`. The scenario
      prompt also has no hard rule for stale/no-provider international
      shipments. Fixed by retrying a first rejected/empty 17track info response
      as `sync_pending`, widening tool/dashboard contracts for that reason, and
      adding scenario/order-status prompt guidance not to draft a confident
      "just shipped" reply for old or unsynced tracking. Verified with focused
      Vitest regressions and `pnpm build`.
- [x] Keep ticket Tracking card in sync with restarted scenario runs
      (discovered 2026-07-08): on the same ticket, a full retry saw Shopify's
      newer fulfillment tracking number `1ST04125178926` and drafted against
      it, but the card still used stale `context.liveTrackingStatus.trackingNumber`
      (`LZ408772868CN`) because `GET /dashboard/tickets/:id/tracking` prefers
      the persisted stamp before resolving the current order fulfillment. The
      scenario-resolution agent can call `tracking.lookup` without the explicit
      order-status-agent instruction to re-stamp `liveTrackingStatus`, so
      restart/retry did not necessarily refresh the card source. Fixed in the
      runtime: every successful `tracking.lookup` now stamps
      `context.liveTrackingStatus` atomically in the same transaction as the
      tool audit, and failed lookups clear the stale stamp. Verified with a
      runtime regression where the agent does not call `ticket.update_context`.
- [x] Product image thumbnails in the ticket order card (2026-07-08):
      `ShopifyLineItem` gained `imageUrl` (mapped from `image { url }` in the
      shared `ORDER_FIELDS` fragment, so `get_order` and `find_customer_order`
      both carry it); both OrderPanels (dashboard-spa + legacy Next dashboard)
      render the thumbnail with the old Package-icon tile as the null-image
      fallback. Deliberately NOT projected into the `get_order` tool output —
      the agent's context stays image-URL-free; the refund modal's separate
      `ShopifyRefundLineItem.imageUrl` was already there and is untouched.
      - Thumbnails are CDN-resized at query time (2026-07-08):
        `url(transform: { maxWidth: 96, maxHeight: 96 })` in `ORDER_FIELDS`
        (validated against the Admin schema; no new scopes), so the browser
        never downloads full-size product originals for a 36px tile; `<img>`
        also `loading="lazy" decoding="async"`.
- [x] Refund modal line-item images CDN-resized too (2026-07-08): the
      `OrderRefundContext` query now uses the same
      `url(transform: { maxWidth: 96, maxHeight: 96 })`, and both
      RefundDialogs' `<img>`s gained `loading="lazy" decoding="async"`.
- [x] Tickets sidebar status badge kept in sync with the ticket page's live
      chips (2026-07-08): the detail page is on TanStack Query and
      `TicketLiveBoundary` invalidates `qk.ticket(w, id)` when its `?since=`
      poll sees a new audit event, but the sidebar is hand-rolled client state
      whose only freshness trigger was a pathname change — so its status badge
      drifted while the merchant sat on the ticket. Fix: tiny framework-free
      pub/sub (`lib/tickets-refresh-signal.ts`, unit-tested); the boundary
      broadcasts alongside the invalidation and `TicketsSidebar` subscribes,
      re-running the existing fetch-page-1 + `applyFreshPage` in-place top-up
      (extracted into a shared `refreshTopPage` callback; no reorder, no
      scroll jump). Deliberately did NOT migrate the sidebar to
      `useInfiniteQuery`: invalidation would refetch all loaded pages with the
      server's current sort and reintroduce the reorder/scroll-jump that
      `applyFreshPage` exists to avoid.
      - Residual gap (pre-existing, unchanged): the top-up only folds in page
        1, so a changed ticket sitting beyond page 1 of a deep-scrolled list
        keeps a stale badge until it sorts into page 1 by `updated_at`.
- [x] ~~Ingest spam/junk mail across ALL mailbox connectors~~ — **REVERTED
      2026-07-11.** Landed 2026-07-07 (a149007), reverted in full: mailbox
      connectors are INBOX-only again. Spam-filtered customer mail is once
      more invisible to the agent; that is the accepted trade.
      - Reverted surface: Gmail watch back to `labelIds: ["INBOX"]` and the
        `gmailListHistory` filter back to INBOX-only (so a lingering
        INBOX+SPAM watch lease still can't ingest spam — the filter drops
        it); `includeSpamTrash` and the `(in:inbox OR in:spam)` backfill /
        reseed queries removed; Graph junk subscription + slot-based
        `renewOne` removed (back to a single inbox subscription); IMAP junk
        poll leg + `lastJunkUid` cursor removed.
      - Clean revert: no migrations or schema were ever involved, and the
        later cursor fix (2e6a9ef, `gmail-webhook.ts`) is untouched.
      - Stale metadata left behind in `connector_connections.metadata` —
        `watchLabelIds`, `lastJunkUid`, `junkSubscriptionId`,
        `junkSubscriptionExpiresAt`. Harmless: the reverted code reads
        metadata as loose JSONB behind `typeof` guards and simply ignores
        unknown keys. Not worth a migration to strip.
- [x] **Prod cleanup — orphan Graph junk subscriptions: NOT NEEDED**
      (confirmed 2026-07-11). No tenant had ever connected an Outlook
      account, so the revert left no junk subscriptions live and the code
      revert alone fully stopped spam ingestion. Kept as the reference if
      Outlook is ever connected and this gets reverted again:
      - The trap: the Outlook webhook is folder-agnostic (it fetches by
        message id and never checks which folder fired). So a junk
        subscription created *before* a revert keeps delivering
        notifications that the reverted code still ingests — reverting the
        code does NOT stop Outlook spam on its own.
      - Self-healing: the reverted renewal cron no longer knows the junk
        slot, so nothing renews those subscriptions and they lapse within
        `GRAPH_SUBSCRIPTION_TTL_MS` (4000 min ≈ 2.8 days).
      - To stop it immediately: read each `junkSubscriptionId` from
        `connector_connections.metadata` and
        `DELETE https://graph.microsoft.com/v1.0/subscriptions/{id}`.
      - Gmail and IMAP need no such cleanup: Gmail's reverted history filter
        drops SPAM even while an old INBOX+SPAM watch lease is still live,
        and the IMAP junk poll leg stops the moment the code ships.
- [x] Fly Gmail OAuth redirect repaired (2026-07-07): the live Fly app still
      had `GOOGLE_OAUTH_CALLBACK_URL` set to the old Railway callback
      (`https://api-production-7770.up.railway.app/google/auth/callback`),
      causing Google `redirect_uri_mismatch` after the authorized redirect URI
      was moved to `https://support-agent-backend.fly.dev/google/auth/callback`.
      Updated Fly secrets for `GOOGLE_OAUTH_CALLBACK_URL` and
      `APPROVAL_BASE_URL` to the Fly API origin, and `DASHBOARD_BASE_URL` to
      the current dashboard SPA Worker after verifying the old Worker URL 404s
      and `support-agent-dashboard-v2` is live. Verified the running machine
      env via `fly ssh console` and `curl -fsS
      https://support-agent-backend.fly.dev/healthz`.
- [x] Data-processing notice subprocessor list corrected (2026-07-07):
      `apps/api/src/features/system/legal.ts` now lists one entity per row
      with its purpose — added Microsoft (Outlook/Graph mailbox connector)
      and Telegram (merchant notifications), renamed "Cloudflare R2" to
      Cloudflare (object storage + web hosting), noted merchant-connected
      IMAP/SMTP mailboxes flow through the merchant's own provider, and
      added a "Sharing on merchant instructions" section for supplier-portal
      / supplier-sheet disclosure. `DATA_PROCESSING_NOTICE_VERSION` bumped
      2026-07-04 → 2026-07-07, so existing tenants must re-accept before new
      connector writes (`legalAcceptanceIsCurrent`). DPA version unchanged.
      Verified with `pnpm build` and the legal + tenant-repository tests.
- [ ] Consider extracting the subprocessor list to a standalone page/appendix
      referenced from the DPA with a notify-of-changes clause, so future
      connector additions don't re-version the whole notice.
- [ ] Replace the current "any data-processing notice version bump blocks
      connector writes" legal gate with a DPA-once model: hard-block only when
      no DPA/current material contract was accepted; treat subprocessor /
      informational notice updates as notify-only with an objection window
      (email/in-app), backed by a public subprocessor appendix. Connector
      installs remain explicit merchant instructions for that connector.
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
- [x] Fresh post-settings-rework re-sweep (2026-07-07): diffed all 34 Next
      pages against the SPA router after the 07-06 settings simplification.
      Every page is ported, deliberately hidden (/audit), or inlined
      (/connect/imap lives inside IntegrationDetailPage). Fixed the two
      findings: (1) the 07-06 removals were inconsistent — /settings/permissions
      and old agent deep links (/settings/agents/new, /settings/agents/<id>)
      fell to the 404 page while /settings/resolution-policy and bare
      /settings/agents got ClientRedirects; both now redirect to
      /settings/agent (splat /settings/agents/$ — shadowing the bare sibling
      is harmless since both share the target). Test coverage pins both removed
      legacy URLs and splat matching so `/settings/agents/*` does not shadow the
      distinct `/settings/agent` page. (2) deleted the dead
      features/placeholder.tsx (nothing imported it since the splat removal).
      Test: test/legacy-settings-redirects.test.ts (source pins + splat
      matching pins). Verified with the SPA suite (483 tests), `pnpm build`,
      and the SPA Vite build.
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
- [ ] Improve internal admin API auth diagnostics: `apps/admin` currently throws
      only `admin api <status> on <path>`, so a production 401 on `/admin/tenants`
      does not surface whether apps/api reported `missing bearer token` or
      `invalid token`, nor which admin/API origins were involved. Include
      enough non-secret runtime context to distinguish wrong API origin from a
      wrong admin runtime secret.
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
- [x] Outbound attachments (2026-07-09): `ConversationReply.attachments` is now
      actually encoded on send in all three connectors (Gmail multipart/mixed,
      Graph draft fileAttachment POSTs, SMTP nodemailer attachments + Sent-copy
      MIME). Connectors resolve storageKey→bytes via `BlobStorage` at send time
      (`resolveOutboundAttachments`; missing blob → `ConversationSendFailed`,
      retriable, never a silent drop). Conversation Lives + router now REQUIRE
      `BlobStorage`; both bootstraps provide the existing blob layer.
- [x] Attachment uploads (2026-07-09): `ticket_attachments` index table
      (migration 0039) + `TicketAttachmentStore` (Tag in services, Live in db,
      Test layer). Everything outside the trust boundary references rows by
      opaque id; `getByIds` resolves strictly within (tenant, ticket).
      SECURITY: `conversation.reply` / `ask_customer` tool schemas no longer
      accept raw `storageKey` from the LLM (was a cross-tenant blob
      exfiltration primitive once sends encode attachments) — they take
      `attachmentIds`, resolved via the store (worker provides the Live).
      Merchant: composer Attach button → raw-bytes upload endpoint
      (image/png,jpeg,gif,webp + pdf, magic-byte sniff, 10 MiB cap, per-route
      11 MiB bodyLimit) → ids on manual reply + merged into Edit-and-Approve
      overrides. Supplier: portal update form uploads scoped to the OPEN
      escalation; `recordSupplierUpdate` validates ids (source='supplier', own
      ticket), stamps `context.supplierUpdate.attachments`, event payload
      carries `{id, filename}`; runtime prompt lists trusted ids + fenced
      untrusted filenames so the agent forwards files via
      `conversation.reply` `attachmentIds`. Context card shows "Supplier
      files"; GET `/dashboard/tickets/:id/attachments` lists a ticket's index.

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
- [x] Built-in "update my shipping address" scenario (2026-07-08): new
      `order.update_shipping_address` tool (Shopify `orderUpdate` via the
      existing `ShopifyService.updateOrderShippingAddress`) lets the agent fix
      the ship-to on an UNSHIPPED order — refuses any order with a fulfillment
      (`OrderAlreadyFulfilled`) or a cancelled one; per-field three-state edits
      (absent keep / null clear / string set) merged over the current address,
      same semantics as the dashboard pencil. risk:write, ask-gated
      `permission-toggle`, `write_orders` (already requested — no re-OAuth).
      Scenario `shipping_address_update`: customer gave the address → propose
      the update; didn't → `ask_customer` first; already shipped →
      `supplierMode: escalate_and_wait`. Bundle-ping summarizer shows the
      destination (street + city), never the GID.
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
- [x] SPA is mobile friendly (2026-07-08). Below `md` (768px, pinned by
      `lib/use-media-query.ts` + test) the shell branches in JS via
      `useIsMobile()`: icon rail is replaced by a dark top bar whose hamburger
      opens the labeled nav as a drawer (`RailNavContent`, extracted from
      `IconRail`, powers both the hover rail and the drawer); the secondary
      sidebar (settings nav / ticket switcher) becomes an overlay drawer,
      closed by default and untied from the persisted desktop open/width
      prefs; `h-screen` → `h-dvh` (iOS browser chrome); alert dialogs keep a
      16px gutter + `max-h-[90dvh]` scroll; ticket-detail header wraps and
      hides the customer email below `sm`; details panel drawer is opaque
      (`bg-background`) while off-canvas. Tables intentionally keep
      horizontal scroll on phones (decided 2026-07-08, no card layouts).
      Verified by stubbed-API Playwright screenshots at 375×812 and 1440×900.
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
- [x] Merchants configure the resolution policy PER SCENARIO again (2026-07-11):
      the action checklist + approval choice is un-hidden on every scenario card
      (`SHOW_PER_SCENARIO_ACTIONS` deleted; it was hidden 2026-06-28 when tools
      moved to the agent). This is the hard gate — `applyScenarioEnvelope` strips
      a disabled action from the model's tool list — so the checkbox now sits on
      the same card as the playbook that names it, and the approval dropdown is
      disabled for an action the agent may not take at all.
- [x] The playbook warns, live, when its prose contradicts those switches: a note
      that `/`-references an action the scenario denies (a remedy that isn't
      ticked, or `supplier.escalate` with supplier handling set to none) shows an
      amber line naming it the merchant's way. Purely client-side —
      `deniedActionsFor` mirrors the runtime envelope, and both halves are on the
      one screen. Baseline actions never warn.
- [x] Playbook notes reference AGENT ACTIONS with a `/` sigil, the way they
      already reference Facts and docs with `@` (2026-07-11). A note stores
      `/refund.create`; the editor chips it as "Issue a refund" (label from
      `TOOL_DISPLAY_NAMES`, the one merchant-facing name); `resolveFactReferences`
      renders it back to the bare tool id, so the prompt is byte-identical to the
      pre-chip prose. Two sigils = two menus: `@` for sources of truth (a value,
      can dangle), `/` for actions (no value, never dangles). Legacy stored notes
      are backfilled by `tokenizeActionReferences` on BOTH decode paths — no
      migration; a row converges on its next save.
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
- [x] `purgeLeakedTenants` takes an `onlyTenantIds` scope (2026-07-10), and its
      own integration test uses it. Root cause of a long-standing "shared dev DB
      pollution" flake that was really a live race, not stale rows: the purge
      test snapshotted every tenant in the DB, dropped its own leaked id, and
      called the real purge — which deletes every tenant absent from the
      keep-list. Under vitest's default file parallelism that deletes tenants a
      concurrent test file created after the snapshot. Both directions were
      observed: `dedup-risk-flags` failed as the victim (its tenant + tickets
      vanished mid-test), and `test-teardown-purge` failed as the aggressor on
      `tickets_tenant_id_tenants_id_fk` when a concurrent insert landed between
      its ticket delete and its tenant delete. `onlyTenantIds` narrows the purge
      (a tenant is deleted only if it is in the scope AND absent from the
      keep-list); it never overrides the keep-list. The unscoped form is now
      reserved for `vitest.global-teardown.ts`, which runs after every file has
      finished and so cannot race.
- [x] `connector-credential-store-live.integration.test.ts` derives every shop /
      mailbox domain from a per-run tag (2026-07-10), closing the "connector-test
      debris" flake. The active-shopify and active-mailbox unique indexes are
      keyed on `(provider, shop_domain)` with no tenant column (a deliberate
      cross-tenant guard: a shop/mailbox is actively connected to one tenant
      only), so a run killed while an active row was live left a leftover that
      rejected the next run's insert even under a fresh tenant. Per-run-unique
      domains strand any leaked row on a name no later run writes; the index is
      untouched. Reproduced red on a scratch DB by planting the debris, green
      after the fix with the debris still present.
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
- [x] Queued-bundle approval ping fixed + magic-link review surface (2026-07-07).
      The bundle park's Telegram ping pointed `${APPROVAL_BASE_URL}/tickets/:id`
      (a dashboard path on the API host → `not_found`). Now: the ping lists each
      queued action (code-derived `summarizeApprovalAction` over the approval
      rows' structured `proposedInput` — no LLM at send time, currency never
      invented) and carries ONE signed ticket-bound magic link
      (`signBundleReviewToken`, action namespace `bundle_review`, no cross-replay
      with single-approval tokens) to `GET /approvals/bundle/:ticketId` — a
      token-auth review page (GET never mutates; Telegram's preview fetcher =
      the S2 scanner rule) with Approve-all / Reject-all confirm-POSTs reusing
      `decideApprovalBundle` (all rows decided, then ONE event) and a "View on
      dashboard" link for edits / per-action decisions.

- [x] Tool display names have ONE source of truth (2026-07-08):
      `TOOL_DISPLAY_NAMES` in agent-core (`tool-display-names.ts`). `defineTool`
      stamps `Tool.displayName` (now required) from it; inline displayNames were
      removed from the real tools; SPA `toolActionLabel` reads the same map; the
      Telegram bundle summarizer uses it as the line base. Renames:
      conversation.reply → "Reply to the customer", order.cancel → "Cancel and
      refund the order", supplier.escalate → "Ask the supplier for help",
      supplier.add_sheet_row → "Log the issue with the supplier"; every internal
      tool got a friendly name too (audit rows read as words). Visibility on the
      agent page remains governed solely by `tenantControl` — a name no longer
      implies tenant-facing. Drift guard: packages/tools/test/display-names.test.ts
      (map ⊆ registry, registry ⊆ map, uniqueness, renames pinned).

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
- [ ] `gmailListHistory` does not follow `nextPageToken`, but the push handler
      still advances the cursor to `latestHistoryId` — a burst of >1 page of
      history records would silently drop the overflow messages. Paginate, or
      only advance the cursor to the last page actually consumed. (Found
      2026-07-08 while diagnosing a "resend didn't reopen" report; not the
      cause of that incident.)
- [ ] Gmail token-refresh failures in the push handler only `console.error`
      and drop the push — repeated refresh failures should stamp connector
      health / notify the merchant (Elva Labs mailbox was dead ~17h on
      2026-07-08 before anyone noticed; see incident notes in memory).
- [ ] Gmail push handler advances the history cursor past messages whose
      dispatch FAILED (`publishGmailMessageIds` counts `failed` but
      `handleGmailPushNotification` still patches `historyId` to
      `latestHistoryId`) — one transient `messages.get`/publish/blob error
      permanently loses that inbound email. Only advance past successfully
      published ids, or park failed ids for retry. Prime suspect for the
      2026-07-08 "customer reply didn't reopen ticket e3a7b4c7" report
      (16:30 push refreshed token + advanced cursor, zero messages ingested).

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
- [x] Fixed 17track first-lookup race for newly registered tracking numbers
      (prod finding 2026-07-08): `tracking.lookup` can run seconds after a new
      number is registered with 17track, before 17track's first carrier sync is
      complete. The current Live impl treats an empty/non-accepted
      `gettrackinfo` response as `no_provider / unsupported_carrier`, so the
      agent may draft from a public URL even though the same key returns live
      data a few minutes later. Repro evidence: ticket
      `35df42a9-7756-4cc5-8bcc-a81182004dee` looked up
      `LULU1000630903` at `2026-07-08T14:25:18Z`; direct prod-key 17track
      fetch later returned live data with `latest_sync_time`
      `2026-07-08T14:31:50Z`. Fix: provider tests now pin "registered / sync
      pending" (`accepted: []`, `rejected: []`) and the 17track parser maps it
      to `TrackingProviderUnavailable` instead of the successful
      `unsupported_carrier` degrade. Superseded by the 2026-07-08 hardening
      above: repeated `rejected[]` rows now surface as `sync_pending`, not
      permanent `unsupported_carrier`, because 17track may return them before
      first sync completes.
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
- [x] Supplier tracking edit Shopify access fixed in code (2026-07-09): the
      old follow-up named obsolete `write_fulfillments`, which was never in ANY
      scope list — so the portal's tracking edit could never have been
      authorized on any install. Current Shopify `fulfillmentTrackingInfoUpdate`
      takes any ONE of `write_assigned_fulfillment_orders` /
      `write_merchant_managed_fulfillment_orders` /
      `write_third_party_fulfillment_orders`, plus the Shopify staff-user
      permission `fulfill_and_ship_orders`. We request only the latter two —
      `write_assigned_fulfillment_orders` is for apps registered as a Shopify
      fulfillment service, which this app is not. Added them to
      `DEFAULT_SHOPIFY_SCOPES` + `shopify.app.toml`, added a Shopify capability
      grid row ("Update shipment tracking from supplier portal"), and classify
      that denial as `shopify_permission_required` so the supplier sees a
      stable "store connection doesn't allow tracking changes yet" message
      instead of a generic retry. Verified with focused API/SPA regressions,
      dashboard-contracts build, SPA build, and `pnpm build`.
- [ ] Deploy updated Shopify app scopes, then reauthorize connected stores.
      NOTE `DEFAULT_SHOPIFY_SCOPES` and `shopify.app.toml` request NOTHING at
      install time — `buildInstallUrl` sends no `scope=` param, so Shopify reads
      the app-config scopes. The toml only binds once `shopify app deploy` runs
      (which overwrites the dev dashboard); otherwise the dashboard field is the
      live value and the toml is documentation. Per-tenant pilot apps each have
      their own app + own dashboard — the toml points at one `client_id` only,
      so there is no fan-out and each pilot app must be updated individually.
      Existing tokens keep failing until the merchant re-grants (Shopify
      auto-prompts on the next install visit), and the authorizing staff user
      must hold `fulfill_and_ship_orders` — a user permission, not a scope, so
      no config change can grant it.

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
- [x] Attachment previews in the ticket thread (2026-07-09, `f662d2b` +
      `c61e2ea`). Three legs, as designed:
      1. INBOUND indexing (`f662d2b`): the runtime writes `source='inbound'`
         rows where `message.received` / `customer.replied` binds to a ticket —
         same tx as the ticket create + `event.received` audit, best-effort like
         the neighbouring `recordMessageId`. Rows carry `message_id`
         (migration 0042). Idempotent on `(tenant_id, storage_key)` UNIQUE +
         `onConflictDoNothing` (`recordInbound`, separate from `record` because
         it returns no row): a redelivered Pub/Sub push replays the identical
         payload. This is the ONLY place the storageKey→ticket mapping is ever
         persisted (payloads aren't stored; Gmail's attachmentId is unstable
         across fetches), so `AgentRuntime` REQUIRES `TicketAttachmentStore` —
         deliberately not `Effect.serviceOption`, since a missing layer would
         silently orphan every uploaded blob. Widening its R forced 7 test
         layer compositions to provide `TicketAttachmentStoreTest()`; that is
         the point.
      2. `GET /dashboard/tickets/:id/attachments/:attachmentId/url` (`c61e2ea`):
         5-minute `presignGetUrl` (`ATTACHMENT_URL_TTL_SECONDS`), id resolved
         within (tenant, ticket) via `getByIds`, gated on `tickets.view`. The
         browser fetches the blob directly — bytes never stream through the API.
         The signed URL DOES embed the object path (that's what's signed); the
         invariant is that a storage key is never *accepted* from a client.
      3. Thread join + SPA (`c61e2ea`): `projectConversationThread(thread,
         attachmentIndex)` matches index rows onto messages by message id;
         `DashboardConversationAttachment` gained `id: string | null` (null =
         connector named it, we hold no bytes → inert badge). SPA
         `AttachmentPreview.tsx`: images → thumbnail + lightbox, other stored
         files → open on click (no URL signed per render), errors → inert badge.
         `attachmentPreviewKind` refuses to inline `image/svg+xml` (script-
         capable; can only arrive from a connector, not the upload allowlist).
      - Gmail-only today: `imap-poll` and the Graph webhook never put inbound
        attachments on the payload, so no other connector creates index rows.
      - Pre-existing blobs have no index rows (no backfill source).
- [x] Sent files render under their own bubble (2026-07-09, `f9861ed` +
      `1ec1cad`). Every send path stamps `message_id` via
      `TicketAttachmentStore.bindToMessage(…, sent.id)` — the id `fetchThread`
      reports for that message, which is what the projection joins on. Call
      sites: `resolveDraftAttachmentIds`' callers (`conversation.reply`,
      `ask_customer`, via the shared `bindSentAttachments`), the manual reply
      handler, the resend-approval handler, and the reply-delivery retry cron.
      Binding is BEST-EFFORT everywhere: the reply is already delivered, and a
      tool error would make the runtime retry and send the customer a 2nd copy.
      - First binding wins (`WHERE message_id IS NULL`), so an inbound file
        keeps the message it arrived on when a reply forwards it back out.
        CONSEQUENCE: a file attached to two different replies renders only
        under the first. A true many-to-many needs a join table — see below.
      - PREREQUISITE, found while wiring it: `GraphConversationLive.send`
        returned the reply DRAFT's id. Graph mints a new id when the item moves
        to Sent Items and `buildThread` filters drafts out, so that id appears
        in no thread — the join would have silently never matched for Outlook.
        `send` now resolves the sent copy via the draft's `internetMessageId`
        (best-effort; Sent Items is eventually consistent, miss → draft id).
        Gmail (`raw.id`) and IMAP (RFC Message-ID) already agreed both ways.
      - TWO SILENT DATA-LOSS BUGS fixed in the same slice — both sent
        `attachments: []`, delivering a reply that referred to a file the
        customer never got: (1) `decodeApprovedReply` dropped `attachmentIds`,
        so resending an approved-but-never-sent reply lost them; (2) the
        reply-delivery retry cron re-sent a stored draft without them. Both now
        re-resolve the ids within (tenant, ticket) — stored input is NOT a trust
        boundary — and refuse the delivery if an id no longer resolves.
      - `TicketAttachmentStore` is now on the worker's top-level runtime layer
        (the retry cron resolves against it directly).
- [ ] Attachment↔message is one-to-many, not many-to-many: a file re-sent on a
      second reply stays bound to the first message and renders only there. If
      merchants re-send the same file often (the composer's "Ticket files"
      picker makes it one click), replace `ticket_attachments.message_id` with a
      `ticket_attachment_messages` join table.
- [ ] `tsc -b` does NOT typecheck `apps/dashboard-spa` or any `*.test.ts`.
      A broken prop reference in the SPA passed `pnpm build` AND the Vite build
      (esbuild strips types without checking). Use
      `npx tsc --noEmit -p apps/dashboard-spa/tsconfig.json`. Consider wiring
      that into `ci:local`.
- [x] Composer: offer EXISTING ticket attachments in a picker (2026-07-09,
      `44dde5d`). `ChatComposer` reads the ticket attachment index
      (`qk.ticketAttachments`) and offers every unstaged file behind a "Ticket
      files" button; picking one costs no upload (the reply carries its
      existing opaque id). Offer/capacity rules are the pure
      `lib/attachment-picker.ts` (`attachmentPickerState`): staged files drop
      out, the 8-attachment cap counts fresh uploads + picked files together,
      and the list renders unselectable at capacity rather than vanishing. A
      fresh upload invalidates the index query so unstaging its chip leaves the
      file reachable.
- [x] Orphaned upload GC (2026-07-09, `20c31d3`). `ticket_attachments.used_at`
      (migration 0041) is stamped when a file becomes part of something durable:
      an outgoing reply (`resolveDraftAttachmentIds`, manual reply handler) or a
      supplier's posted update (`recordSupplierUpdate`, IN its tx — used iff the
      update committed). `apps/worker/src/attachment-gc.ts` reclaims rows that
      stay NULL past 30 days, on the existing daily retention cron.
      - Two retain-guards, both fail-safe: a PENDING approval on the ticket may
        hold the ids in `proposedInput` (the tool body only marks them on
        approve, and approval links live 30 days), and an OPEN escalation may
        still receive the update that binds its uploads. Both use drizzle
        `notExists()` — a hand-rolled sql`NOT EXISTS` does not qualify the
        correlated columns (same trap as `dashboard-reads.ts`).
      - `source='inbound'` rows are never swept: the message is their reference.
      - Blob first, row second, and only for keys whose blob actually went away.
        A crash between them leaves a row whose blob is gone → next pass
        reclaims it idempotently. Reverse order would leak the object.
      - ALSO fixed a pre-existing R2 leak: the retention sweep's ticket deletion
        cascaded `ticket_attachments` away without deleting the objects. It now
        captures storage keys INSIDE the tx and deletes blobs after commit
        (best-effort; a failed delete logs and leaks, never rolls back).
      - `BlobStorage` grew an idempotent `delete` (R2 `DeleteObjectCommand`;
        NoSuchKey → success). Any new `BlobStorage.of({...})` must implement it.
      - 0041 backfills `used_at = created_at` on existing rows: we can't tell
        after the fact which were sent, and over-retaining beats deleting a blob
        a live reply references.
- [x] Supplier portal shows the files the supplier sent (2026-07-09, `0f1069b`).
      `ticket_attachments.escalation_id` (migration 0040, nullable — merchant
      and inbound rows carry none) is stamped at supplier-upload time;
      `getEscalationForSupplier` projects that escalation's own files and the
      supplier's chat bubble renders them (metadata only, storage keys stay
      server-side). `supplierChatMessages` only attaches them to the RESOLVED
      outbound bubble, so an upload staged against an abandoned draft never
      reads as an answer.
      - SECURITY tightening in the same slice: `recordSupplierUpdate` used to
        accept any `source='supplier'` id on the ticket, so a SECOND escalation
        could re-send the first one's files. Validation is now escalation-scoped.
      - Pre-existing supplier rows keep a null `escalation_id` (they predate the
        binding) and stay reachable via the ticket-context stamp their update
        wrote; they will not appear in the portal's per-escalation view.
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

- [ ] New built-in scenarios don't reach tenants with a STORED resolution
      policy until their next scenarios-page save (`decodeResolutionPolicy`
      read path returns stored scenarios verbatim; only the write-path
      normalizer re-seeds built-ins). Affected `shipping_address_update`
      (2026-07-08) exactly as it did `order_cancellation`. Consider merging
      missing built-ins on read.
- [ ] Same stored-policy gap applies to CHANGED built-in defaults: the
      2026-07-08 `delivery_issue` reassure-reply note (`39ab74e`) needs a
      policy re-save (or the merge-on-read above) to reach existing tenants —
      for live tenants, edit /settings/resolution-policy directly. (The
      `where_is_order` supplierMode flip from `39ab74e` was superseded by the
      general re-classification rule `d8b1ddc` and reverted.) The 2026-07-11
      partial-refund note updates for `refund_request`, `damaged_product`, and
      `wrong_item` have the same stored-policy caveat.
- [ ] If `supplier.escalate` is ever set to `auto`, the tool description
      ("must NOT send a customer reply" after escalated:true) suppresses the
      reassuring holding reply — reword the description before flipping any
      tenant to auto-escalation.
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
- Only `vitest.global-teardown.ts` may call `purgeLeakedTenants` by keep-list
  alone. Tests share one dev database and run in parallel, so any purge issued
  *during* the run must pass `onlyTenantIds` to bound it to rows that test
  seeded.
- `pnpm build` must be green before stopping.

---

## Working Agreement

1. Read this file first at the start of every session.
2. Consult `master-plan.md` when architectural context is needed; it is not
   required reading for every session.
3. Keep this checklist focused on features, pending implementation work,
   architecture decisions, and invariants.
4. Verify before ticking a checkbox.
5. Add discovered implementation follow-ups here instead of silently widening
   scope.
6. Record any master-plan deviation here and in memory.
7. Do not end with a broken `pnpm build`.
