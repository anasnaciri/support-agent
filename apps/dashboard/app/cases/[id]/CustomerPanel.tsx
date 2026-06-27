import type { ShopifyCustomer } from "@support-agent/agent-core";
import { User } from "lucide-react";

import { formatRelativeTime } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface Props {
  readonly customer: ShopifyCustomer | null;
  readonly customerEmail: string | null;
  /**
   * The order's email, confirmed by the requester on an order/customer mismatch
   * case (runtime-stamped, never model-set). Shown distinctly from `Email`,
   * which is the corresponding address and may be a typo or a different sender.
   */
  readonly verifiedOrderEmail?: string | null;
}

const fullName = (c: ShopifyCustomer): string | null => {
  const parts = [c.firstName, c.lastName].filter(
    (s): s is string => typeof s === "string" && s.length > 0,
  );
  return parts.length > 0 ? parts.join(" ") : null;
};

const PanelShell = ({
  title,
  children,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
}) => (
  <Card>
    <CardHeader className="pb-3">
      <CardTitle className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
        <User className="size-3.5" aria-hidden />
        {title}
      </CardTitle>
    </CardHeader>
    <CardContent className="pt-0">{children}</CardContent>
  </Card>
);

const Row = ({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) => (
  <>
    <dt className="text-[11px] uppercase tracking-wider text-muted-foreground">
      {label}
    </dt>
    <dd className="text-sm">{children}</dd>
  </>
);

export const CustomerPanel = ({
  customer,
  customerEmail,
  verifiedOrderEmail,
}: Props) => {
  const verified =
    typeof verifiedOrderEmail === "string" && verifiedOrderEmail.length > 0
      ? verifiedOrderEmail
      : null;

  if (!customer && !customerEmail && !verified) {
    return (
      <PanelShell title="Customer">
        <p className="text-sm italic text-muted-foreground">
          No customer linked to this case yet.
        </p>
      </PanelShell>
    );
  }

  if (!customer) {
    return (
      <PanelShell title="Customer">
        <dl className="grid grid-cols-[max-content_1fr] items-center gap-x-3 gap-y-1.5">
          {customerEmail ? <Row label="Email">{customerEmail}</Row> : null}
          {verified ? (
            <Row label="Verified order email">{verified}</Row>
          ) : null}
        </dl>
        <p className="mt-3 text-sm italic text-muted-foreground">
          No matching Shopify customer (or store not connected).
        </p>
      </PanelShell>
    );
  }

  const name = fullName(customer);
  const total = customer.totalSpent;
  const addr = customer.defaultAddress;

  return (
    <PanelShell title="Customer">
      <dl className="grid grid-cols-[max-content_1fr] items-center gap-x-3 gap-y-1.5">
        {name ? <Row label="Name">{name}</Row> : null}
        <Row label="Email">{customer.email ?? customerEmail ?? "—"}</Row>
        {verified && verified !== customer.email ? (
          <Row label="Verified order email">{verified}</Row>
        ) : null}
        {customer.phone ? <Row label="Phone">{customer.phone}</Row> : null}
        <Row label="Orders">{customer.ordersCount}</Row>
        <Row label="Lifetime">
          {total.amount} {total.currencyCode}
        </Row>
        <Row label="Since">{formatRelativeTime(customer.createdAt)}</Row>
        {addr ? (
          <Row label="Address">
            {[addr.city, addr.province, addr.country]
              .filter((s): s is string => Boolean(s))
              .join(", ") || "—"}
          </Row>
        ) : null}
      </dl>
    </PanelShell>
  );
};
