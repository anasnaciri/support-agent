# Support Agent Privacy Policy

Status: working draft for counsel review
Draft date: 2026-07-18
Effective date: **[EFFECTIVE DATE]**

> Before publication, replace every bracketed placeholder and have counsel
> review this policy for the countries where the service provider and its
> customers are established or do business. This draft describes the product's
> current architecture; it does not itself complete regulatory filings or
> international-transfer paperwork.

This Privacy Policy explains how **[LEGAL ENTITY NAME]**, trading as Support
Agent ("Support Agent," "we," "us," or "our"), collects, uses, discloses, and
protects personal data in connection with the Support Agent website,
dashboard, applications, and related services (the "Service").

Contact details:

- Registered address: **[LEGAL ENTITY ADDRESS]**
- Privacy email: **[PRIVACY EMAIL]**
- Data protection representative or officer, if applicable: **[NAME/CONTACT OR
  "NOT APPLICABLE"]**

## 1. Scope and our role

Support Agent is a business-to-business, AI-assisted customer-support
operations platform.

Our role depends on whose data we process and why:

- We act as a **controller** (or equivalent term under applicable law) for
  merchant account information, billing and commercial records, security
  logs, communications with us, and information used to operate and improve
  the Service.
- A merchant normally acts as the **controller** of its customers' support,
  order, fulfillment, and commerce data. We process that data as the
  merchant's **processor** or **service provider**, following the merchant's
  instructions and our Data Processing Addendum ("DPA").
- The merchant, not Support Agent, is responsible for its own customer-facing
  privacy notice and for giving its customers any disclosures and choices
  required by law. Customers of a merchant should ordinarily direct privacy
  requests to that merchant first.

This policy does not govern a third-party service, such as Shopify, Google,
Microsoft, an email provider, an LLM provider, or a carrier-tracking provider,
when that service processes data under its own terms.

## 2. Deployment models

The Service can be delivered in different deployment models.

| Model | Where business data is hosted | Support Agent's usual privacy role |
| --- | --- | --- |
| Shared SaaS | Infrastructure selected and operated by us | Processor for merchant customer data; controller for account, security, and commercial data |
| Licensor-hosted dedicated | Infrastructure dedicated to one customer but operated by us | The same role split as SaaS, with dedicated infrastructure |
| Customer-hosted dedicated | Infrastructure and provider accounts controlled by the customer | The customer controls the data plane; we process business data only if support access, managed operations, or optional telemetry is enabled |

The applicable order form or deployment schedule identifies the selected
model, hosting location, enabled support access, telemetry, and any
customer-selected providers. A customer-hosted deployment may present a
customer-specific version of this notice naming that customer as the operator.

## 3. Personal data we process

Depending on how the Service is used, we process the following categories.

### Merchant users and business contacts

- name, business email address, organization, role, and workspace membership;
- authentication identifiers, session information, and account preferences;
- billing contact, subscription, invoice, and transaction records (payment
  card details are handled by the payment provider and are not intended to be
  stored by Support Agent);
- messages, support requests, survey responses, and other communications sent
  to us;
- IP address, device/browser information, timestamps, request identifiers,
  security events, and operational logs.

### Merchant customer and support-operation data

- customer name, email address, and support-message content;
- message headers and conversation history from a connected mailbox;
- customer-supplied attachments, including product-damage photographs;
- Shopify customer and order identifiers, product and line-item details,
  order status, refunds, discounts, cancellations, fulfillment data, carrier
  details, and tracking numbers;
- shipping-address fields when needed for order-status, delivery, or
  missing-package support;
- merchant-authored policies, knowledge documents, instructions, agent
  configurations, and approval decisions;
- tickets, classifications, suggested replies, tool calls and results,
  escalations, state transitions, delivery records, and audit history.

### Connections and credentials

- identifiers, scopes, status, and metadata for connected stores, mailboxes,
  spreadsheets, notification channels, and AI providers; and
- encrypted access tokens, refresh tokens, API keys, or IMAP/SMTP credentials
  needed to operate a connection.

We do not intentionally collect government identifiers, payment-card numbers,
health information, biometric information, or other special-category data as
part of the Service. Merchants and their customers should not include such
data in support messages or knowledge content unless it is strictly necessary
and lawful.

## 4. How we obtain personal data

We obtain personal data:

- directly from merchant users when they register, configure the Service, or
  contact us;
