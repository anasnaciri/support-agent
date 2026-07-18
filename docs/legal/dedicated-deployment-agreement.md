# Support Agent Dedicated Deployment Software License and Services Agreement

Status: working draft for counsel review
Draft date: 2026-07-18

> This is a negotiated B2B agreement outline, not clickwrap terms. It supports
> both customer-hosted and Licensor-hosted dedicated deployments. The Order
> Form and Deployment Schedule must select one model and complete all
> commercial and operational blanks. Counsel must finalize it under the chosen
> governing law.

This Dedicated Deployment Software License and Services Agreement
("Agreement") is between **[LEGAL ENTITY NAME AND LEGAL FORM]**, trading as
Support Agent ("Licensor"), and **[CUSTOMER LEGAL NAME]** ("Customer"). It is
effective on **[DATE]**.

The Agreement consists of this document, the Order Form, Deployment Schedule,
Support and Maintenance Schedule, DPA, and any signed statement of work. If
they conflict, the following order applies: Order Form; DPA for personal-data
matters; statement of work; Deployment Schedule; Support and Maintenance
Schedule; this Agreement.

## 1. Deployment and commercial model

The Order Form must identify:

- deployment model: Customer-hosted dedicated or Licensor-hosted dedicated;
- licensed edition and maximum workspaces: Dedicated 1, Dedicated 5,
  Dedicated Unlimited, or MSP/Reseller;
- permitted deployment count, environment count, legal entities, controlled
  affiliates, and internal-business purpose;
- licensed major version and delivery artifact;
- one-time license and installation fees;
- included support/update period and optional annual maintenance;
- infrastructure and third-party accounts paid by each party;
- data-hosting region, backup tier, support access, telemetry, maintenance
  window, and any SLA.

Customer-hosted deployments normally run in infrastructure and provider
accounts owned and paid for by Customer. Licensor-hosted dedicated deployments
run in infrastructure operated by Licensor for Customer and require a separate
hosting term and recurring fee. "Dedicated" describes isolation; it does not
by itself promise high availability, a specific region, or offline operation.

## 2. License grant

Subject to payment and this Agreement, Licensor grants Customer a perpetual,
non-exclusive, non-transferable (except under Section 18), non-sublicensable
license to run the delivered object-code version of Support Agent:

- for Customer's internal business operations and those of Controlled
  Affiliates listed in the Order Form;
- within the purchased edition, workspace, deployment, environment, and
  capability entitlements; and
- only for the licensed major version and any updates delivered under active
  maintenance.

"Perpetual" means the licensed version does not expire merely because support
or maintenance ends. It does not include perpetual hosting, support, security
updates, future major versions, or continued compatibility with Shopify, LLM
providers, email providers, operating systems, or other third-party services.

An MSP/Reseller edition is required to host or operate the software for
unrelated businesses. Dedicated Unlimited permits unlimited internal
workspaces for the named Customer and listed Controlled Affiliates; it does not
permit resale, service-bureau use, sublicensing, or white-label distribution.

## 3. Delivery and acceptance

Licensor will deliver the signed image or OCI archive, release manifest,
license entitlement, installation materials, and documentation listed in the
Order Form. Customer will provide the access, infrastructure, domains,
accounts, and decisions required by the implementation plan.

Acceptance will occur when the agreed acceptance tests pass or **[10]** business
days after delivery if Customer has not reported a reproducible material
nonconformity. Licensor will use reasonable efforts to correct a timely
reported nonconformity. Acceptance does not waive latent defects or express
warranties.

## 4. Restrictions

Customer must not:

- exceed licensed workspace, deployment, environment, affiliate, or capability
  entitlements;
- provide the software or hosted access to unrelated third parties without an
  MSP/Reseller license;
- sell, sublicense, redistribute, publish, lease, white-label, or transfer the
  software except as expressly permitted;
- remove ownership, copyright, entitlement, or attribution notices;
- use Licensor's confidential source or implementation details to build a
  competing product; or
