# Shopify Protected Customer Data — submission record

Verbatim record of what was submitted to the Shopify Partner Dashboard for the `support-agent` app's Protected Customer Data (PCD) access request. The Partner Dashboard is the system of record; this file is a diffable mirror so we can recover the exact form text when Shopify re-prompts for attestation.

- App: `support-agent` (`SHOPIFY_APP_CLIENT_ID=7d37faff…`)
- Dev store used to verify: `support-agent-test.myshopify.com`
- First submission: **2026-05-16** (pending update with actual submission date)

---

## Distribution method decides whether ANY of this is review-gated

The 15-question attestation below was filed for the **single global app under Public distribution** (the SaaS variant). It is **review-gated** only because of Public distribution — not because of the scopes.

The **pilot** path is different (see `master-plan.md` §19.6 and [[project_pilot_shopify_app_provisioning]]): each tenant gets its own operator-provisioned **Custom-distribution** app, one app per store. For Custom-distribution apps, protected customer data is **"always available" at both Level 1 and Level 2 — no review, no attestation submission.** `read_orders` / `read_customers` will not put a pilot app in any approval queue. So for the pilot, treat the attestation submission below as **reference, not a blocker.**

Two things still apply to every Custom-distribution pilot app, even with no review:

1. **You must DECLARE the PCD fields per app** in its Dev Dashboard (Apps → API access → Protected customer data) — select name + email + address (the fields justified in §2; not phone). "Always available" removes the *review*, not the *declaration*. Shopify's docs are silent on whether live-store PII flows with zero declaration, and the Dec-2025 enforcement trend is to **redact/null** PII for unconfigured apps — so if a connected store returns orders with blank customer name/email/`shippingAddress`, the declaration is missing. This breaks `shopify.get_order` silently (blanked fields, not an error), degrading where-is-order / missing-package flows.
2. **The data-protection obligations still bind** (§3, all 15) under the Partner Program Agreement — self-attested, not reviewed, but legally binding. Nothing about Custom distribution relaxes them.

### Per-app provisioning checklist (Custom distribution / pilot)

When provisioning a new tenant's Shopify app (operator step, alongside entering `client_id` + `client_secret` into the admin endpoint):

- [ ] In the Dev Dashboard, set the app's **distribution = Custom** (not Public / not unlisted).
- [ ] Apps → API access → **Protected customer data**: declare the fields — name, email, address (not phone).
- [ ] After the merchant connects, **verify on the live store** that customer PII isn't being redacted. The operator console automates this: open the tenant in `apps/admin` and click **"Run PCD check"** (`POST /admin/tenants/:id/shopify-app/pcd-check`). It reads a few recent orders and reports `present` (PII flowing), `redacted` (declare the PCD fields, then re-run), `no_orders` (re-run after the first order), or `not_connected` (connect first). The check returns **presence booleans only** — no customer PII is read into admin logs.
- [ ] Confirm compliance webhooks (`customers/data_request`, `customers/redact`, `shop/redact`) are registered for the app (they ship in `shopify.app.toml`).

---

## Section 1 — Protected customer data (top toggle)

**Toggled:** ON.

**Use case (overall):**

> support-agent is an AI-powered customer support runtime for Shopify merchants. When a customer messages the merchant's support inbox, the agent reads the relevant order and customer profile to answer where-is-my-order, missing-package, damaged-product, and refund inquiries. Order and customer data are read on demand per inbound support ticket and are never aggregated, sold, or repurposed outside support workflows.

---

## Section 2 — Per-field justifications

### Customer name — **enabled**

> Personalised greeting in support replies. The agent addresses the customer by their first name in the message body to match how a human support agent would respond.

### Customer email — **enabled**

> Match inbound customer messages to their Shopify account so the agent can locate their order history, and thread the reply back to the same email address. Without email access, the agent cannot identify which Shopify customer a given inbound message belongs to.

### Customer address — **enabled**

> Verify shipping address against customer claims for `missing_package` and `where_is_order` workflows; surface delivery context (city, region) in tracking-status replies. The existing `shopify.get_order` output schema already includes `shippingAddress`; partial-null fields would degrade the answer quality. The upcoming `missing-package-agent` is architecturally built around comparing ship-to vs customer-stated address.

### Customer phone — **NOT enabled**