- from the merchant's connected services, including Shopify, Gmail, Microsoft
  365/Outlook, IMAP/SMTP mail providers, Google Sheets, Telegram, LLM
  providers, and tracking services;
- from the merchant's customers when they contact the merchant through a
  connected conversation channel;
- automatically from browsers, devices, application requests, cookies, and
  security or operational logs; and
- from authorized fulfillment partners when they respond to a merchant's
  escalation.

## 5. How and why we use personal data

We use personal data to:

- create and administer accounts and workspaces;
- authenticate users and enforce permissions;
- receive, classify, route, investigate, and resolve support requests;
- retrieve relevant commerce, fulfillment, tracking, and conversation context;
- generate AI-assisted classifications, summaries, recommendations, and reply
  drafts;
- present actions for merchant approval and execute actions the merchant has
  authorized, such as replies, refunds, discounts, order changes, or
  fulfillment escalations;
- deliver messages through the same merchant-connected mailbox and preserve
  conversation threading;
- operate analytics, maintain audit records, detect abuse, troubleshoot, and
  secure the Service;
- provide customer support, service notices, billing, and account
  administration;
- comply with law, enforce agreements, and establish or defend legal claims.

Where applicable law requires a legal basis, we rely on performance of a
contract, our legitimate interests in operating and securing a business
service, compliance with legal obligations, or consent where consent is
required. When we process merchant customer data as a processor, the merchant
determines the applicable legal basis.

Support Agent does **not** sell personal data, share it for cross-context
behavioral advertising, or use merchant data or merchant customer data to
train our own generalized AI or machine-learning models. Merchant customer
data is used only to provide the Service to the relevant merchant, unless the
merchant and any platform owner whose consent is required give separate,
explicit written authorization.

## 6. AI processing and automated actions

Relevant ticket and commerce context may be included in prompts sent to the
LLM provider and model selected for the workspace. AI output can be inaccurate
or incomplete. The Service therefore uses configurable permissions and audit
records. Customer-facing communications and actions with financial or account
effects require merchant approval by default; a merchant may deliberately
authorize narrowly configured automatic actions.

If a merchant supplies its own LLM credentials, the merchant also selects the
provider and is responsible for confirming that the provider's terms,
retention, region, and training settings meet its requirements. Merchants must
not select a provider that uses Shopify Merchant Data or Customer Data for
model training unless every required written consent has been obtained.

The Service is not designed to make employment, credit, insurance, healthcare,
legal, or other decisions that produce legal or similarly significant effects
about individuals.

## 7. When we disclose personal data

We disclose personal data only as needed for the purposes above:

- **Infrastructure and business service providers.** Depending on deployment,
  these may include hosting, database, object-storage, authentication,
  system-email, payment, monitoring, and customer-support providers.
- **Merchant-selected AI providers.** OpenRouter, Anthropic, OpenAI, or another
  provider selected and configured by the merchant may receive prompt content
  needed for inference.
- **Connected services.** Google, Microsoft, Shopify, a merchant's IMAP/SMTP
  provider, Telegram, Google Sheets, and 17TRACK may process data necessary for
  the merchant-enabled connection.
- **Merchant-directed recipients.** When a merchant escalates a ticket, relevant
  order, shipping, attachment, and conversation details may be shared with a
  fulfillment partner selected by the merchant, through the fulfillment
  portal or a merchant-connected spreadsheet.
- **Professional advisers and authorities.** We may disclose data to auditors,
  insurers, lawyers, regulators, courts, or law-enforcement bodies when
  reasonably necessary and legally permitted.
- **Corporate transactions.** Data may be disclosed in connection with a
  financing, merger, acquisition, reorganization, or sale of assets, subject
  to appropriate confidentiality and legal safeguards.

Our current deployment-specific subprocessor list should be published at
**[SUBPROCESSOR LIST URL]**. The SaaS deployment currently expects to use
WorkOS for identity, Cloudflare for web hosting and object storage, Resend for
platform/system email, the configured hosting and PostgreSQL providers, and
the merchant-selected AI and connector providers described above. Not every
provider receives data from every merchant.

## 8. International transfers and storage location

Data may be processed outside the country where a merchant or individual is
located. The primary hosting region for the applicable deployment is
**[SAAS HOSTING REGION OR "IDENTIFIED IN THE ORDER FORM"]**. A customer-hosted
deployment uses the locations chosen by that customer.