- bypass or tamper with signed offline entitlement checks.

Customer may make reasonable backup and disaster-recovery copies. Reverse
engineering restrictions apply only to the maximum extent allowed by law.
There is no remote kill switch: loss of Licensor's systems will not invalidate
an already-issued offline license.

## 5. Ownership and commissioned work

Licensor retains all right, title, and interest in Support Agent, its reusable
modules, architecture, documentation, modifications, improvements, derivative
works, and all rights not expressly granted. Licensor may continue to develop,
host, sell, and license the same product—including as SaaS or to Customer's
competitors.

Customer owns its data, trademarks, policies, knowledge content, and other
materials it supplies. Unless a statement of work expressly identifies a
narrow Customer-owned deliverable, Licensor owns generalized improvements and
reusable functionality developed during implementation or custom work, and
Customer may use them under the license above.

## 6. Infrastructure and third-party services

The Deployment Schedule allocates responsibility for compute, Postgres and
pg-boss, object storage, networking, DNS/TLS, identity, email, LLM inference,
Shopify applications, Google/Microsoft applications, Telegram, tracking,
monitoring, and backups.

In a Customer-hosted deployment, Customer is normally responsible for:

- procuring and paying for infrastructure and third-party services;
- administrator and root access, network security, identity, MFA, domains,
  certificates, keys, secrets, and provider configurations;
- backup destinations, retention, restore testing, capacity, and availability;
- obtaining provider terms and data-processing arrangements; and
- maintaining the supported operating environment described by Licensor.

Licensor is responsible for the application behavior and safeguards expressly
allocated to it, including honoring configured permission gates, workspace
isolation within the application, credential encryption implemented by the
software, state-machine guards, and documented audit behavior.

Third-party services may change or discontinue APIs, models, prices, scopes,
or functionality. Unless the Order Form states otherwise, compatibility work
is provided only under active maintenance and is not guaranteed indefinitely.

## 7. Support, maintenance, and updates

The one-time license fee does not include unlimited support or updates. The
Support and Maintenance Schedule states:

- the included initial period, support hours, channels, and response targets;
- supported versions and environments;
- update and security-fix rights;
- planned maintenance and customer cooperation;
- excluded work and professional-services rates; and
- renewal price and non-renewal notice.

When maintenance ends, Customer may continue running the licensed version but
has no ongoing right to support, patches, new provider compatibility, or new
major versions. Reinstatement may require back-maintenance fees, an upgrade,
or a new statement of work.

No update may be installed without the backup, migration, verification, and
rollback steps allocated in the Deployment Schedule. Licensor will not access
a Customer-hosted environment without Customer's authorization, except where
separate emergency-access terms expressly permit it.

## 8. Data protection and telemetry

Customer is controller/business for personal data processed through its
support operation. Licensor is processor/service provider only to the extent
it hosts the deployment, receives Customer Data for support, performs managed
operations, or has access through enabled telemetry. The DPA governs that
processing.

For a Customer-hosted deployment with no Licensor access or payload telemetry,
Customer operates the data plane and selects its infrastructure and providers.
Operational telemetry sent to Licensor must be opt-in, minimized, and defined
in the Deployment Schedule. Unless expressly agreed, telemetry must not contain
message bodies, attachment contents, credentials, authorization headers, or
raw tool payloads.

Customer will provide lawful notices and instructions for Customer Data and
will complete any regulator filings or transfer approvals allocated to it.
Licensor will complete obligations allocated to it in the DPA. Neither party
will use Shopify Merchant Data, Shopify Customer Data, or other Customer Data
to train generalized AI/ML systems without every express written consent
required by law, Customer, and the applicable platform.

## 9. AI output and authorized actions

AI classifications, summaries, drafts, recommendations, and actions may be
inaccurate, incomplete, or inappropriate. Customer determines its policies,
connected data, tools, scenarios, permission modes, and deterministic limits.

