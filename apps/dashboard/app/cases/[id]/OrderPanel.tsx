import type {
  ShopifyOrder,
  ShopifyFulfillment,
} from "@support-agent/agent-core";
import { formatRelativeTime } from "@/lib/format";

interface Props {
  readonly order: ShopifyOrder | null;
  readonly orderHint: string | null;
}

const formatAddress = (
  addr: ShopifyOrder["shippingAddress"],
): string | null => {
  if (!addr) return null;
  const parts = [
    addr.name,
    addr.address1,
    addr.address2,
    [addr.city, addr.province].filter(Boolean).join(", "),
    [addr.country, addr.zip].filter(Boolean).join(" "),
  ].filter((s): s is string => typeof s === "string" && s.length > 0);
  return parts.length > 0 ? parts.join("\n") : null;
};

const latestFulfillment = (
  fulfillments: ReadonlyArray<ShopifyFulfillment>,
): ShopifyFulfillment | null => {
  if (fulfillments.length === 0) return null;
  return [...fulfillments].sort(
    (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime(),
  )[0]!;
};

export const OrderPanel = ({ order, orderHint }: Props) => {
  if (!order && !orderHint) {
    return (
      <div className="panel">
        <div className="panel-header">Order</div>
        <p className="panel-empty">No order linked to this case yet.</p>
      </div>
    );
  }

  if (!order) {
    return (
      <div className="panel">
        <div className="panel-header">Order</div>
        <p className="panel-empty">
          Agent referenced order <code>{orderHint}</code> but it could not be
          fetched (or store not connected).
        </p>
      </div>
    );
  }

  const fulfillment = latestFulfillment(order.fulfillments);
  const shipTo = formatAddress(order.shippingAddress);
  const total = order.totalPrice;

  return (
    <div className="panel">
      <div className="panel-header">
        Order {order.name}
        {order.fulfillmentStatus ? (
          <span className={`badge ${order.fulfillmentStatus}`}>
            {order.fulfillmentStatus.replace(/_/g, " ")}
          </span>
        ) : null}
        {order.financialStatus ? (
          <span className={`badge ${order.financialStatus}`}>
            {order.financialStatus.replace(/_/g, " ")}
          </span>
        ) : null}
      </div>
      <dl className="panel-grid">
        <dt>Placed</dt>
        <dd>{formatRelativeTime(order.createdAt)}</dd>
        <dt>Total</dt>
        <dd>
          {total.amount} {total.currencyCode}
        </dd>
        {shipTo ? (
          <>
            <dt>Ship to</dt>
            <dd>
              <pre className="address">{shipTo}</pre>
            </dd>
          </>
        ) : null}
        {fulfillment ? (
          <>
            <dt>Tracking</dt>
            <dd>
              {fulfillment.trackingCompany ?? "Carrier unknown"}
              {fulfillment.trackingNumbers.length > 0 ? (
                <>
                  {" — "}
                  {fulfillment.trackingUrls[0] ? (
                    <a
                      href={fulfillment.trackingUrls[0]}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {fulfillment.trackingNumbers[0]}
                    </a>
                  ) : (
                    <code>{fulfillment.trackingNumbers[0]}</code>
                  )}
                </>
              ) : null}
              {fulfillment.estimatedDeliveryAt ? (
                <div className="muted">
                  ETA{" "}
                  {fulfillment.estimatedDeliveryAt
                    .toISOString()
                    .slice(0, 10)}
                </div>
              ) : null}
              {fulfillment.deliveredAt ? (
                <div className="muted">
                  Delivered{" "}
                  {fulfillment.deliveredAt.toISOString().slice(0, 10)}
                </div>
              ) : null}
            </dd>
          </>
        ) : null}
      </dl>
      {order.lineItems.length > 0 ? (
        <>
          <div className="panel-subheader">Line items</div>
          <ul className="line-items">
            {order.lineItems.map((li) => (
              <li key={li.id}>
                <span className="qty">×{li.quantity}</span>
                <span className="title">
                  {li.title}
                  {li.variantTitle ? (
                    <span className="muted"> — {li.variantTitle}</span>
                  ) : null}
                </span>
                {li.sku ? <code>{li.sku}</code> : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
};
