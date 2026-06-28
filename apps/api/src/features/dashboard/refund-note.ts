// The note attached to a dashboard-issued Shopify refund — it shows up on the
// refund in Shopify admin and ties the money movement back to the case. The
// refund is operator-initiated from the case page; the optional staff `reason`
// from the refund dialog (Shopify's "Reason for refund" field) is appended when
// the operator entered one. Pure + unit-tested so the wording stays stable.
export const dashboardRefundNote = (input: {
  readonly caseId: string;
  readonly reason: string | null;
}): string => {
  const base = `Refund issued from dashboard — case ${input.caseId}`;
  const reason = input.reason?.trim();
  return reason ? `${base} — reason: ${reason}` : base;
};
