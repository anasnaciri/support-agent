# Legal document set

Status: working drafts for counsel review
Last updated: 2026-07-18

These drafts reflect Support Agent's current product and deployment model:

- [`privacy-policy.md`](./privacy-policy.md) is one public policy covering the
  shared SaaS, Licensor-hosted dedicated, and customer-hosted dedicated modes.
  A customer-hosted deployment may publish a customer-branded notice, but the
  underlying role and data-flow disclosures should remain consistent.
- [`saas-terms-of-service.md`](./saas-terms-of-service.md) is the standard
  merchant agreement for the hosted multi-tenant service and the Shopify
  public-app path.
- [`dedicated-deployment-agreement.md`](./dedicated-deployment-agreement.md) is
  a negotiated object-code license, deployment, support, and responsibility
  agreement. It is not a lightly edited SaaS clickwrap.

The existing public `/legal/data-processing` page is a short Data Processing
Notice and DPA. It is not a substitute for the public privacy policy or either
commercial agreement, and its DPA terms need counsel review and expansion
before serving GDPR/UK GDPR or CCPA-regulated customers.

## Recommended publication model

1. Publish one canonical Privacy Policy, with a deployment-mode section and a
   separately maintained subprocessor page.
2. Present the SaaS Terms and DPA during self-service signup, and store the
   accepted version, user, organization, timestamp, and source IP where lawful.
3. Use a signed Order Form plus the Dedicated Deployment Agreement, Deployment
   Schedule, DPA, and Support/Maintenance Schedule for each dedicated customer.
4. Give merchants short customer-notice language they can add to their own
   privacy policies, explaining that an AI-assisted support processor receives
   messages and relevant order/fulfillment data.

## Decisions required before publication

- legal entity name/form, registered address, and privacy/security/legal emails;
- markets served and establishment location;
- governing law, courts/arbitration, and controlling language;
- SaaS billing, trial, refund, auto-renewal, and cancellation mechanics;
- warranty period, liability cap, indemnities, and insurance;
- SaaS hosting/database regions and provider legal entities;
- log, backup, account, tax, and contract-record retention periods;
- whether any non-essential analytics or advertising cookies will be used;
- international-transfer mechanism and subprocessor-change notice period;
- Moroccan CNDP declaration/authorization and foreign-transfer filings, if
  Moroccan Law No. 09-08 applies;
- EU/UK representative or DPO appointments, if required; and
- California applicability and request channels if statutory thresholds are
  met.

## Material product/legal follow-ups

- Replace the short DPA with a full processor agreement covering instructions,
  confidentiality, security, subprocessors, rights requests, incidents,
  audits, deletion/return, international transfers, and processing details.
- Publish and operationally maintain a deployment-specific subprocessor list.
- Reconcile every provider's no-training and retention configuration,
  especially platform-paid LLM inference, with the promises in these drafts
  and Shopify's current AI-training restrictions.
- Confirm that privacy-policy retention language matches backup, log,
  unresolved-ticket, and uninstall deletion behavior in production.
- Version commercial terms separately from informational privacy-policy and
  subprocessor updates; do not require a new DPA acceptance for every minor
  notice change.
