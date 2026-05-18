import type { ShopifyCustomer } from "@support-agent/agent-core";
import { formatRelativeTime } from "@/lib/format";

interface Props {
  readonly customer: ShopifyCustomer | null;
  readonly customerEmail: string | null;
}

const fullName = (c: ShopifyCustomer): string | null => {
  const parts = [c.firstName, c.lastName].filter(
    (s): s is string => typeof s === "string" && s.length > 0,
  );
  return parts.length > 0 ? parts.join(" ") : null;
};

export const CustomerPanel = ({ customer, customerEmail }: Props) => {
  if (!customer && !customerEmail) {
    return (
      <div className="panel">
        <div className="panel-header">Customer</div>
        <p className="panel-empty">No customer linked to this case yet.</p>
      </div>
    );
  }

  if (!customer) {
    return (
      <div className="panel">
        <div className="panel-header">Customer</div>
        <dl className="panel-grid">
          <dt>Email</dt>
          <dd>{customerEmail}</dd>
        </dl>
        <p className="panel-empty">
          No matching Shopify customer (or store not connected).
        </p>
      </div>
    );
  }

  const name = fullName(customer);
  const total = customer.totalSpent;
  const addr = customer.defaultAddress;

  return (
    <div className="panel">
      <div className="panel-header">Customer</div>
      <dl className="panel-grid">
        {name ? (
          <>
            <dt>Name</dt>
            <dd>{name}</dd>
          </>
        ) : null}
        <dt>Email</dt>
        <dd>{customer.email ?? customerEmail ?? "—"}</dd>
        {customer.phone ? (
          <>
            <dt>Phone</dt>
            <dd>{customer.phone}</dd>
          </>
        ) : null}
        <dt>Orders</dt>
        <dd>{customer.ordersCount}</dd>
        <dt>Lifetime</dt>
        <dd>
          {total.amount} {total.currencyCode}
        </dd>
        <dt>Customer since</dt>
        <dd>{formatRelativeTime(customer.createdAt)}</dd>
        {addr ? (
          <>
            <dt>Address</dt>
            <dd>
              {[addr.city, addr.province, addr.country]
                .filter((s): s is string => Boolean(s))
                .join(", ") || "—"}
            </dd>
          </>
        ) : null}
      </dl>
    </div>
  );
};
