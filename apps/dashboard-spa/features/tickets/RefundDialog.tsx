import * as React from "react";
import { Loader2, RotateCcw } from "lucide-react";

import type {
  ShopifyOrderRefundContext,
  ShopifyRefundLineItem,
} from "@support-agent/agent-core";
import { api, type RefundContextOutcome } from "@/lib/api-client";
import { useTicketMutation } from "@/lib/use-ticket-mutation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { NativeSelect } from "@/components/ui/native-select";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";

import {
  buildRefundLineItems,
  clampQuantity,
  computeRefundTotals,
  defaultSelections,
  money2,
  validateRefundAmount,
  type RefundSelections,
} from "@/lib/refund-dialog-data";

interface Props {
  readonly workspaceId: string;
  readonly ticketId: string;
  /** The order name (e.g. "#1001") for the trigger + title before context loads. */
  readonly orderName: string;
}

const toNum = (s: string): number => {
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : 0;
};

/**
 * The ticket-page "Refund" button + a modal mirroring Shopify admin's refund page:
 * the order's refundable line items (image, price, quantity), per-line restocking
 * with a location, a live summary, an editable refund amount capped at what
 * Shopify allows, and a staff-only reason. The heavy Shopify pricing fetch is
 * lazy (only on open). Submitting issues the refund through api.issueRefund
 * (Shopify refundCreate, restocking returned units). SPA port of the Next
 * dialog: loadContext/issueAction server actions → api + useMutation.
 */
