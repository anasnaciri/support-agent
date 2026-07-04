// The note attached to a dashboard-issued Shopify refund — it shows up on the
// refund in Shopify admin and ties the money movement back to the ticket. The
// refund is operator-initiated from the ticket page; the optional staff `reason`
// from the refund dialog (Shopify's "Reason for refund" field) is appended when
// the operator entered one. Pure + unit-tested so the wording stays stable.
export const dashboardRefundNote = (input: {
  readonly ticketId: string;
  readonly reason: string | null;
}): string => {
  const base = `Refund issued from dashboard — ticket ${input.ticketId}`;
  const reason = input.reason?.trim();
  return reason ? `${base} — reason: ${reason}` : base;
};