Where required, we use an approved transfer mechanism, such as adequacy
decisions, the European Commission's Standard Contractual Clauses, or another
lawful safeguard. If Support Agent is established in Morocco or uses processing
means located there, required CNDP declarations, authorizations, and
international-transfer filings must be completed separately; publishing this
policy is not a substitute for those formalities.

## 9. Retention

We retain data only for as long as needed for the purposes described above,
subject to legal and contractual requirements.

| Data | Current retention approach |
| --- | --- |
| Resolved tickets and linked records | Remain resolved for 30 days, are then archived, and are deleted after 12 months in the archived state |
| Unresolved, failed, or human-takeover tickets | Retained while active or needed to provide the Service; deleted on account/workspace deletion or an applicable erasure workflow |
| Unused uploaded attachments | Deleted after approximately 30 days when not bound to a durable message, approval, or open escalation |
| Connector credentials | Retained while the connection is active; revoked or deleted when disconnected, the workspace is deleted, or law/platform rules require deletion |
| Account, billing, tax, and contract records | **[INSERT PERIOD, e.g. contract term plus 7 years, subject to local law]** |
| Security and operational logs | **[INSERT PERIOD]** |
| Backups | **[INSERT ROLLING BACKUP RETENTION AND DELETION/LAPSE PROCESS]** |

When a Shopify merchant uninstalls the app, no longer needs the Service, or an
enforceable deletion request is received, Shopify Merchant Data is deleted
within the period required by Shopify's terms (currently no more than 30 days),
unless retention is legally required. Shopify's mandatory privacy webhooks may
trigger deletion sooner. Data held by third-party providers is also subject to
their retention and backup cycles.

## 10. Cookies and similar technologies

The dashboard currently uses cookies and local browser storage that are
necessary for sign-in, security, legal-consent routing, workspace selection,
and user-interface preferences. We do not currently use advertising cookies or
sell/share cookie data for targeted advertising.

If non-essential analytics or advertising technologies are introduced, this
policy and the consent controls must be updated before they are enabled where
prior consent is required.

## 11. Security

We use technical and organizational safeguards appropriate to the risk,
including TLS in transit, encrypted connector credentials and tenant LLM keys,
tenant/workspace isolation, role-based access, configurable approval gates,
audit trails, backups appropriate to the deployment, and restricted production
access. No system is completely secure, and we cannot guarantee that
unauthorized access or loss will never occur.

In customer-hosted deployments, the customer is responsible for the security
controls allocated to it in the deployment schedule, which normally include
its infrastructure, network, identity provider, provider accounts, encryption
keys, backups, and administrator access.

## 12. Privacy rights and requests

Depending on location and applicable law, individuals may have rights to
access, correct, delete, restrict, or object to processing; receive a portable
copy; withdraw consent; opt out of sale, sharing, or certain automated
processing; and complain to a regulator. We will not discriminate against an
individual for exercising a privacy right.

Merchant customers should first contact the merchant with which they have a
relationship. We will assist the merchant as required by the DPA. Merchant
users and business contacts may submit a request to **[PRIVACY EMAIL]**. We may
need to verify the request and may retain limited information where law permits
or requires it.

California residents may use the same email to exercise applicable rights to
know, correct, delete, and limit or opt out of covered uses. Support Agent does
not sell personal information or share it for cross-context behavioral
advertising. If Support Agent is not subject to the CCPA for a particular
processing activity, we may still respond voluntarily where reasonable.

Moroccan data subjects may exercise applicable rights under Law No. 09-08,
including access, rectification, and objection, by contacting **[PRIVACY
EMAIL/POSTAL ADDRESS]** and may contact the CNDP.

## 13. Children

The Service is offered to businesses and is not directed to children. We do
not knowingly create accounts for anyone under 18. Merchant customers may
include minors; the merchant is responsible for ensuring that its use of the
Service and instructions concerning such data are lawful.

## 14. Changes to this policy

We may update this policy to reflect changes in the Service, providers, or law.
We will post the revised version with a new effective date and provide
additional notice when a material change requires it. A change to this policy
does not by itself expand our right to process merchant customer data beyond
the merchant's instructions and the DPA.

## 15. Questions and complaints

Questions or complaints may be sent to **[PRIVACY EMAIL]** or to **[LEGAL
ENTITY ADDRESS]**. Individuals may also complain to the data-protection
  authority in their country or region.