export function RefundDialog({ workspaceId, ticketId, orderName }: Props) {
  const [open, setOpen] = React.useState(false);
  const [outcome, setOutcome] = React.useState<RefundContextOutcome | null>(
    null,
  );
  const [loading, setLoading] = React.useState(false);

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next && outcome === null && !loading) {
      setLoading(true);
      void api
        .refundContext({ workspaceId }, ticketId)
        .then(setOutcome)
        .catch(() => setOutcome({ kind: "error" }))
        .finally(() => setLoading(false));
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogTrigger asChild>
        <Button variant="outline" title="Refund this order in Shopify">
          Refund
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent className="max-w-3xl gap-0 p-0">
        <AlertDialogTitle className="sr-only">
          Refund order {orderName}
        </AlertDialogTitle>
        <AlertDialogDescription className="sr-only">
          Choose the items and amount to refund to the customer.
        </AlertDialogDescription>
        {loading || outcome === null ? (
          <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-hidden />
            Loading refund details for {orderName}…
          </div>
        ) : outcome.kind === "ok" ? (
          <RefundForm
            workspaceId={workspaceId}
            ticketId={ticketId}
            context={outcome.context}
            onDone={() => setOpen(false)}
          />
        ) : (
          <RefundUnavailable
            kind={outcome.kind}
            onClose={() => setOpen(false)}
          />
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}

const UNAVAILABLE_COPY: Record<string, string> = {
  order_not_found:
    "No Shopify order is linked to this ticket, so there's nothing to refund here. Open the order in Shopify to refund it there.",
  context_unavailable:
    "Shopify couldn't return the refund details for this order. Try again, or issue the refund in Shopify.",
  ticket_not_found: "This ticket could no longer be found.",
  error: "Something went wrong loading the refund details. Please try again.",
};

const RefundUnavailable = ({
  kind,
  onClose,
}: {
  readonly kind: string;
  readonly onClose: () => void;
}) => (
  <div className="space-y-4 p-6">
    <div className="text-base font-semibold">Refund unavailable</div>
    <p className="text-pretty text-sm text-muted-foreground">
      {UNAVAILABLE_COPY[kind] ?? UNAVAILABLE_COPY["error"]}
    </p>
    <div className="flex justify-end">
      <Button type="button" variant="outline" onClick={onClose}>
        Close
      </Button>
    </div>
  </div>
);

const RefundForm = ({
  workspaceId,
  ticketId,
  context,
  onDone,
}: {
  readonly workspaceId: string;
  readonly ticketId: string;
  readonly context: ShopifyOrderRefundContext;
  readonly onDone: () => void;
}) => {
  const { currencyCode, lineItems, locations } = context;
  const shippingRefundable = toNum(context.shippingRefundable.amount);

  const [selections, setSelections] = React.useState<RefundSelections>(() =>
    defaultSelections(lineItems),
  );
  const [refundShipping, setRefundShipping] = React.useState(
    shippingRefundable > 0,
  );
  const [locationId, setLocationId] = React.useState<string | null>(
    lineItems.find((li) => li.restockLocationId)?.restockLocationId ??
      locations[0]?.id ??
      null,
  );
  const [amount, setAmount] = React.useState(
    money2(toNum(context.maximumRefundable.amount)),
  );
  const [amountTouched, setAmountTouched] = React.useState(false);
  const [reason, setReason] = React.useState("");

  const totals = computeRefundTotals({
    lineItems,
    selections,
    refundShipping,
    shippingRefundable: context.shippingRefundable.amount,
  });
  const maxRefundable = toNum(context.maximumRefundable.amount);

  // Auto-sync the refund amount to the suggested total until the operator types
  // their own amount (Shopify behaves the same).
  const suggested = Math.min(totals.refundTotal, maxRefundable);
  React.useEffect(() => {
    if (!amountTouched) setAmount(money2(suggested));
  }, [suggested, amountTouched]);

  const setQuantity = (li: ShopifyRefundLineItem, raw: number) =>
    setSelections((prev) => ({
      ...prev,
      [li.lineItemId]: {
        quantity: clampQuantity(raw, li.refundableQuantity),
        restock: prev[li.lineItemId]?.restock ?? li.restockable,
      },
    }));

  const setRestock = (li: ShopifyRefundLineItem, restock: boolean) =>
    setSelections((prev) => ({
      ...prev,
      [li.lineItemId]: {
        quantity: prev[li.lineItemId]?.quantity ?? li.refundableQuantity,
        restock,
      },
    }));

  const anyRestocking = lineItems.some(
    (li) =>
      li.restockable &&
      (selections[li.lineItemId]?.restock ?? false) &&
      (selections[li.lineItemId]?.quantity ?? 0) > 0,
  );

  const validation = validateRefundAmount(
    amount,
    context.maximumRefundable.amount,
  );
  const fmt = (n: number) => `${money2(n)} ${currencyCode}`;

  const lineItemsPayload = buildRefundLineItems({
    lineItems,
    selections,
    locationId: anyRestocking ? locationId : null,
  });

  const issueM = useTicketMutation({
    workspaceId,
    ticketId,
    action: "issueRefund",
    mutationFn: () =>
      api.issueRefund(
        { workspaceId },
        ticketId,
        {
          amount: validation.ok ? validation.amount : "",
          currencyCode,
        },
        {
          reason: reason.trim() ? reason.trim() : null,
          lineItems: lineItemsPayload,
          shipping:
            refundShipping && shippingRefundable > 0
              ? {
                  amount: context.shippingRefundable.amount,
                  currencyCode,
                }
              : null,
        },
      ),
    onDone: (kind) => {
      if (kind === "issued") onDone();
    },
  });

  const unfulfilled = lineItems.filter((li) => !li.fulfilled);
  const fulfilled = lineItems.filter((li) => li.fulfilled);

  return (
    <div className="flex max-h-[85vh] flex-col">
      <div className="border-b border-border px-6 py-4">
        <h2 className="text-base font-semibold">Refund {context.orderName}</h2>
        <p className="text-pretty text-xs text-muted-foreground">
          Money is refunded to the customer&apos;s original payment method.
          Shopify emails them the confirmation. This can&apos;t be undone here.
        </p>
      </div>

      <div className="grid gap-6 overflow-y-auto px-6 py-5 md:grid-cols-[1fr_18rem]">
        {/* Line items */}
        <div className="space-y-5">
          {unfulfilled.length > 0 ? (
            <LineGroup
              title="Unfulfilled"
              tone="warning"
              lines={unfulfilled}
              selections={selections}
              currencyCode={currencyCode}
              onQuantity={setQuantity}
              onRestock={setRestock}
            />
          ) : null}
          {fulfilled.length > 0 ? (
            <LineGroup
              title="Fulfilled"
              tone="success"
              lines={fulfilled}
              selections={selections}
              currencyCode={currencyCode}
              onQuantity={setQuantity}
              onRestock={setRestock}
            />
          ) : null}

          {anyRestocking && locations.length > 0 ? (
            <div className="space-y-1.5">
              <Label htmlFor="restock-location">Restock location</Label>
              <NativeSelect
                id="restock-location"
                value={locationId ?? ""}
                onChange={(e) => setLocationId(e.target.value || null)}
              >
                {locations.map((loc) => (
                  <option key={loc.id} value={loc.id}>
                    {loc.name}
                  </option>
                ))}
              </NativeSelect>
            </div>
          ) : null}

          <div className="space-y-1.5">
            <Label htmlFor="refund-reason">
              Reason for refund{" "}
              <span className="font-normal text-muted-foreground">
                (optional)
              </span>
            </Label>
            <Textarea
              id="refund-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Only you and other staff can see this reason"
              className="min-h-18"
            />
          </div>
        </div>

        {/* Summary */}
        <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-4">
          <div className="text-sm font-semibold">Summary</div>
          <dl className="space-y-1.5 text-sm tabular-nums">
            <div className="flex justify-between">
              <dt className="text-muted-foreground">
                Items subtotal ({totals.itemsCount})
              </dt>
              <dd>{fmt(totals.itemsSubtotal)}</dd>
            </div>
            {totals.tax > 0 ? (
              <div className="flex justify-between">
                <dt className="text-muted-foreground">Tax</dt>
                <dd>{fmt(totals.tax)}</dd>
              </div>
            ) : null}
            {shippingRefundable > 0 ? (
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">
                  <label className="-my-2 flex items-center gap-2 py-2">
                    <input
                      type="checkbox"
                      className="size-4 rounded border-input"
                      checked={refundShipping}
                      onChange={(e) => setRefundShipping(e.target.checked)}
                    />
                    Refund shipping
                  </label>
                </dt>
                <dd>{fmt(refundShipping ? shippingRefundable : 0)}</dd>
              </div>
            ) : null}
            <div className="flex justify-between border-t border-border pt-1.5 font-semibold">
              <dt>Refund total</dt>
              <dd>{fmt(totals.refundTotal)}</dd>
            </div>
          </dl>

          <div className="space-y-1.5 border-t border-border pt-3">
            <Label htmlFor="refund-amount">Refund amount</Label>
            {context.paymentGateway ? (
              <p className="text-xs text-muted-foreground">
                {context.paymentGateway}
              </p>
            ) : null}
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                {currencyCode}
              </span>
              <Input
                id="refund-amount"
                inputMode="decimal"
                value={amount}
                onChange={(e) => {
                  setAmountTouched(true);
                  setAmount(e.target.value);
                }}
                className={cn("pl-12 tabular-nums", amountTouched && "pr-9")}
              />
              {amountTouched ? (
                <button
                  type="button"
                  title="Reset to the suggested amount"
                  aria-label="Reset to the suggested amount"
                  onClick={() => setAmountTouched(false)}
                  className="absolute right-0.5 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground"
                >
                  <RotateCcw className="size-3.5" aria-hidden />
                </button>
              ) : null}
            </div>
            <p
              className={cn(
                "text-xs",
                validation.ok ? "text-muted-foreground" : "text-destructive",
              )}
            >
              {validation.ok
                ? `${fmt(maxRefundable)} available for refund`
                : validation.reason === "exceeds_max"
                  ? `Can't exceed ${fmt(maxRefundable)} available.`
                  : validation.reason === "empty"
                    ? "Enter a refund amount."
                    : "Enter a valid amount."}
            </p>
          </div>

          <Button
            type="button"
            className="w-full tabular-nums"
            disabled={!validation.ok || issueM.isPending}
            onClick={() => issueM.mutate()}
          >
            {issueM.isPending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : null}
            {issueM.isPending
              ? "Refunding…"
              : validation.ok
                ? `Refund ${validation.amount} ${currencyCode}`
                : "Refund"}
          </Button>
        </div>
      </div>

      <div className="flex justify-end border-t border-border px-6 py-3">
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </div>
  );
};

const LineGroup = ({
  title,
  tone,
  lines,
  selections,
  currencyCode,
  onQuantity,
  onRestock,
}: {
  readonly title: string;
  readonly tone: "warning" | "success";
  readonly lines: ReadonlyArray<ShopifyRefundLineItem>;
  readonly selections: RefundSelections;
  readonly currencyCode: string;
  readonly onQuantity: (li: ShopifyRefundLineItem, raw: number) => void;
  readonly onRestock: (li: ShopifyRefundLineItem, restock: boolean) => void;
}) => (
  <div className="rounded-lg border border-border">
    <div className="border-b border-border px-3 py-2">
      <Badge variant={tone}>{title}</Badge>
    </div>
    <ul className="divide-y divide-border">
      {lines.map((li) => {
        const sel = selections[li.lineItemId];
        const qty = sel?.quantity ?? 0;
        const unit = toNum(li.unitPrice.amount);
        return (
          <li key={li.lineItemId} className="space-y-2 px-3 py-3">
            <div className="flex items-start gap-3">
              {li.imageUrl ? (
                <img
                  src={li.imageUrl}
                  alt=""
                  className="size-10 shrink-0 rounded object-cover outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10"
                />
              ) : (
                <div className="size-10 shrink-0 rounded border border-border bg-muted" />
              )}
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{li.title}</div>
                {li.variantTitle ? (
                  <div className="text-xs text-muted-foreground">
                    {li.variantTitle}
                  </div>
                ) : null}
                {li.sku ? (
                  <div className="font-mono text-xs text-muted-foreground">
                    {li.sku}
                  </div>
                ) : null}
              </div>
              <div className="text-right text-sm tabular-nums">
                <div className="text-muted-foreground">
                  {money2(unit)} {currencyCode}
                </div>
                <div className="font-medium">
                  {money2(unit * qty)} {currencyCode}
                </div>
              </div>
            </div>
            <div className="flex items-center justify-between pl-[52px]">
              <label className="-my-2 flex items-center gap-2 py-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  className="size-4 rounded border-input disabled:opacity-50"
                  checked={(sel?.restock ?? false) && li.restockable}
                  disabled={!li.restockable}
                  onChange={(e) => onRestock(li, e.target.checked)}
                />
                {li.restockable ? "Restock" : "Not restockable"}
              </label>
              <div className="flex items-center gap-1.5 text-sm">
                <Input
                  type="number"
                  min={0}
                  max={li.refundableQuantity}
                  value={qty}
                  onChange={(e) => onQuantity(li, Number(e.target.value))}
                  className="h-8 w-16 text-right tabular-nums"
                  aria-label={`Refund quantity for ${li.title}`}
                />
                <span className="text-muted-foreground">
                  / {li.refundableQuantity}
                </span>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  </div>
);
