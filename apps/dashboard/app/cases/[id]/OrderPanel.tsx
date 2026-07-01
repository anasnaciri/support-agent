import type { ShopifyOrder } from "@support-agent/agent-core";
import { ExternalLink, Package, Truck } from "lucide-react";

import { formatRelativeTime } from "@/lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

import { fulfillmentDay, latestFulfillment } from "./order-panel-data";

interface Props {
  readonly order: ShopifyOrder | null;
  readonly orderHint: string | null;
  /**
   * Tenant's active Shopify shop domain (e.g. `acme.myshopify.com`). When
   * present, the order name renders as a link to the merchant's Shopify
   * admin order page. Null when the tenant has no active Shopify
   * connection — the panel still renders, just without the deep link.
   */
  readonly shopDomain: string | null;
}

/**
 * Build the merchant-admin URL for an order. Shopify admin URLs use the
 * numeric internal id, not the merchant-facing `#1001` name. ShopifyOrder
 * always carries either a `gid://shopify/Order/<n>` GID (set after a
 * `shopify.get_order` tool call) or a bare numeric string — extract the
 * numeric tail from either and append. Returns null if neither shape
 * matches (defensive — should never happen for orders fetched through
 * `ShopifyService`).
 */
const shopifyAdminOrderUrl = (
  shopDomain: string,
  orderId: string,
): string | null => {
  const numericFromGid = /^gid:\/\/shopify\/Order\/(\d+)$/.exec(orderId);
  const numericTail = numericFromGid?.[1] ?? (/^\d+$/.test(orderId) ? orderId : null);
  if (!numericTail) return null;
  return `https://${shopDomain}/admin/orders/${numericTail}`;
};

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

const fulfillmentBadgeVariant = (
  status: string | null,
): "success" | "warning" | "muted" | "destructive" => {
  switch (status) {
    case "fulfilled":
      return "success";
    case "partial":
    case "in_progress":
      return "warning";
    case "unfulfilled":
      return "muted";
    case "cancelled":
      return "destructive";
    default:
      return "muted";
  }
};

const financialBadgeVariant = (
  status: string | null,
): "success" | "warning" | "muted" | "destructive" => {
  switch (status) {
    case "paid":
      return "success";
    case "partially_paid":
    case "pending":
    case "authorized":
      return "warning";
    case "refunded":
    case "partially_refunded":
      return "muted";
    case "voided":
      return "destructive";
    default:
      return "muted";
  }
};

export const OrderPanel = ({ order, orderHint, shopDomain }: Props) => {
  if (!order && !orderHint) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
            <Package className="size-3.5" aria-hidden />
            Order
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <p className="text-sm italic text-muted-foreground">
            No order linked to this case yet.
          </p>
        </CardContent>
      </Card>
    );
  }

  if (!order) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
            <Package className="size-3.5" aria-hidden />
            Order
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <p className="text-sm italic text-muted-foreground">
            Agent referenced order{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
              {orderHint}
            </code>{" "}
            but it could not be fetched (or store not connected).
          </p>
        </CardContent>
      </Card>
    );
  }

  const fulfillment = latestFulfillment(order.fulfillments);
  const shipTo = formatAddress(order.shippingAddress);
  const total = order.totalPrice;
  const adminUrl = shopDomain ? shopifyAdminOrderUrl(shopDomain, order.id) : null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
            <Package className="size-3.5" aria-hidden />
            <span>Order </span>
            {adminUrl ? (
              <a
                href={adminUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 normal-case tracking-normal text-primary hover:underline"
                title="Open in Shopify admin"
              >
                {order.name}
                <ExternalLink className="size-3" aria-hidden />
              </a>
            ) : (
              <span className="normal-case tracking-normal">{order.name}</span>
            )}
          </CardTitle>
          {order.fulfillmentStatus ? (
            <Badge variant={fulfillmentBadgeVariant(order.fulfillmentStatus)}>
              {order.fulfillmentStatus.replace(/_/g, " ")}
            </Badge>
          ) : null}
          {order.financialStatus ? (
            <Badge variant={financialBadgeVariant(order.financialStatus)}>
              {order.financialStatus.replace(/_/g, " ")}
            </Badge>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-3 pt-0">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>Placed {formatRelativeTime(order.createdAt)}</span>
          {shipTo ? (
            <span
              className="max-w-[60%] truncate"
              title={shipTo.replace(/\n/g, ", ")}
            >
              {[
                order.shippingAddress?.city,
                order.shippingAddress?.province ?? order.shippingAddress?.country,
              ]
                .filter(Boolean)
                .join(", ")}
            </span>
          ) : null}
        </div>

        {order.lineItems.length > 0 ? (
          <ul className="space-y-0.5">
            {order.lineItems.map((li) => (
              <li key={li.id} className="flex items-center gap-2.5 py-1">
                <div
                  className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
                  aria-hidden
                >
                  <Package className="size-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium">
                    {li.title}
                  </div>
                  {li.variantTitle ? (
                    <div className="truncate text-xs text-muted-foreground">
                      {li.variantTitle}
                    </div>
                  ) : null}
                </div>
                <span className="shrink-0 font-mono text-xs text-muted-foreground">
                  ×{li.quantity}
                </span>
              </li>
            ))}
          </ul>
        ) : null}

        <div className="flex items-center justify-between border-t border-border/70 pt-2.5">
          <span className="text-[13px] font-medium text-muted-foreground">
            Total
          </span>
          <span className="font-mono text-sm font-medium">
            {total.amount} {total.currencyCode}
          </span>
        </div>

        {fulfillment ? (
          <div className="flex items-center gap-2.5 rounded-lg bg-muted/40 px-3 py-2.5">
            <Truck className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs">
                {fulfillment.trackingCompany ?? "Carrier unknown"}
                {fulfillment.deliveredAt
                  ? ` · Delivered ${fulfillmentDay(fulfillment.deliveredAt)}`
                  : fulfillment.estimatedDeliveryAt
                    ? ` · ETA ${fulfillmentDay(fulfillment.estimatedDeliveryAt)}`
                    : ""}
              </div>
              {fulfillment.trackingNumbers.length > 0 ? (
                <div className="truncate font-mono text-[11px] text-muted-foreground">
                  {fulfillment.trackingUrls[0] ? (
                    <a
                      href={fulfillment.trackingUrls[0]}
                      target="_blank"
                      rel="noreferrer"
                      className="text-primary hover:underline"
                    >
                      {fulfillment.trackingNumbers[0]}
                    </a>
                  ) : (
                    fulfillment.trackingNumbers[0]
                  )}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
};
