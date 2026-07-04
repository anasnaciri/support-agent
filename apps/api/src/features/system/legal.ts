import {
  DATA_PROCESSING_NOTICE_VERSION,
  DPA_VERSION,
} from "@support-agent/services";

const esc = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export const legalVersions = {
  dataProcessingNoticeVersion: DATA_PROCESSING_NOTICE_VERSION,
  dpaVersion: DPA_VERSION,
} as const;

export const renderDataProcessingNoticeHtml = (): string => {
  const noticeVersion = esc(DATA_PROCESSING_NOTICE_VERSION);
  const dpaVersion = esc(DPA_VERSION);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Support Agent Data Processing Notice</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #ffffff; color: #18181b; }
    main { max-width: 860px; margin: 0 auto; padding: 48px 24px 72px; }
    h1 { font-size: 2rem; line-height: 1.15; margin: 0 0 8px; color: #111511; }
    h2 { font-size: 1.15rem; margin: 32px 0 8px; color: #111511; }
    p, li { color: #3f3f46; line-height: 1.65; }
    .meta { color: #6b7280; font-size: 0.9rem; }
    .box { border: 1px solid #e4e7e4; border-radius: 8px; padding: 18px; background: #f7f8f7; }
    a { color: #3f8f3f; }
  </style>
</head>
<body>
  <main>
    <p class="meta">Notice version ${noticeVersion} · DPA version ${dpaVersion}</p>
    <h1>Data Processing Notice</h1>
    <p>
      Support Agent processes merchant customer data only to operate AI-assisted
      customer support workflows for the merchant that connected the platform.
      We do not sell customer data or use it for advertising.
    </p>

    <section class="box">
      <h2>Customer data categories</h2>
      <ul>
        <li>customer name, customer email, and support-message content;</li>
        <li>order identifiers, fulfillment status, tracking numbers, and product details;</li>
        <li>shipping address fields when needed for missing-package or order-status support;</li>
        <li>customer-provided image attachments for damaged-product workflows.</li>
      </ul>
    </section>

    <h2>Processing purposes</h2>
    <p>
      Data is used to classify support requests, retrieve relevant commerce and
      conversation history, draft support replies, prepare merchant approvals,
      execute approved tools, and keep an audit trail of support operations.
    </p>

    <h2>Subprocessors</h2>
    <p>
      The platform may use OpenRouter, Anthropic, or OpenAI for tenant-selected
      LLM inference; Google for Gmail and Google Sheets connectors; Shopify for
      commerce data; Resend for platform/system mail; Cloudflare R2 for object
      storage; 17track when carrier lookup is configured; and the hosting and
      database infrastructure configured for the production deployment.
    </p>

    <h2>Retention</h2>
    <p>
      Resolved cases are archived after 30 days. Archived cases are retained for
      12 months, then a daily retention sweep deletes the case, state
      transitions, approvals, and audit rows.
    </p>

    <h2>Security controls</h2>
    <p>
      Connector credentials and tenant LLM keys are encrypted with AES-256-GCM.
      Production traffic uses TLS. Customer-facing tool execution remains
      permissioned and auditable; external communication and financial actions
      require approval unless the merchant explicitly configures a narrower
      allow policy.
    </p>

    <h1>Data Processing Addendum</h1>
    <p>
      By accepting this notice in the merchant dashboard, the merchant authorizes
      Support Agent to process personal data on the merchant's behalf for the
      support purposes above, confirms it has the authority to provide that data,
      and agrees that Support Agent acts as a processor/service provider for the
      connected support workflows.
    </p>
    <p>
      Support Agent will process data only on documented merchant instructions,
      keep subprocessors bound by appropriate confidentiality and data-protection
      obligations, assist with deletion/access requests where technically
      possible, and notify the merchant of confirmed security incidents affecting
      merchant customer data without undue delay.
    </p>
  </main>
</body>
</html>`;
};
