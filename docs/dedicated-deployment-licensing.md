# Dedicated Deployment and Perpetual Licensing

Status: proposed product, architecture, and contract direction  
Last updated: 2026-07-19

> This document records product and engineering intent. It is not legal advice
> or a substitute for a software-licensing lawyer reviewing the final agreement
> under the chosen governing law and every market in which the product is sold.

## 1. Executive decision

Support Agent will remain one product in one repository. It may be delivered in
several runtime/deployment variants:

- Shared multi-tenant SaaS.
- Dedicated deployment hosted in infrastructure controlled by the Licensor.
- Dedicated self-hosted deployment in infrastructure owned and paid for by the
  customer.
- A later split deployment in which a thin connector runs in the customer's
  environment while the proprietary agent runtime remains hosted by the
  Licensor.
- A separately licensed MSP/reseller edition if a customer is permitted to
  serve unrelated third parties.

The initial self-hosted B2B offer should be a **perpetual self-hosted license**,
not a promise of lifetime hosting, support, updates, or third-party
compatibility. A perpetual license gives the customer a non-expiring right to
run the purchased major version within the purchased entitlements. The
customer pays for and owns its infrastructure and provider accounts.

The standard dedicated editions are expected to be:

| Edition | Workspace entitlement | Intended use |
| --- | ---: | --- |
| Dedicated 1 | 1 | One internal store/support operation |
| Dedicated 5 | 5 | Several internal brands or stores |
| Dedicated Unlimited | Unlimited | Internal operations of the licensee and controlled affiliates |
| MSP/Reseller | Contract-specific | Serving unrelated third-party businesses |