"Ask" requires an authorized Customer user to approve before execution.
"Automatic" means Customer specifically authorizes the named action to execute
without case-by-case review, only within the recorded scope and limits.
Customer is responsible for its lawful business policies, approvals,
communications, refunds, discounts, cancellations, address changes,
fulfillment instructions, and other authorized actions.

Customer must supervise the system, review activity, handle escalations, and
disable automation where continued operation may cause harm or violate law.
Customer must not use the software for unsupported employment, credit,
insurance, healthcare, legal, safety-critical, or other decisions with legal
or similarly significant effects on a person.

Licensor remains responsible for application defects that bypass an Ask or
Deny configuration, exceed a deterministic limit the software promises to
enforce, cross workspace boundaries, duplicate an external side effect due to
failed idempotency, or misstate the authoritative audit record.

## 10. Customer obligations and acceptable use

Customer will:

- use the software lawfully and in accordance with provider/platform terms;
- connect only accounts, mailboxes, stores, credentials, and data it is
  authorized to use;
- maintain qualified administrators and authorized approvers;
- promptly install critical fixes during active maintenance;
- notify Licensor of material security incidents affecting the software where
  Licensor assistance is required; and
- not use the software for spam, phishing, harassment, fraud, malware,
  unauthorized surveillance, or infringement.

For Shopify connections, Customer acknowledges that Licensor—not Shopify—is
responsible for the application and support; Shopify is not liable for faults
or harm from installation or use; and Shopify cannot provide application
support unless it expressly agrees otherwise.

## 11. Security, backup, and incidents

Each party will maintain reasonable administrative, technical, and
organizational safeguards for the systems it controls. The Deployment Schedule
must identify responsibility for vulnerability management, access review,
logs, alerting, incident response, backup frequency, backup encryption, restore
tests, recovery targets, and breach notification.

Recovery point and recovery time figures are engineering targets unless the
Order Form expressly makes them an SLA. A backup is not considered verified
until a restore test succeeds. Customer-hosted deployments remain Customer's
responsibility when Customer declines the recommended backup, monitoring,
update, or managed-operations service.

## 12. Fees and taxes

Customer will pay the one-time license, installation, hosting, maintenance,
professional-services, and other fees in the Order Form. Customer is
responsible for applicable taxes other than taxes on Licensor's net income.

Invoices are due within **[30]** days. Overdue undisputed amounts may accrue
interest at the lesser of **[1.0%]** per month or the lawful maximum. Licensor
may pause undelivered services for overdue amounts after reasonable notice but
will not remotely disable a paid-up perpetual installation.

## 13. Confidentiality

Each party will protect the other's non-public information using at least
reasonable care, use it only for the Agreement, and disclose it only to people
who need it and are bound by confidentiality. Standard exclusions apply for
information lawfully known without restriction, independently developed,
received lawfully from another source, or public without breach. Legally
required disclosure is allowed after advance notice where lawful.

Customer acknowledges that object-code delivery to Customer-controlled
infrastructure can expose implementation details to administrators with root
access. Technical packaging reduces accidental disclosure but is not a
guarantee against inspection; Customer's confidentiality and license
obligations remain the primary protection.

## 14. Warranties and disclaimer

Licensor warrants for **[90]** days after acceptance that the delivered
software will materially conform to its documentation in the supported
environment. Licensor's obligation is to repair, replace, or, if neither is
commercially reasonable, refund the affected license fee in exchange for
termination of that license.

Except for express warranties, and to the maximum extent permitted by law, the
software, AI output, and third-party integrations are provided "as is."
Licensor disclaims implied warranties of merchantability, fitness for a
particular purpose, title, non-infringement, uninterrupted operation,
error-free output, and permanent third-party compatibility. Non-excludable
rights remain unaffected.

## 15. Indemnification

**[COUNSEL TO FINALIZE.]** Customer should defend and indemnify Licensor from
third-party claims caused by Customer Data, unlawful Customer instructions or
use, unauthorized accounts, Customer's breach of Sections 4 or 10, authorized
automated business actions, or unauthorized resale, except to the extent
caused by Licensor.