> No current or imminent workflow uses customer phone. Will be re-requested if/when an SMS-based notification workflow is added.

---

## Section 3 — Data protection attestation

For each question Shopify asks, we record the form answer and link to supporting code or operational reality.

### 1. Do you tell merchants the personal data you process and your purposes for processing it?

**Answer:** Yes.

We maintain a data processing notice listing the categories of personal data we access (customer name, email, address, support-message content, order/fulfillment data, shipping address fields when needed for support, and customer-provided image attachments) and the purposes (support triage, order-status replies, missing-package verification, damaged-product review, approval preparation, tool execution, and audit). The notice is published by the API at `/legal/data-processing` and linked from dashboard onboarding plus the Legal settings page.

**Status:** Implemented 2026-06-04. The current notice version is stored in tenant settings when accepted.

### 2. Do you limit your use of personal data to that purpose?

**Answer:** Yes.

Customer data is read only by support agents acting on a specific customer's ticket. The architecture enforces this through narrow tool definitions (`packages/tools/src/shopify/*`) and a permission gate (`packages/agent-core/src/permission-service.ts`) consulted before every tool call. We do not aggregate, resell, or repurpose data outside support workflows.

OpenRouter is disclosed as a subprocessor for LLM inference — customer data appears in prompts sent to the configured model.

### 3. Do you have privacy and data protection agreements with your merchants?

**Answer:** Yes.

A lightweight Data Processing Addendum is served with the data processing notice at `/legal/data-processing`. Dashboard onboarding requires acceptance before tenant creation, and existing tenants can accept current versions from Settings -> Legal. The API blocks production connector credential writes until the tenant has accepted the current notice/DPA versions.

**Status:** Implemented 2026-06-04. Acceptance is persisted in `tenants.settings.legalAcceptance`.

### 4. Do you respect and apply customers' consent decisions?

**Answer:** Yes.

We only process customer data in response to that customer's inbound support request. We do not initiate outbound communication using stored customer data. If a future workflow proactively contacts customers (e.g. SMS delivery notifications), explicit consent gating will be added before it ships.

### 5. Do you respect customers' decisions to opt out of having their data sold?

**Answer:** Yes.

We do not sell customer data. We do not share customer data with third parties other than disclosed subprocessors (currently: OpenRouter for LLM inference) operating under contract.

### 6. Automated decision-making with significant effects — can customers opt out?

**Answer:** Yes.

Every AI decision with monetary, account-modification, or external-communication effect requires merchant human approval before execution. The runtime enforces this via:
- `Permission` enum (`allow` / `ask` / `deny`) on every tool — `packages/agent-core/src/agent.ts`
- `PermissionService` consulted before every tool call — `packages/agent-core/src/permission-service.ts`
- `ApprovalService` writes a pending approval row to the database; the merchant decides via the dashboard before execution — `packages/services/src/approval-service.ts`, `packages/db/src/approval-service-live.ts`
- A ticket in `waiting_for_approval` state cannot advance without a human decision

Customers can request human-only handling at any time, transitioning their ticket to `human_takeover` (state transition enforced by `TicketRepository.transitionStatus`).

### 7. Retention periods that ensure personal data isn't kept longer than needed?

**Answer:** Yes (target).

Resolved tickets are archived after 30 days. Archived tickets are retained for 12 months, then deleted by a daily sweep cron together with their `ticket_state_transitions` rows, approval rows, and `audit_log` entries.

**Status:** Implemented 2026-05-25 via the worker retention sweep cron.

### 8. Encrypt data at rest and in transit?

**Answer:** Yes.

- **In transit:** TLS 1.2+ for all API traffic. The API edge enforces HTTPS-only callback URLs (`apps/api/src/bootstrap.ts`, `loadApiConfig` rejects non-https unless `NODE_ENV=test`). Cloudflare Tunnel terminates TLS in front of the API server. Postgres client connections use `sslmode=require` in production.
- **At rest, application layer:** Connector access tokens are encrypted with AES-256-GCM before storage (`packages/services/src/crypto.ts`, `packages/db/src/connector-credential-store-live.ts`). The ciphertext-does-not-contain-plaintext invariant is asserted by integration test (`packages/db/test/connector-credential-store-live.integration.test.ts`).
- **At rest, database layer:** Production Postgres runs on a managed provider with disk-level AES-256 encryption enabled by default.

