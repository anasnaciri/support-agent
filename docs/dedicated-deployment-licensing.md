# Dedicated Deployment and Perpetual Licensing

Status: proposed product, architecture, and contract direction  
Last updated: 2026-07-15

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
capabilities such as public self-service signup, platform-wide tenant admin,
SaaS billing, and unlicensed workspace creation. Workspace switching remains
available for editions with more than one workspace.

### 5.1 Indicative infrastructure cost

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

- First-workspace onboarding.
- Additional workspace creation.
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

## 16. Delivery and operational package

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

## 17. Implementation sequence

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
10. Create the install, backup, restore, upgrade, and rollback bundle.
11. Test 1, 5, unlimited, invalid-signature, concurrent-create, restore, and
    version-upgrade cases.
12. Pilot the complete install and recovery flow in a disposable
    customer-shaped environment before delivering it.

All implementation work remains subject to existing repository invariants:
`PermissionService` before every tool execution, transactional audit/state
writes, state-machine guarded transitions, package-layer separation, TDD, and
a green `pnpm build`.

## 18. Reference material

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