Licensor should provide a reciprocal indemnity for claims that the unmodified
licensed software infringes third-party intellectual-property rights, subject
to customary exclusions, control-of-defense terms, and remedies.

## 16. Limitation of liability

**[COUNSEL MUST SELECT CAPS AND CARVE-OUTS.]** To the maximum extent permitted
by law, neither party is liable for indirect, special, incidental,
consequential, exemplary, or punitive damages, or lost profits, revenue,
goodwill, or data.

Except for **[PAYMENT, LICENSE/IP MISUSE, CONFIDENTIALITY, INDEMNITY,
FRAUD/WILLFUL MISCONDUCT, DATA PROTECTION, OR OTHER CARVE-OUTS]**, each party's
aggregate liability will not exceed **[THE AMOUNTS PAID OR PAYABLE UNDER THE
ORDER FORM / AN AGREED MULTIPLE]**. Nothing limits liability that applicable
law does not permit the parties to limit.

## 17. Term and termination

This Agreement begins on the effective date and continues until terminated.
Either party may terminate for a material breach not cured within **[30]** days
after notice, or immediately for an incurable breach, insolvency, unlawful use,
or serious security threat.

The perpetual license survives expiry of support or maintenance but may be
terminated for Customer's uncured material breach, including non-payment of
the license fee, unauthorized resale, or deliberate entitlement bypass. On
license termination, Customer must stop use and delete all copies, subject to
any legally required archival copy. Termination of maintenance alone does not
terminate a paid-up perpetual license.

Customer Data remains Customer's responsibility in a Customer-hosted
deployment. For a Licensor-hosted deployment or support copy, the parties will
return or delete Customer Data under the DPA and exit plan. Accrued payment,
confidentiality, ownership, restrictions, disclaimers, liability, indemnity,
and dispute provisions survive as appropriate.

## 18. General

Neither party may assign this Agreement without consent, except to an affiliate
or successor in a merger or sale of substantially all relevant assets that
assumes the Agreement. Customer may not assign the license to a Licensor
competitor or unrelated service provider without consent. A change of control
does not expand licensed affiliates, workspaces, or service-bureau rights.

Neither party is liable for delay from events beyond reasonable control,
except payment. The parties are independent contractors. Changes must be in a
writing signed by authorized representatives. If a provision is unenforceable,
it will be limited to the minimum necessary. Failure to enforce is not a
waiver. The listed agreement documents are the entire agreement.

The Agreement is governed by **[GOVERNING LAW]**. The courts of
**[CITY/COUNTRY]** have exclusive jurisdiction, subject to **[ARBITRATION OR
INJUNCTIVE-RELIEF TERMS, IF ANY]**.

Notices must be sent to the contacts in the Order Form, with legal notices to
Licensor at **[LEGAL NOTICE EMAIL AND ADDRESS]**.

## Schedule checklist (must accompany each Order Form)

- [ ] Legal names, addresses, signing authority, and effective date
- [ ] Customer-hosted or Licensor-hosted deployment
- [ ] Edition, workspace/deployment limits, affiliates, and permitted use
- [ ] Major version, artifact, acceptance tests, and warranty period
- [ ] Fees, taxes, invoice terms, maintenance renewal, and professional rates
- [ ] Infrastructure/provider responsibility matrix
- [ ] Hosting region and international-transfer mechanism
- [ ] DPA, subprocessor list, and controller/processor allocation
- [ ] Support access and payload-free telemetry configuration
- [ ] Security controls, backup tier, restore tests, RPO/RTO target or SLA
- [ ] Support hours, response targets, maintenance window, and exclusions
- [ ] Update, migration, rollback, and end-of-maintenance process
- [ ] Exit assistance, data return/deletion, and credential handover
- [ ] Liability cap, indemnities, insurance, governing law, and dispute process