### 9. Encrypt data backups?

**Answer:** Yes.

Production backups are managed by the Postgres provider (managed service) with encryption-at-rest enabled by default. No application-level backups are taken outside the provider's snapshot system.

### 10. Separate test and production data?

**Answer:** Yes.

Test and production environments use distinct databases, distinct API credentials (`OPENROUTER_API_KEY`, `SHOPIFY_APP_CLIENT_SECRET`, `CREDENTIAL_ENCRYPTION_KEY`), distinct hosting, and distinct access controls. No customer data flows from production into the test environment. CI tests run against an ephemeral Postgres schema (verified: `apps/worker/test/queue.integration.test.ts` uses a separate `pgboss_test` schema).

### 11. Data loss prevention strategy?

**Answer:** Yes.

- Customer data never leaves the per-tenant Postgres database except (a) for the merchant-authorised LLM provider's inference call (disclosed subprocessor) and (b) in support replies sent through the merchant's own messaging connector to the originating customer.
- Real `.env*` files are gitignored; only app/package/deploy-local
  `.env.example` templates are committed (no secrets in source control).
- Every runtime access to customer data is recorded in an immutable `audit_log` table (`packages/db/src/audit-log-live.ts`).
- Audit-log PII redaction is implemented and enabled with `AUDIT_LOG_REDACT_PII=1`. OTel trace-side redaction remains a separate hardening follow-up.

### 12. Limit staff access to customers' personal data?

**Answer:** Yes.

Production database access is limited to named operators authenticated via password + MFA. Application-level ticket access through the merchant dashboard (Phase 3) will be scoped to the merchant's own tickets. All access (machine and human) is recorded in `audit_log`.

### 13. Strong password requirements for staff?

**Answer:** Yes.

Staff accounts require strong passwords (NIST 800-63B aligned: minimum 12 characters, MFA required, no reuse) for all production-access systems.

### 14. Log access to personal data?

**Answer:** Yes.

Every runtime access to customer data is recorded in the `audit_log` table with actor type (`agent` / `user` / `system` / `customer`), actor id, action, ticket, and timestamp. Schema: `packages/db/src/schema.ts` (`auditLog`); writes share a transaction with the originating ticket state change (Effect FiberRef + `TransactionRunner`, see `packages/db/src/db-client.ts`). Once the merchant dashboard ships (Phase 3), all human reads of customer data will also be audit-logged.

### 15. Security incident response policy?

**Answer:** Yes.

We maintain an incident response policy covering:
- **Detection** — audit log monitoring + observability alerts
- **Containment** — token revocation via the existing `app/uninstalled` path (`POST /webhooks/shopify/app/uninstalled` → `ConnectorCredentialStore.revoke`) and manual revocation
- **Notification** — affected merchants within 24 hours; affected end-customers via the merchant within 72 hours per GDPR Article 33
- **Forensics** — full audit log review, root cause analysis
- **Remediation** — patching + rotation of any compromised credentials

The policy will be formalized as a written runbook before the first production merchant onboards (`todo.md` Phase 8).

---

## Real production gaps

The original three code gaps from this record are now closed:

1. **Privacy / data processing notice** — implemented at `/legal/data-processing` and linked from onboarding / Settings -> Legal.
2. **Data Processing Agreement (DPA) template + acceptance** — implemented in the same public legal document; acceptance is stored in `tenants.settings.legalAcceptance` and connector writes are blocked until current versions are accepted.
3. **Retention sweep cron** — implemented in the worker and runs daily: resolved tickets archive after 30 days, and archived tickets delete after 12 months.

Operational production readiness still depends on deployment evidence (TLS, encrypted backups, access control, incident response, and real provider configuration), which is tracked separately in `todo.md`.

---

## Re-attestation playbook

(Applies to the **Public-distribution** global app only. Custom-distribution pilot apps are never asked to re-attest — they only need the per-app field declaration in the checklist above.)

When Shopify asks for re-attestation:

1. Open this file (`docs/shopify-pcd.md`) — the source of truth for what was previously submitted.
2. Walk the 15 questions against current reality. If anything changed (new subprocessor, new field family, dropped a security control), update the answer here first.
3. Open Partner Dashboard → support-agent → API access → Protected customer data → Edit. Paste updated text verbatim from this file.
4. Commit any changes to this file in the same PR as the form submission.