Every standard dedicated deployment contains exactly one customer account (the
licensee's organization). That account may contain one or more workspaces, up
to the purchased workspace entitlement. It is not a private SaaS instance in
which visitors can register additional customer accounts. The initial account
and owner are provisioned as part of installation; every other user, including
fulfillment partners, joins only through an invitation from an authorized
member.

The customer license is non-exclusive. The Licensor keeps all ownership and
may continue developing, hosting, selling, and licensing the product, including
offering it as SaaS later.

## 2. The unavoidable trust trade-off

It is not possible to guarantee all three of these properties:

1. The customer controls the server.
2. The software keeps working without depending on the Licensor.
3. The customer cannot inspect or copy the implementation.

A server owner with root access can save a Docker/OCI image, inspect its
layers, enter a running container, copy its filesystem, and modify its runtime.
Private registries, minification, JavaScript compilation, native binaries,
WebAssembly, and obfuscation only increase the effort required. They do not
make implementation confidentiality enforceable against the machine owner.

Therefore:

- Dedicated hosting in Licensor-controlled infrastructure provides the best
  technical code protection.
- Customer-controlled self-hosting provides the strongest continuity and data
  residency, but implementation protection becomes primarily contractual.
- If both customer-local credentials and proprietary code protection are hard
  requirements, use a split deployment with a narrow remote interface.
- A fully offline/on-premises edition must be priced and licensed on the
  assumption that a motivated customer can inspect the shipped implementation.

## 3. One repository, never one repository per customer

Do not create customer repositories or permanent customer branches. They do
not prevent image inspection and cause:

- Divergent security fixes and database migrations.
- Customer-specific behavior that the common test suite no longer covers.
- Unclear deployed versions and slow incident response.
- Repeated release, compliance, and support work.
- Increasingly expensive upgrades and eventual abandonment of old forks.

Use one source tree, one test suite, one schema lineage, one image/version line,
and per-customer deployment manifests and secrets. Differences belong in a
single deployment profile/capability seam, runtime configuration, selectable
adapters, or files under `deploy/`.

Retain the tenant row, `tenantId` columns, tenant-scoped queries, audit rules,
state-machine guards, and permission checks in dedicated deployments. A
dedicated installation has a licensed number of workspaces; it is not a
tenancy-free fork. Tenant scoping remains valuable defense in depth and keeps
the same artifact usable for SaaS and dedicated modes.

## 4. Recommended commercial structure

The product should be sold as separate obligations:

- One-time perpetual object-code license for a named major version and edition.
- Installation and onboarding fee.
- A bounded initial support and update period, such as twelve months.
- Optional annual maintenance after the included period.
- Separately priced custom development.
- Paid future major versions when the customer has no active maintenance.
- Customer-paid infrastructure, inference, email, storage, identity, tracking,
  and other third-party costs.
- An optional managed-upgrade or support package.

When maintenance ends, the licensed installation continues to run. Ending
maintenance means no ongoing promise of support, security patches, provider
compatibility work, or new major versions.

Use the phrase **perpetual right to run the licensed version**, not **lifetime
functionality**. Shopify API versions, LLM models, Gmail/Microsoft OAuth,
operating systems, domains, certificates, and other external services may
change or disappear. The agreement must not promise permanent compatibility
with third parties.

## 5. Dedicated deployment ownership

The preferred self-hosted installation runs in a cloud account or server owned
and paid for by the customer:

```text
Customer-owned infrastructure
├── API
├── Worker
├── Dashboard
├── Postgres and pg-boss
├── Object storage
├── Reverse proxy/TLS
├── Monitoring
└── Backups
```

Each deployment should have its own:

- Database and queue tables.
- Object-storage bucket or namespace.
- Encryption and signing keys.
- Public domains, OAuth callbacks, and webhook URLs.
- Backups, retention policy, and restore drill.
- Logs, traces, metrics, and alerts.
- Release version and migration status.
- Customer-owned third-party accounts wherever independence is required.

Dedicated mode should use a single deployment profile to disable or alter
capabilities such as public self-service signup, account/organization creation,
platform-wide tenant admin, SaaS billing, and unlicensed workspace creation.
Workspace switching remains available for editions with more than one
workspace.

### 5.1 Account, identity, and invitation model

A standard dedicated deployment has one customer account representing the
named licensee. Installation or an authorized operator provisions that account,
its initial owner, and its first workspace. There is no public registration or
self-service account-creation path. Sign-in may remain publicly reachable, but
an identity may gain application access only by accepting a valid invitation
or through the documented break-glass administrator path.

The customer account may contain as many workspaces as its signed entitlement
allows. Authorized account members may create additional workspaces through the
single entitlement-enforced creation seam; doing so does not create another
customer account. The application must reject attempts to create a second
account or organization regardless of whether they come from the dashboard, an
API call, an identity-provider callback, an import, or an administrative tool.

All people after the initial owner are invite-only:

- Workspace members are invited to explicit workspaces and receive only their
  assigned roles.
- Fulfillment partners are invited to the fulfillment-partner experience and
  only the workspaces, tickets, and operations assigned to them; an invitation
  must not grant general merchant-dashboard access.
- An invitation is scoped, expiring, auditable, and revocable. Accepting it may
  create or link the person's login identity, but never creates another
  customer account or bypasses the licensed workspace limit.
- Membership and partner access remain server-enforced. Hiding registration or
  workspace controls in the dashboard is not sufficient.

The MSP/reseller edition may define a different account model by contract and
deployment profile. That exception must be explicit; it is not enabled merely
by purchasing an unlimited workspace entitlement.

### 5.2 Indicative infrastructure cost

Excluding LLM inference and all connector/provider charges, the current
single-host Compose topology (API, worker, Postgres/pg-boss, and Caddy) should
start at 2 shared vCPUs and 4 GB RAM. Four vCPUs and 8 GB RAM provide a safer
floor for several active workspaces. Actual sizing follows ticket volume,
concurrent agent ticks, mailbox polling, attachment volume, retention, and
availability requirements—not the licensed workspace count alone.

As of 2026-07-15, indicative monthly infrastructure budgets are:

| Shape | Expected monthly infrastructure |
| --- | ---: |
| One low/moderate-volume workspace, single VPS | USD 10–30 |
| Up to five moderate-volume workspaces, single VPS | USD 20–60 |
| Unlimited edition with modest aggregate traffic, larger single VPS | USD 40–120 |
| Redundant production topology with separate/managed DB and recovery capacity | USD 150–500+ |

Examples anchoring the ranges: Hetzner's post-2026-06-15 EU CX23 is USD 6.49
per month before USD 0.60 IPv4, VAT, and backups; provider backups add 20% of
server price. DigitalOcean lists 2 vCPU/4 GiB at USD 24 and 4 vCPU/8 GiB at USD
48. AWS Lightsail lists 2 vCPU/4 GB at USD 24. Cloudflare Workers static
delivery can remain in the free allowance at low traffic, and R2 includes 10
GB-month before USD 0.015/GB-month storage charges. Add domain registration and
an independent database backup destination.

For a customer-owned self-hosted license, these are the customer's bills, so
the Licensor's direct per-customer hosting cost is approximately zero. Release
infrastructure and support labor remain Licensor costs and must not be confused
with hosting. A cheap single VPS has a single point of failure; it should never
be marketed with high-availability guarantees.

### 5.3 Database and storage capacity model

The app does not mirror a merchant's Shopify order catalog. It stores support
tickets that may reference an order and fetches order data on demand. Capacity
must therefore be sold and monitored in tickets/events per day, not total store
orders. A store may process millions of Shopify orders while producing only a
small number of support tickets.

Current ticket retention is approximately 13 months after resolution: a
resolved ticket remains resolved for 30 days, becomes archived, then is deleted
after 12 months archived. Ticket-linked approvals, audit rows, transitions,
tool-execution rows, reply deliveries, attachment indexes, and attachment blobs
are removed with it. Important exceptions prevent this from being a perfect
hard ceiling today: unresolved/failed/human-takeover tickets are not deleted by
age, and `processed_messages` plus `processed_events` have no time-based sweep.
Tenant-wide audit rows without a ticket and durable knowledge/configuration also
persist. Capacity planning must include margin until those policies are made
explicit.

Until live measurements exist, use these conservative planning assumptions:

- 100 KB of Postgres per retained ticket, including indexes and ordinary
  audit/tool/state history. A reasonable sensitivity range is 50–150 KB.
- 0.5 MB of object storage per ticket averaged over all tickets. This assumes
  most tickets have no file and a minority have compressed photos. Recalculate
  for merchants with image-heavy damage/returns workflows.
- 395 days of steady-state retained resolved-ticket volume.
- Keep Postgres below 70% of its volume and reserve additional space for WAL,
  vacuum, temporary files, migrations/index builds, container images, and the
  operating system.

Formulas:

```text
retained tickets ≈ tickets/day × 395
Postgres GiB ≈ retained tickets × average DB KB / 1,048,576
object GiB ≈ retained tickets × average attachment MB / 1,024
```

At 100 KB DB and 0.5 MB blobs per ticket:

| Sustained tickets/day | Retained tickets | Live Postgres estimate | Object estimate | Suggested total server disk |
| ---: | ---: | ---: | ---: | ---: |
| 100 | 39,500 | 3.8 GiB | 19 GiB | 50–80 GB |
| 500 | 197,500 | 18.8 GiB | 96 GiB | 80–120 GB |
| 1,000 | 395,000 | 37.7 GiB | 193 GiB | 150–250 GB |
| 5,000 | 1,975,000 | 188 GiB | 965 GiB | 500 GB–1 TB, separate DB volume |

Object bytes should remain in R2/S3-compatible storage, not the Postgres/VM
disk. R2's current standard price makes 100 GB roughly USD 1.35/month after the
10 GB free allowance and 1 TB roughly USD 14.85/month before operation charges.
Object storage grows elastically; set billing alerts rather than preallocating
it. The code caps a Gmail message at eight images, 10 MiB each, and 25 MiB
cumulative, while dashboard/portal uploads cap each file at 10 MiB and each
reply/update at eight files. These safety caps are not average-size assumptions.

A self-managed Postgres instance on the same VPS has no separate license or
database-service charge; it consumes the VPS's included CPU, RAM, and disk.
Additional block storage is commonly about USD 0.10/GiB-month on DigitalOcean
and Lightsail, so 100 GiB costs about USD 10/month and 500 GiB about USD
50/month there. Provider/server snapshots and an independent database backup
destination are additional. Never count a backup on the same disk/server as a
recoverable backup; budget roughly another 1–2× the live database size for
compressed backups/PITR history, depending on frequency and retention.

For an 80 GB all-in-one server, reserve roughly 20–25 GB for the OS, images,
WAL/temp operations, and safety margin. A steady 500 tickets/day at the planning
average should reach a roughly 19 GiB ticket-data equilibrium after the
retention window and fit without a storage scale. At 1,000/day, it approaches
38 GiB and should move to a larger/separate database volume before the first
year. At 5,000/day, compute and queue throughput will generally require scaling
well before the retention plateau.

The default worker runs four tickets concurrently and gives each tick a
three-minute hard timeout. If a normal tick averages 60–90 seconds, the
mathematical ceiling is roughly 3,800–5,700 ticks/day at continuous saturation;
production should not run at that ceiling. Use roughly 1,000–2,000 new
single-tick tickets/day as the conservative starting capacity of one small
worker, then measure. Tickets with multiple customer replies generate multiple
ticks. Scale worker concurrency/nodes based on queue latency rather than
licensed workspace count.

Scale before any of these conditions persist:

- Postgres volume exceeds 70% or projected 90-day growth crosses that point.
- CPU exceeds about 70% for sustained periods or memory begins swapping/OOMing.
- Workflow queue age/backlog grows during normal traffic; target a p95 new-job
  wait below one minute unless the product defines a different SLA.
- Postgres connections exceed roughly 70% of the configured pool/limit.
- Autovacuum cannot keep up, dead tuples grow, or indexed dashboard queries
  regress materially.
- Retention/attachment sweeps cannot finish comfortably inside a day.

Before quoting contractual volume, run a load test against a customer-shaped
database and publish measured limits for the exact server profile. After the
first 30–60 production days, calculate real bytes per ticket using
`pg_total_relation_size`, real attachment bytes per ticket, tick latency, queue
age, and unresolved-ticket growth, then replace these assumptions.

## 6. Configuration classification

Moving all workspace state to environment variables would be a mistake. Use
three categories.

### 6.1 Deployment-wide environment and secrets

Suitable for environment variables or the customer's secret manager:

- Deployment mode and license-file location.
- Database connection.
- API/dashboard domains and callback URLs.
- WorkOS or customer identity-provider application credentials.
- Shopify application client ID/secret when one app serves the deployment.
- Google and Microsoft OAuth application credentials.
- Deployment-level LLM provider credential when that policy is selected.
- Object-storage, platform-mail, Telegram-bot, and tracking-provider
  credentials.
- Credential-encryption, state-signing, approval-signing, and session keys.
- Observability endpoints.
- Backup destination.
- Process concurrency, timeouts, and deploy-wide capability flags.

### 6.2 Workspace product state in Postgres

Keep these editable and durable without a redeploy:

- Agent/model choices and tenant instructions.
- Brand voice and store facts.
- Refund, return, shipping, discount, cancellation, and resolution policies.
- Scenarios, playbooks, custom agents, and action permissions.
- Knowledge documents.
- Roles, members, invitations, and fulfillment-operator assignments.
- Notification preferences and onboarding state.
- Retention choices and operational settings.

### 6.3 Encrypted workspace connector records

Keep lifecycle-managed tokens and connection metadata as encrypted database
records:

- Shopify offline access tokens.
- Gmail/Outlook access and refresh tokens.
- IMAP/SMTP mailbox credentials.
- Workspace LLM keys, but only where the edition permits them.
- Telegram connection metadata.
- OAuth scopes, revocation state, health, cursors, subscriptions, and expiry.

Environment variables are poor replacements for token rotation, revocation,
reconnect history, transactional updates, and health reporting.

## 7. Offline license entitlement

Already licensed software must not require the Licensor's server to remain
online. There should be no remote kill switch. Use an offline signed license
document. Keep the signing private key offline or in tightly controlled signing
infrastructure and ship only the public verification key in the application.

An illustrative entitlement is:

```json
{
  "licenseId": "lic_acme_001",
  "licensee": "Acme Ltd",
  "edition": "dedicated-5",
  "majorVersion": 1,
  "maxWorkspaces": 5,
  "productionInstances": 1,
  "standbyInstances": 1,
  "permittedUse": "internal_business",
  "workspaceLlmCredentials": false,
  "expiresAt": null
}
```

`maxWorkspaces: null` may represent unlimited. The license should also identify
the named legal entity, permitted affiliates, deployment/DR rights, major
version, optional capabilities, and contract/order reference.

Offline signature validation deters ordinary misuse and detects accidental
misconfiguration. It cannot stop a server owner from patching the program, so
deliberate circumvention remains a contract and enforcement issue. Avoid
fragile hardware binding that prevents legitimate disaster recovery. If
installation binding is required, provide an explicit rehost/recovery process.

## 8. Workspace entitlement enforcement

The 1/5/unlimited entitlement must be enforced at the authoritative workspace
creation seam, not through hidden buttons, credential design, or an
untransactional pre-check.

The current list-then-create shape is raceable: two requests can observe four
workspaces and both create another under a five-workspace license. The eventual
implementation must:

1. Verify the signed entitlement.
2. Begin a database transaction.
3. Lock a singleton deployment-entitlement row or take a transaction-scoped
   Postgres advisory lock.
4. Count licensed workspaces.
5. Reject at the limit with a stable `workspace_limit_reached` error.
6. Insert the tenant, seed required roles, and write the audit record in the
   same transaction.

Every path must use that seam:

- Deployment bootstrap of the first workspace.
- Additional workspace creation by an authorized account member or operator.
- Admin/operator provisioning.
- Installation and import tools.
- Future automation.

A UI gate is only a hint. Direct server calls must be rejected. A customer with
root/database-owner access can still modify the installation, which is another
reason technical enforcement supplements rather than replaces contract terms.

## 9. Credential policy is not license enforcement

Credential ownership answers **who pays and who controls the provider
account**. Workspace entitlements answer **how many workspaces may exist**.
License terms answer **whether the customer may serve unrelated third
parties**. These are separate responsibilities.

Sharing an LLM key does not stop redistribution. A customer could pay the LLM
bill itself while charging unrelated merchants. Conversely, tenant-scoped keys
do not inherently grant resale rights.

### 9.1 LLM credential policy

The repository already supports one inherited OpenRouter credential per WorkOS
organization, with a workspace row overriding it. Dedicated editions should
normally select:

```text
llmCredentialMode = deployment_only
```

Under that mode:

- Configure one customer-owned LLM credential for the deployment/account.
- Hide workspace-level LLM connection controls.
- Reject workspace-level LLM credential writes server-side.
- Resolve every workspace through the deployment/account credential.
- Continue attributing usage and audit events to `tenantId`.

An edition may explicitly license `deployment_or_workspace` later.

### 9.2 Credentials that may be deployment-wide

- Shopify app client ID/secret.
- Google/Microsoft OAuth application identity.
- LLM provider API key.
- Telegram bot identity.
- Platform-mail provider account.
- Tracking-provider key.

### 9.3 Credentials that must remain workspace-scoped

- Each Shopify store's access token.
- Each mailbox's access/refresh token or IMAP/SMTP credentials.
- Provider subscription identifiers, webhook cursors, scopes, and health.
- Any secret whose accidental reuse could route one workspace's data or action
  into another.

Never remove tenant isolation from tickets, messages, customers, attachments,
approvals, audit logs, policies, knowledge, agents, tools, connectors, roles,
or fulfillment operations.

## 10. Preventing unauthorized resale

Workspace count alone cannot prevent a customer from operating the product for
others, especially under an unlimited edition. The standard agreement must say
that unlimited means unlimited internal workspaces belonging to the named
licensee and defined controlled affiliates. It does not grant the right to:

- Host or operate the product for unrelated businesses.
- Charge unrelated merchants for access or managed service.
- Resell, redistribute, sublicense, or white-label the product.
- Provide service-bureau functionality.
- Transfer the installation or license without permitted assignment.

Serving unrelated businesses requires a separately priced MSP/reseller edition.
The contract should define `Controlled Affiliate`, internal business use,
authorized contractors, permitted users, transfer/change-of-control treatment,
and any audit rights.

Invited users should not consume workspace licenses unless a later edition uses
seat pricing. Membership must nevertheless be limited to the licensee,
permitted affiliates, and authorized contractors. Email-domain allowlists may
help operationally but cannot replace contract terms because legitimate
companies use subsidiaries, agencies, contractors, and multiple domains.

## 11. Retained ownership and future SaaS rights

The customer receives a license, not ownership of the product or control over
the Licensor's future business model. The agreement should expressly provide
that the grant is:

- Perpetual for the purchased version, subject to termination for material
  breach.
- Non-exclusive.
- Non-transferable except for narrowly defined permitted assignment or written
  consent.
- Non-sublicensable.
- Limited to object-code use, the named licensee, permitted purpose, edition,
  workspace count, deployment count, and major version.

The ownership/reservation language should state that the Licensor retains all
right, title, and interest in the platform, reusable modules, architecture,
documentation, modifications, improvements, and derivative works, and every
right not expressly granted. This must include the unrestricted right to:

- Develop and modify the product.
- Host and operate it.
- Sell and license it to other customers, including the licensee's competitors.
- Offer it as SaaS, subscription, usage-based, managed-service, dedicated, or
  other commercial models.

Avoid accepting exclusive/sole licenses, IP assignments, broad ownership of
all deliverables, rights to future versions, sublicensing, resale rights,
non-competes, competitor restrictions, or clauses that make the customer owner
of generalized improvements.

For commissioned work, distinguish:

- Customer ownership of its data, logos, policies, and supplied materials.
- Licensor ownership of the base platform and reusable/general improvements.
- The customer's licensed right to use commissioned functionality.
- Any genuinely customer-exclusive material, which must be identified narrowly
  in writing.

## 12. Code exposure and production image hardening

The current Railway image copies the repository and intentionally retains
development dependencies. That is unsuitable for delivery to an untrusted
customer-controlled server.

Before self-hosted delivery:

- Use a multi-stage production build.
- Include only runtime output and production dependencies.
- Exclude source TypeScript, tests, fixtures, Git metadata, documentation,
  source maps, build caches, and development tools.
- Never put secrets in image layers or build arguments that persist in image
  history.
- Sign images and distribute immutable versions/digests.
- Produce an SBOM and vulnerability scan.
- Provide checksums and retain a release manifest.
- Use a private registry or deliver a signed OCI archive when the perpetual
  customer must retain an installable copy after maintenance ends.
- Consider bundling/minifying narrow proprietary modules or compiling a
  particularly valuable implementation to native/Wasm only when the extra
  reverse-engineering friction justifies the maintenance cost.

These are disclosure-reduction and supply-chain measures, not guarantees of
secrecy.

## 13. Continuity without the Licensor

If the promise is that the deployment does not stop merely because the
Licensor disappears, eliminate Licensor-owned runtime dependencies wherever
practical:

- Customer-owned Shopify app credentials and store connections.
- Customer-owned LLM account and billing.
- Customer-owned Google/Microsoft OAuth application.
- Customer-owned identity provider, or a documented safe local break-glass
  administrator path.
- Customer-owned domain, DNS, TLS renewal, object storage, mail provider,
  Telegram bot, and tracking provider.
- Customer-held encryption keys and backups.
- An installable image/archive, migrations, and restore documentation.

A deployment that depends on the Licensor's WorkOS, Resend, R2, 17TRACK,
registry, domain, or licensing server is not fully independent. Dedicated mode
needs customer-owned adapters or documented degraded behavior for each such
dependency.

## 14. Merchant responsibility for agent actions

The contract should allocate operational responsibility to the merchant while
preserving the platform's responsibility for its own defined safeguards. Final
language requires counsel, but the intended allocation is below.

### 14.1 Customer control and authorization

The merchant determines:

- Which actions/tools are enabled.
- Which scenarios permit them.
- Whether the action is Deny, Ask, or Automatic.
- Monetary, quantity, time, store, and other deterministic limits.
- Connected accounts, credentials, policies, content, and instructions.
- Which authorized personnel configure and supervise the agent.

By enabling Automatic for an action, the merchant expressly authorizes the
agent to perform that specific action on the merchant's behalf without
case-by-case prior approval, but only within the configured scope and limits.
Do not describe this as unbounded "full authorization".

### 14.2 Ask versus Automatic

- **Ask** means a qualified merchant user reviews and approves the proposed
  action before execution.
- **Automatic** means the merchant knowingly waives prior case-by-case review
  for the configured scope. The merchant remains responsible for configuration
  and for monitoring completed actions afterward.
- **Deny** means the action must not be available or executed.

The agreement and UI must not promise pre-action review for an Automatic
action.

### 14.3 Intended contract topics

Counsel should cover:

- AI outputs, classifications, communications, and proposed actions may be
  incomplete, inaccurate, or inappropriate and are not guaranteed error-free.
- The merchant is responsible for business policies, instructions, connected
  data, authorized actions, customer communications, refunds, discounts,
  cancellations, address changes, fulfillment instructions, and other actions
  performed within its configuration.
- The merchant represents that it has authority to connect every store,
  mailbox, provider account, and credential.
- The merchant must comply with applicable consumer, ecommerce, privacy,
  employment, platform, and other laws and contracts.
- The merchant must appoint competent and authorized people to supervise the
  system, review activity, handle escalations, and disable automation when it
  may cause harm or violate policy/law.
- The product must not be used for unsupported employment, credit, insurance,
  healthcare, legal, safety-critical, or other legally significant decisions.
- Appropriate warranty disclaimers, indemnification, exclusions of indirect
  damages, and an aggregate liability cap apply only to the maximum extent
  permitted by law.
- Third-party compatibility and uptime are not guaranteed forever.

The merchant indemnity may address claims caused by customer instructions,
policies, content, unlawful use, unauthorized connected accounts, authorized
automated business actions, failure to supervise known problems, and
unauthorized resale. Exact scope is jurisdiction-specific.

### 14.4 What must not be shifted to the merchant

The merchant's authorization should not excuse the platform if it:

- Executes an action configured as Ask or Deny.
- Exceeds a configured refund, discount, quantity, scenario, or other limit.
- Bypasses `PermissionService`.
- Leaks one workspace's data or credentials into another.
- Executes a duplicate side effect because idempotency failed.
- Misrepresents an event in the audit record.
- Suffers a defect or security failure for which liability cannot lawfully be
  excluded.

The fair allocation is:

| Merchant responsibility | Platform responsibility |
| --- | --- |
| Business policy and instructions | Enforce configured permissions and limits |
| Connected accounts and authority | Workspace isolation and secret handling |
| Choosing Ask/Automatic/Deny | Permission checks before every tool execution |
| Authorized action scope | State-machine and deterministic policy guards |
| Reviewing activity and escalations | Idempotency and accurate audit records |
| Customer-facing legal obligations | Operate substantially as documented |

A contract allocates responsibility between the parties. It cannot prevent an
end customer, regulator, or platform provider from making a claim or taking
action. An indemnity may allocate resulting costs but does not eliminate
external claims or mandatory duties.

## 15. Versioned Automatic-action consent

General terms acceptance is not enough for consequential automatic actions.
Whenever an authorized user changes an action from Ask/Deny to Automatic, show
an explicit scoped confirmation.

Example:

> **Allow automatic refunds?**
>
> The agent may issue refunds without asking for approval when an enabled
> scenario permits a refund and the amount is within this workspace's EUR 100
> per-order limit. You remain responsible for this authorization and for
> reviewing completed activity. You can disable automatic refunds at any time.

Required acknowledgement:

> I am authorized to enable automatic refunds for this workspace. I understand
> that individual refunds within these settings will not be presented for prior
> approval, and I accept responsibility for actions performed within this
> authorization.

The confirmation must name:

- Exact action/tool and merchant-facing action name.
- Workspace/store.
- Enabled scenarios.
- Monetary, quantity, time, and other deterministic limits.
- Whether a customer communication is also sent automatically.
- Material consequences.
- Escalation destination.
- How to revoke or switch back to Ask.

Only an owner or a member with the exact RBAC permission may grant or change
automatic authorization. Increasing a material limit or expanding scenarios
requires a new acknowledgement.

Persist transactionally with the setting change:

- Workspace and actor identity.
- Actor's relevant authority/role.
- Tool/action identifier.
- Old and new mode.
- Scenarios and limits.
- Terms/consent version.
- Exact acknowledgement presented.
- Timestamp and appropriate request/session evidence.
- Audit entry, without secrets or unnecessary personal data.

Provide:

- Immediate per-action revocation.
- Ask/Deny fallback.
- Searchable activity and audit history.
- Periodic summaries and anomaly alerts.
- Clear display of who enabled Automatic and when.
- Emergency stop for autonomous writes.
- Periodic reconfirmation for high-impact actions where appropriate.

## 16. Fleet operations and lifecycle management

Do not manage a growing fleet by remembering SSH commands and editing each
customer's Compose file. Standardize the installation as a small dedicated
appliance, provision it from source-controlled desired state, and operate the
fleet through a narrow management interface.

Do not start with Kubernetes. The current topology is one API process, one
worker process, Postgres, Caddy, and an externally hosted dashboard. Docker
Compose on a supported Linux image is the lower-complexity first production
target. Move a particular customer to redundant compute or a managed database
when its measured load or recovery objective requires it; do not impose that
cost and operational surface on every installation.

### 16.1 Autonomous data plane and optional control plane

Separate two concerns:

| Plane | Location | Contains | Availability rule |
| --- | --- | --- | --- |
| Customer data plane | Customer-owned infrastructure | API, worker, Postgres, object storage, reverse proxy, connector credentials, LLM credential, business data | Continues processing if the Licensor is unavailable |
| Fleet control plane | Licensor-operated infrastructure | Deployment inventory, desired release, entitlement metadata, operational status, backup/restore evidence, alert routing, maintenance history | Its loss may stop monitoring, support, and updates, but must not stop an already licensed customer workload |

The customer data plane must never need a successful control-plane call to
boot, authenticate its users, process tickets, execute already-authorized
actions, or validate an already-issued offline license. The control plane is a
management convenience, not a remote kill switch.

The control plane should not hold customer connector tokens, database
passwords, LLM keys, message bodies, order data, tool inputs/outputs, or full
application logs by default. Each installation initiates an outbound mutually
authenticated connection and reports only sanitized operational metadata.
Customers who require a fully disconnected installation can use local-only
monitoring and exchange signed release archives and support bundles manually.

### 16.2 Fleet management module

Create one deep `FleetDeployment` module at the operational seam. Its small
interface should hide host, cloud, Compose, telemetry-backend, and backup-tool
differences while providing high leverage and locality for every deployment:

```ts
interface FleetDeployment {
  inspect(): Promise<DeploymentSnapshot>;
  reconcile(desired: DesiredDeploymentState): Promise<ReconcileResult>;
  createSupportBundle(): Promise<SanitizedSupportBundle>;
}
```

`DeploymentSnapshot` should contain only operational facts such as deployment
ID, edition, application/image version and digest, schema version, host shape,
service health, queue depth and oldest-job age, database/storage utilization,
last successful retention sweep, certificate expiry, backup age, and last
successful restore drill. `DesiredDeploymentState` should contain a signed
release digest, configuration version, maintenance window, and explicitly
requested operation. It must not contain secrets.

The initial Adapter can reconcile a Docker Compose host through an idempotent
Ansible playbook. Later cloud-marketplace or Kubernetes adapters are justified
only when a real second installation shape exists. Keep customer-specific
desired state in a private operations repository keyed by opaque deployment
ID, not customer name, and keep secrets in the customer's secret manager or a
root-readable host secret file outside Git.

The lifecycle should be explicit and resumable:

```text
provisioning -> enrolled -> healthy
                         -> maintenance_scheduled
                         -> preflight -> draining -> migrating -> verifying
                         -> healthy | rolled_back | needs_attention
                         -> recovering -> verifying -> healthy | needs_attention
```

Every transition should record the operator/automation identity, old and new
release, timestamps, preflight result, backup identifier, migration result,
verification result, and failure reason. Retrying after interruption must be
safe.

### 16.3 Provisioning and inventory

For the first customers, support one reference platform rather than every
Linux distribution and cloud:

- A pinned Ubuntu LTS release with automatic security updates configured.
- A documented minimum VM, storage class, DNS, firewall, and outbound-port
  profile.
- OpenTofu/Terraform for customer-cloud resources where practical, plus
  idempotent Ansible for the host, Docker, firewall, directories, Compose
  bundle, timers, and monitoring agent.
- A unique opaque deployment ID, offline license, encryption/signing keys,
  backup repository, telemetry identity, and support-access identity per
  customer.
- A preflight that checks CPU architecture, memory, disk and inode headroom,
  supported Postgres/application versions, clock synchronization, DNS/TLS,
  outbound connector reachability, backup-repository write/read, and image
  signature before installation.

The fleet inventory should answer, without SSH: who owns the infrastructure,
where it runs, which edition and major version is licensed, current release and
schema, maintenance eligibility/window, resource shape, last heartbeat, last
backup, last restore drill, open incidents, and who may approve access.

### 16.4 Observability

Add one local OpenTelemetry Collector to the Compose appliance. The application
already exports OTLP traces when `OTEL_EXPORTER_OTLP_ENDPOINT` is set, so the
Collector becomes the stable local endpoint and the Adapter that routes
sanitized telemetry to a customer-owned or Licensor-operated backend. OpenTelemetry
documents both the per-host agent and central gateway patterns; the small
dedicated installation should begin with the simpler local Collector and add a
gateway only when the fleet needs it.

Collect these signals:

| Area | Minimum signals |
| --- | --- |
| Host/containers | CPU, memory, load, disk bytes, inodes, I/O latency, clock skew, restarts, OOM kills, container health |
| Postgres | Reachability, connections/max, database and WAL size/growth, locks, long transactions, slow queries, dead tuples/autovacuum, checkpoint/archive failures |
| pg-boss | Jobs by queue/state, oldest created/active job age, retries, dead letters, stalled jobs, handler duration |
| API | Availability, request rate, latency, 4xx/5xx, webhook failures, provider rate limits, readiness dependencies |
| Worker | Tick count/duration/outcome, timeout/retry/dead-letter rate, schedule last-run/last-success, connector renewal/poll health, retention sweep result |
| Business safety | Tickets parked in failure/human takeover, pending approvals by age, reply-delivery backlog, autonomous-action emergency-stop state |
| Recovery/security | Backup age/result/size, WAL archive lag, restore-drill age/result, certificate expiry, version drift, signature/SBOM/vulnerability status |

The current `/healthz` endpoint is liveness only: it always returns `ok`. Keep
it cheap for process liveness, and add a separate readiness check that tests
the dependencies needed to receive work without causing side effects. A worker
heartbeat/schedule ledger is also required because a running container does
not prove that its consumers and sweeps are progressing.

Use structured logs with deployment ID, process, request/event ID, ticket ID,
queue/job ID, outcome, duration, and error class. Never log credentials,
authorization headers, full messages, attachment contents, or raw tool payloads.
The audit log remains the authoritative business-action record; operational
logs are not a substitute for it. Keep logs locally with bounded rotation by
default. Central log shipping should be opt-in, redacted, retained briefly,
and covered by the customer's data-processing terms. Sample traces and strip
message bodies and secrets before export.

Start with three dashboards: fleet overview, one deployment, and ticket
workflow. Alerts must identify an owner, severity, evidence, and linked
runbook. Initial thresholds should be tuned from production measurements, but
safe starting points are:

- **P1:** public API unavailable for 5 minutes; database unavailable; disk or
  inodes above 90%; evidence of data loss/security breach; queue has stopped
  progressing during active intake.
- **P2:** oldest workflow job above the promised processing SLA; backup older
  than 25 hours; disk above 80%; repeated connector authentication failure;
  dead letters or reply-delivery backlog increasing; certificate expires in
  less than 14 days; last retention sweep older than 36 hours.
- **P3:** disk above 70%; database connections above 70% of limit; restore drill
  overdue; supported-version or security-patch drift; unusual growth trend.

Page a human only for actionable P1/P2 conditions. Send P3 conditions to a
work queue or scheduled maintenance report so alert fatigue does not hide real
incidents.

### 16.5 Backup, restore, and disaster recovery

A server snapshot is useful but is not the database backup strategy, and a
backup is not considered successful until a restore has proved it usable.
Store encrypted backups in a customer-owned off-host object repository with
versioning/immutability where available; never keep the only copy on the
application VPS.

Offer explicit recovery tiers rather than one vague promise:

| Tier | Mechanism | Initial target RPO | Initial target RTO |
| --- | --- | ---: | ---: |
| Basic | Nightly encrypted logical `pg_dump`, daily off-host copy, documented host rebuild | 24 hours | 4–8 hours |
| Production | pgBackRest full/differential backups plus continuous WAL archive to off-host storage, point-in-time recovery | 5–15 minutes | 1–2 hours |
| High availability | Production backup plus separate database/compute failure domain and rehearsed failover | Minutes | Under 30 minutes |

These are engineering targets, not contractual guarantees, until measured in
repeated customer-shaped drills. `pg_dump` is useful for portable logical
recovery, but PostgreSQL documents that point-in-time recovery requires a base
backup plus a continuous WAL archive. pgBackRest supplies backup retention and
WAL archival mechanics; configure and monitor them rather than writing a
bespoke database backup system.

Back up and test all durable dependencies:

- Postgres data, roles/schema, and migration/version metadata.
- Object attachments and the keys/metadata that reference them, with a
  documented reconciliation check after restore.
- Offline license, deployment manifest, Compose/Collector configuration, DNS
  and provider callback inventory.
- Encryption/signing keys through a separate, access-controlled recovery
  procedure. A database backup without the credential-encryption key may be
  operationally unusable; placing the key only inside that backup defeats its
  protection.

Run daily automated backup verification, a weekly disposable restore smoke
test where affordable, and at minimum a quarterly full recovery drill. The
restore must boot the target application version, run schema/integrity checks,
verify representative ticket/audit/attachment records, confirm queue state,
and record actual RPO/RTO. Keep documented runbooks for process restart, host
rebuild, disk exhaustion, database point-in-time recovery, corrupted release
or migration, lost credentials, provider reconnection, and regional loss.

### 16.6 Safe releases, upgrades, and rollback

Ship immutable versioned images by digest, sign them, publish an SBOM and
release manifest, and verify the signature on the customer host before use.
Sigstore Cosign verifies the image signature and that the signed digest matches
the artifact. Never deploy mutable `latest` tags and never let a generic
auto-updater pull unreviewed releases.

Promote releases through internal/staging, one canary customer, then small
cohorts. Respect each customer's maintenance window. An upgrade run should:

1. Verify entitlement, target digest/signature, version compatibility, free
   disk, database health, queue state, and provider health.
2. Complete and verify a recovery point.
3. Stop intake or put the deployment in maintenance mode; drain the workflow
   consumer to a documented limit.
4. Run the migration exactly once.
5. Start the new API/worker, run readiness and representative smoke checks,
   then reopen intake.
6. Observe an elevated-monitoring window and record the outcome.

An old application image can be rolled back only when it remains compatible
with the migrated schema. Use expand/migrate/contract migrations: add backward-
compatible schema first, move code/data, and remove old schema in a later
release after the rollback window. A destructive migration must not ship in
the same release that first stops reading the old shape. If a migration cannot
be reversed safely, recovery means restoring the pre-upgrade database and
object snapshot together, not merely changing the image tag.

Maintain LTS support rules: which major versions receive security fixes, how
long maintenance lasts, the minimum upgrade path, and what happens when a
perpetual customer declines maintenance. The customer keeps its licensed
version; monitoring, support, patches, and upgrades can be separate recurring
services.

### 16.7 Scaling this application

Scale from evidence in this order:

1. Increase disk before it reaches the warning threshold and resize the single
   VPS vertically for CPU/memory pressure.
2. Raise `WORKFLOW_CONSUMER_CONCURRENCY` from its current default of 4 in small
   steps while watching database connections, queue age, LLM/provider limits,
   memory, and duplicate/retry behavior.
3. Move Postgres and object storage off the application host when I/O,
   availability, or recovery objectives justify the extra cost.
4. Replicate the stateless API behind a load balancer when request/webhook
   traffic, not worker processing, is the bottleneck.
5. Split `apps/worker` into a horizontally scalable workflow-consumer role and
   one singleton scheduler/maintenance role before running several worker
   replicas. Today one process owns the consumer plus IMAP polling, connector
   renewals, retention, timers, notifications, account cleanup, policy import,
   credit checks, and reply retries; the current Fly runbook correctly pins it
   to one instance to avoid duplicate polling/sweeps.
6. Add database replicas or automated failover only for customers buying the
   corresponding availability objective.

Do not autoscale from CPU alone. Queue oldest-age and arrival/completion rates
are the useful worker signals; API latency and concurrency are the useful API
signals. Most dedicated customers should use alert-driven, documented resizing
before adopting automatic scaling. There is no reason to shard a single
customer deployment at the starting volumes estimated in section 5.2.

### 16.8 Access, incidents, and support bundles

Do not leave a shared permanent SSH key or public administrative port on every
customer host. Prefer customer-approved, time-limited access through its VPN or
an outbound support tunnel. Record who requested, approved, opened, and closed
access. Give the customer a local break-glass path that does not depend on the
Licensor. Rotate per-deployment credentials after personnel changes or a
suspected compromise.

Create one command that emits a sanitized support bundle: release/digest and
schema, Compose/service status, resource summary, readiness result, queue
summary, backup/restore status, recent redacted error summaries, and
configuration presence flags. It must exclude secrets, raw environment values,
customer messages, attachments, and tool payloads. The customer should be able
to inspect and explicitly send it without granting host access.

Each alert class needs a runbook with detection, impact, safe diagnostic
commands, mitigation, recovery, verification, rollback, escalation contact,
and evidence to retain. After a material incident, produce a timeline and
corrective actions without copying customer data into the fleet system.

### 16.9 Operating cadence and commercial boundary

Define ownership explicitly:

| Offering | Customer operates | Licensor operates |
| --- | --- | --- |
| Perpetual self-operated | Infrastructure, monitoring, backup, recovery, upgrades | Installer/archive and purchased initial assistance only |
| Annual maintenance | Infrastructure and incident execution unless separately agreed | Release access, security fixes, fleet health/backup alerts, runbook assistance |
| Managed operations | Cloud account and business/provider credentials | Monitoring, patching, upgrades, backup checks, restore drills, incident response within an agreed access/SLA model |

This creates legitimate recurring revenue without making the licensed
application depend on the Licensor to keep running. Do not include perpetual
monitoring, cloud administration, on-call response, compatibility work, or
unlimited upgrades in the one-time license price.

Operational cadence for maintained deployments:

- Daily: automated availability, queue, disk, connector, certificate, backup,
  and security alerts.
- Weekly: backup verification/restore smoke test, capacity trend and failed-job
  review.
- Monthly: supported OS/image patches, dependency vulnerability review,
  version-drift and capacity report.
- Quarterly: full restore/DR drill, support-access and secret-rotation review,
  Auto-action anomaly/permission review.
- Annually: entitlement, contacts, maintenance scope, recovery objectives, data
  location, and end-of-life path review.

For the first 5–10 customers, implement the standard appliance, idempotent
provisioning, telemetry, backup/restore automation, release pipeline, fleet
inventory, and runbooks before building a rich fleet UI. At roughly 10–50
deployments, add outbound enrollment, desired-version reconciliation, cohort
upgrades, and support-bundle intake. Only add more sophisticated orchestration
when repetitive fleet work demonstrates the need.

## 17. Delivery and operational package

The dedicated distribution should eventually contain:

- Production OCI image or signed OCI archive.
- Docker Compose bundle first; cloud-specific Terraform/managed-application
  packaging may follow after the installation shape stabilizes.
- Installer/preflight command.
- Signed offline license file.
- Secret-generation and configuration checklist.
- Database migration command and compatibility matrix.
- Backup, restore, upgrade, rollback, and disaster-recovery runbooks.
- Health/readiness checks and monitoring guidance.
- Versioned release notes, image digest, SBOM, and checksums.
- Clear support boundary and environment diagnostics.

Marketplaces may later simplify procurement and customer-owned-cloud delivery,
but they are not required for the first direct B2B installations.

## 18. Implementation sequence

No behavior in this document is implemented merely by documenting it. A safe
sequence is:

1. Obtain legal review and finalize license/order-form concepts.
2. Define a typed `DeploymentProfile`/entitlement interface and adapters for
   SaaS, dedicated, and tests.
3. Implement offline signature verification and fail-safe boot diagnostics.
4. Make every workspace creation path use one transaction-backed entitlement
   mutation.
5. Add dedicated capability gates to API and dashboard.
6. Add deployment-only LLM credential mode without weakening workspace
   connector/data isolation.
7. Add versioned per-action Automatic consent and audit evidence.
8. Add emergency stop, summaries, and monitoring controls.
9. Build and verify a production-only self-hosted image.
10. Create the install, observability, backup, restore, upgrade, rollback, and
    fleet-inventory bundle described in section 16.
11. Test 1, 5, unlimited, invalid-signature, concurrent-create, blocked public
    registration/account creation, invitation scope/revocation, restore, and
    version-upgrade cases.
12. Pilot the complete install and recovery flow in a disposable
    customer-shaped environment before delivering it.

All implementation work remains subject to existing repository invariants:
`PermissionService` before every tool execution, transactional audit/state
writes, state-machine guarded transitions, package-layer separation, TDD, and
a green `pnpm build`.

## 19. Reference material

- [Docker image save](https://docs.docker.com/reference/cli/docker/image/save/)
  documents that an image and all parent layers can be saved to an archive.
- [Azure Managed Applications overview](https://learn.microsoft.com/en-us/azure/azure-resource-manager/managed-applications/overview)
  describes customer-owned subscriptions with customer-managed,
  publisher-managed, and restricted management arrangements.
- [AWS Marketplace container pricing](https://docs.aws.amazon.com/marketplace/latest/userguide/pricing-container-products.html)
  describes BYOL and upfront container contract models.
- [AWS License Manager self-managed licenses](https://docs.aws.amazon.com/license-manager/latest/userguide/create-license-configuration.html)
  illustrates counted entitlements and hard limits.
- [European Commission IP licensing FAQ](https://intellectual-property-helpdesk.ec.europa.eu/regional-helpdesks/european-ip-helpdesk/europe-frequently-asked-questions_en)
  distinguishes assignments, exclusive licenses, and non-exclusive licenses.
- [U.S. Copyright Office recordation overview](https://www.copyright.gov/recordation/)
  distinguishes copyright ownership transfers from non-exclusive licenses.
- [ICO AI accountability principles](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/artificial-intelligence/explaining-decisions-made-with-artificial-intelligence/part-1-the-basics-of-explaining-ai/the-principles-to-follow/)
  emphasizes organizational responsibility, oversight, evidence, and a capable
  human contact.
- [EU AI Act, Regulation (EU) 2024/1689](https://eur-lex.europa.eu/legal-content/EN/TXT/?qid=1724406211495&uri=CELEX%3A32024R1689)
  provides a risk-proportionate human-oversight model. Ordinary ecommerce
  support is not assumed here to be a high-risk use; applicability requires
  legal analysis of the actual deployment and market.
- [OpenTelemetry Collector deployment patterns](https://opentelemetry.io/docs/collector/deploy/)
  describe local agent and central gateway telemetry topologies.
- [OpenTelemetry Collector management](https://opentelemetry.io/docs/collector/management/)
  covers inventory, configuration, and upgrade concerns for collector fleets.
- [PostgreSQL continuous archiving and PITR](https://www.postgresql.org/docs/17/continuous-archiving.html)
  explains base backups, WAL archiving, and point-in-time recovery.
- [pgBackRest user guide](https://pgbackrest.org/user-guide.html) documents
  backup and archive retention behavior.
- [Sigstore Cosign verification](https://docs.sigstore.dev/cosign/verifying/verify/)
  documents image signature, signer-identity, and digest verification.
- [Ansible playbooks](https://docs.ansible.com/projects/ansible-core/devel/playbook_guide/playbooks_intro.html)
  document repeatable desired-state configuration and idempotent modules.
