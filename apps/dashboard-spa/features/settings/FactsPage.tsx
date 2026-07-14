import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { RotateCcw, Store as StoreIcon, Truck } from "lucide-react";

import { api } from "@/lib/api-client";
import { qk } from "@/lib/query-keys";
import { useWorkspaceCtx } from "@/lib/session-context";
import { useRequirePermission } from "@/lib/require-permission";
import {
  trimmedFormValuesDirty,
  useDirtyFlags,
  useReportDirty,
  type ReportDirty,
} from "@/lib/unsaved-changes";
import { UnsavedChangesPrompt } from "@/components/unsaved-changes-prompt";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { SettingsBreadcrumb } from "@/components/settings-breadcrumb";
import type {
  CustomsDutiesPayerView,
  RefundMethodView,
  ReturnShippingPayerView,
  ReturnsFactsView,
  ShippingFactsView,
} from "@support-agent/dashboard-contracts";

type Ctx = { readonly workspaceId: string };

// Fields sit in two-column rows that TOP-align (`items-start`) rather than
// stretching: a field with a hint under it must not pad out the height of the
// field beside it.
const row = "grid gap-4 sm:grid-cols-2 sm:items-start";
const field = "grid gap-2";
const hint = "text-xs text-muted-foreground";

// Saving a fact changes what every `@`-reference chip in the scenario notes
// renders, so the catalog (which carries the tenant's current values) has to be
// refetched alongside the settings themselves.
const invalidateFacts = (
  qc: ReturnType<typeof useQueryClient>,
  workspaceId: string,
) => {
  void qc.invalidateQueries({ queryKey: qk.settings(workspaceId) });
  void qc.invalidateQueries({ queryKey: qk.factReferences(workspaceId) });
};

/**
 * "The store can update the shipping address after fulfillment" — a
 * merchant-declared capability, stated literally. When on, the agent's
 * fulfilled-order refusal for address updates steps aside. Mutates on change
 * (no Save button) and invalidates settings in place — same pattern as the
 * restock toggle on the refund-policy page. Saves through its own endpoint,
 * independent of the shipping form: it must work even when the delivery
 * times above were never filled in.
 */
/**
 * The name the agent signs its replies with, referenceable in a playbook as
 * `@store.brand_name`. Read from Shopify during setup and confirmed by the
 * merchant, because a store's legal name is often not the one its customers
 * know. Left blank, the agent simply never claims a name.
 */
function BrandNameForm({
  brandName,
  ctx,
  reportDirty,
}: {
  readonly brandName: string | null;
  readonly ctx: Ctx;
  readonly reportDirty: ReportDirty;
}) {
  const qc = useQueryClient();
  const [value, setValue] = useState(brandName ?? "");

  const saved = brandName ?? "";
  useReportDirty(reportDirty, "brand", value.trim() !== saved.trim());

  const save = useMutation({
    mutationFn: (next: string) => api.setBrandName(ctx, next),
    onSuccess: (res) => {
      if (res.status !== 200) {
        toast.warning("Something went wrong. Please try again.");
        return;
      }
      invalidateFacts(qc, ctx.workspaceId);
      toast.success("Store name saved.");
    },
    onError: () => toast.warning("Something went wrong. Please try again."),
  });

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    save.mutate(value.trim());
  };

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="grid gap-1.5">
        <Label htmlFor="brandName">Store name</Label>
        <Input
          id="brandName"
          name="brandName"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          maxLength={120}
          placeholder="e.g. Elva Labs"
        />
        <p className={hint}>
          The name your agent writes under. Reference it in a playbook with{" "}
          <span className="font-mono">@store.brand_name</span>.
        </p>
      </div>
      <Button
        type="submit"
        size="sm"
        disabled={save.isPending || value.trim().length === 0}
      >
        {save.isPending ? "Saving…" : "Save store name"}
      </Button>
    </form>
  );
}

function AddressUpdateAfterFulfillmentToggle({
  enabled,
  ctx,
}: {
  readonly enabled: boolean;
  readonly ctx: Ctx;
}) {
  const qc = useQueryClient();
  const [checked, setChecked] = useState(enabled);

  const toggle = useMutation({
    mutationFn: (next: boolean) =>
      api.setAddressUpdateAfterFulfillment(ctx, next),
    onSuccess: (res) => {
      if (res.status !== 200) {
        setChecked((prev) => !prev);
        toast.warning("Something went wrong. Please try again.");
        return;
      }
      invalidateFacts(qc, ctx.workspaceId);
    },
    onError: () => {
      // Revert the optimistic flip so the checkbox reflects the stored value.
      setChecked((prev) => !prev);
      toast.warning("Something went wrong. Please try again.");
    },
  });

  return (
    <div className="border-t pt-4">
      <label className="flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          name="addressUpdateAfterFulfillment"
          checked={checked}
          onChange={(e) => {
            const next = e.currentTarget.checked;
            setChecked(next);
            toggle.mutate(next);
          }}
          className="mt-0.5 size-4 rounded border-input accent-primary"
        />
        <span className="grid gap-1">
          <span className="text-sm font-medium">
            This store can update an order&rsquo;s shipping address after
            fulfillment
          </span>
          <span className={hint}>
            When off, the agent refuses address changes once an order has
            shipped. When on, it may still update the address on a fulfilled
            order; the agent asks for approval as usual.
          </span>
        </span>
      </label>
    </div>
  );
}

function CancellationAfterFulfillmentToggle({
  enabled,
  ctx,
}: {
  readonly enabled: boolean;
  readonly ctx: Ctx;
}) {
  const qc = useQueryClient();
  const [checked, setChecked] = useState(enabled);
  const toggle = useMutation({
    mutationFn: (next: boolean) =>
      api.setCancellationAfterFulfillment(ctx, next),
    onSuccess: (res) => {
      if (res.status !== 200) {
        setChecked((prev) => !prev);
        toast.warning("Something went wrong. Please try again.");
        return;
      }
      invalidateFacts(qc, ctx.workspaceId);
    },
    onError: () => {
      setChecked((prev) => !prev);
      toast.warning("Something went wrong. Please try again.");
    },
  });

  return (
    <div className="border-t pt-4">
      <label className="flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          name="cancellationAfterFulfillment"
          checked={checked}
          onChange={(e) => {
            const next = e.currentTarget.checked;
            setChecked(next);
            toggle.mutate(next);
          }}
          className="mt-0.5 size-4 rounded border-input accent-primary"
        />
        <span className="grid gap-1">
          <span className="text-sm font-medium">
            This store can cancel an order after fulfillment
          </span>
          <span className={hint}>
            When off, the agent refuses cancellation once an order has shipped.
            When on, it may still cancel and refund a fulfilled order; approval
            and refund thresholds still apply.
          </span>
        </span>
      </label>
    </div>
  );
}

// The store's structured shipping facts. These are not prose the agent reads —
// they're numbers it acts on. The delivery time is the window lateness is judged
// against, and the delay threshold is the exact point past which the agent opens
// a fulfillment partner check, so both travel to the agent directly rather than through
// search.
function ShippingFactsForm({
  profile,
  ctx,
  reportDirty,
}: {
  readonly profile: ShippingFactsView | null;
  readonly ctx: Ctx;
  readonly reportDirty: ReportDirty;
}) {
  const qc = useQueryClient();
  const [processingTime, setProcessingTime] = useState(
    profile?.processingTime ?? "",
  );
  const [deliveryTime, setDeliveryTime] = useState(profile?.deliveryTime ?? "");
  const [shippingCost, setShippingCost] = useState(profile?.shippingCost ?? "");
  const [customsDuties, setCustomsDuties] = useState<string>(
    profile?.customsDuties ?? "",
  );
  const [delayedAfterDays, setDelayedAfterDays] = useState(
    profile ? String(profile.delayedAfterDays) : "",
  );
  const [lostPackageInvestigationDays, setLostPackageInvestigationDays] =
    useState(
      profile?.lostPackageInvestigationDays != null
        ? String(profile.lostPackageInvestigationDays)
        : "",
    );
  const [error, setError] = useState<string | null>(null);

  const values = {
    processingTime,
    deliveryTime,
    shippingCost,
    customsDuties,
    delayedAfterDays,
    lostPackageInvestigationDays,
  };
  const [saved, setSaved] = useState(values);
  useReportDirty(
    reportDirty,
    "facts:shipping",
    trimmedFormValuesDirty(saved, values),
  );

  const save = useMutation({
    mutationFn: (input: {
      readonly processingTime: string;
      readonly deliveryTime: string;
      readonly shippingCost: string | null;
      readonly customsDuties: CustomsDutiesPayerView | null;
      readonly delayedAfterDays: number;
      readonly lostPackageInvestigationDays: number | null;
    }) => api.setShippingFacts(ctx, input),
    onSuccess: (res) => {
      if (res.status !== 200) {
        setError("Something went wrong. Please check the fields and try again.");
        return;
      }
      setError(null);
      setSaved(values);
      toast.success("Shipping details saved.");
      invalidateFacts(qc, ctx.workspaceId);
    },
    onError: () => toast.warning("Something went wrong. Please try again."),
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!processingTime.trim()) {
      setError("Tell us how long orders take to leave your warehouse.");
      return;
    }
    if (!deliveryTime.trim()) {
      setError("Tell us how long delivery usually takes after shipment.");
      return;
    }
    const days = Number(delayedAfterDays.trim());
    if (!Number.isInteger(days) || days < 1) {
      setError("Enter a whole number of days, 1 or more.");
      return;
    }
    // Optional second threshold: blank clears it; a filled value must be sane.
    let lostDays: number | null = null;
    const lostRaw = lostPackageInvestigationDays.trim();
    if (lostRaw !== "") {
      const parsed = Number(lostRaw);
      if (!Number.isInteger(parsed) || parsed < 1) {
        setError(
          "Enter a whole number of days, 1 or more, for when to make the customer whole (or leave it blank).",
        );
        return;
      }
      lostDays = parsed;
    }
    setError(null);
    save.mutate({
      processingTime: processingTime.trim(),
      deliveryTime: deliveryTime.trim(),
      shippingCost: shippingCost.trim() || null,
      customsDuties: (customsDuties || null) as CustomsDutiesPayerView | null,
      delayedAfterDays: days,
      lostPackageInvestigationDays: lostDays,
    });
  };

  const pending = save.isPending;

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className={row}>
        <div className={field}>
          <Label htmlFor="processingTime">Order processing time</Label>
          <Input
            id="processingTime"
            placeholder="1–2 business days"
            required
            disabled={pending}
            aria-describedby="processing-hint"
            value={processingTime}
            onChange={(e) => setProcessingTime(e.currentTarget.value)}
          />
          <p id="processing-hint" className={hint}>
            How long an order takes to leave your warehouse.
          </p>
        </div>
        <div className={field}>
          <Label htmlFor="deliveryTime">Delivery time</Label>
          <Input
            id="deliveryTime"
            placeholder="7–12 days"
            required
            disabled={pending}
            aria-describedby="delivery-hint"
            value={deliveryTime}
            onChange={(e) => setDeliveryTime(e.currentTarget.value)}
          />
          <p id="delivery-hint" className={hint}>
            Average time from shipment to delivery.
          </p>
        </div>
      </div>

      <div className={row}>
        <div className={field}>
          <Label htmlFor="shippingCost">
            Shipping cost &amp; free-shipping threshold
          </Label>
          <Input
            id="shippingCost"
            placeholder="$4.95, free over $50"
            disabled={pending}
            aria-describedby="cost-hint"
            value={shippingCost}
            onChange={(e) => setShippingCost(e.currentTarget.value)}
          />
          <p id="cost-hint" className={hint}>
            Optional.
          </p>
        </div>
        <div className={field}>
          <Label htmlFor="customsDuties">
            Customs / import duties: who pays?
          </Label>
          <NativeSelect
            id="customsDuties"
            disabled={pending}
            value={customsDuties}
            onChange={(e) => setCustomsDuties(e.currentTarget.value)}
            aria-describedby="customs-hint"
          >
            <option value="">Not specified</option>
            <option value="customer">The customer pays</option>
            <option value="merchant">We pay</option>
            <option value="not_applicable">Doesn&apos;t apply</option>
          </NativeSelect>
          <p id="customs-hint" className={hint}>
            Optional.
          </p>
        </div>
      </div>

      <div className={row}>
        <div className={field}>
          <Label htmlFor="delayedAfterDays">Treat a shipment as delayed after</Label>
          <Input
            id="delayedAfterDays"
            type="number"
            inputMode="numeric"
            min={1}
            placeholder="14"
            required
            disabled={pending}
            aria-describedby="delay-hint"
            value={delayedAfterDays}
            onChange={(e) => setDelayedAfterDays(e.currentTarget.value)}
          />
          <p id="delay-hint" className={hint}>
            Days in transit. Past this point your agents open a fulfillment partner check
            instead of telling the customer the order is on schedule.
          </p>
        </div>
        <div className={field}>
          <Label htmlFor="lostPackageInvestigationDays">
            Treat a package as lost after
          </Label>
          <Input
            id="lostPackageInvestigationDays"
            type="number"
            inputMode="numeric"
            min={1}
            placeholder="30"
            disabled={pending}
            aria-describedby="lost-hint"
            value={lostPackageInvestigationDays}
            onChange={(e) =>
              setLostPackageInvestigationDays(e.currentTarget.value)
            }
          />
          <p id="lost-hint" className={hint}>
            Days in transit. Past this point your agents stop waiting and make
            the customer whole: a refund or reshipment. Optional; leave blank if
            you handle this case by case.
          </p>
        </div>
      </div>

      {error ? (
        <Alert variant="warning">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Save shipping facts"}
      </Button>
    </form>
  );
}

// The store's structured returns facts. Like the shipping facts, the return
// window is a number the agent branches on (in-policy vs not) rather than prose
// it reads, and the payer / method / processing-time are values it quotes to the
// customer — so they travel to the agent directly instead of through search.
function ReturnsFactsForm({
  facts,
  ctx,
  reportDirty,
}: {
  readonly facts: ReturnsFactsView | null;
  readonly ctx: Ctx;
  readonly reportDirty: ReportDirty;
}) {
  const qc = useQueryClient();
  const [returnWindowDays, setReturnWindowDays] = useState(
    facts ? String(facts.returnWindowDays) : "",
  );
  const [returnShippingPayer, setReturnShippingPayer] = useState<string>(
    facts?.returnShippingPayer ?? "",
  );
  const [refundMethod, setRefundMethod] = useState<string>(
    facts?.refundMethod ?? "",
  );
  const [refundProcessingTime, setRefundProcessingTime] = useState(
    facts?.refundProcessingTime ?? "",
  );
  const [error, setError] = useState<string | null>(null);

  const values = {
    returnWindowDays,
    returnShippingPayer,
    refundMethod,
    refundProcessingTime,
  };
  const [saved, setSaved] = useState(values);
  useReportDirty(
    reportDirty,
    "facts:returns",
    trimmedFormValuesDirty(saved, values),
  );

  const save = useMutation({
    mutationFn: (input: {
      readonly returnWindowDays: number;
      readonly returnShippingPayer: ReturnShippingPayerView | null;
      readonly refundMethod: RefundMethodView | null;
      readonly refundProcessingTime: string | null;
    }) => api.setReturnsFacts(ctx, input),
    onSuccess: (res) => {
      if (res.status !== 200) {
        setError("Something went wrong. Please check the fields and try again.");
        return;
      }
      setError(null);
      setSaved(values);
      toast.success("Returns details saved.");
      invalidateFacts(qc, ctx.workspaceId);
    },
    onError: () => toast.warning("Something went wrong. Please try again."),
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const days = Number(returnWindowDays.trim());
    if (!Number.isInteger(days) || days < 1) {
      setError("Enter a whole number of days, 1 or more, for your return window.");
      return;
    }
    setError(null);
    save.mutate({
      returnWindowDays: days,
      returnShippingPayer:
        (returnShippingPayer || null) as ReturnShippingPayerView | null,
      refundMethod: (refundMethod || null) as RefundMethodView | null,
      refundProcessingTime: refundProcessingTime.trim() || null,
    });
  };

  const pending = save.isPending;

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className={row}>
        <div className={field}>
          <Label htmlFor="returnWindowDays">Return window</Label>
          <Input
            id="returnWindowDays"
            type="number"
            inputMode="numeric"
            min={1}
            placeholder="30"
            required
            disabled={pending}
            aria-describedby="return-window-hint"
            value={returnWindowDays}
            onChange={(e) => setReturnWindowDays(e.currentTarget.value)}
          />
          <p id="return-window-hint" className={hint}>
            Days after delivery a customer can still return an item. Your agents
            use it to tell an in-policy return from a late one.
          </p>
        </div>
        <div className={field}>
          <Label htmlFor="returnShippingPayer">
            Return shipping: who pays?
          </Label>
          <NativeSelect
            id="returnShippingPayer"
            disabled={pending}
            value={returnShippingPayer}
            onChange={(e) => setReturnShippingPayer(e.currentTarget.value)}
            aria-describedby="return-shipping-hint"
          >
            <option value="">Not specified</option>
            <option value="customer">The customer pays</option>
            <option value="merchant">We pay (free returns)</option>
            <option value="depends">It depends</option>
          </NativeSelect>
          <p id="return-shipping-hint" className={hint}>
            Optional.
          </p>
        </div>
      </div>

      <div className={row}>
        <div className={field}>
          <Label htmlFor="refundMethod">How are refunds issued?</Label>
          <NativeSelect
            id="refundMethod"
            disabled={pending}
            value={refundMethod}
            onChange={(e) => setRefundMethod(e.currentTarget.value)}
            aria-describedby="refund-method-hint"
          >
            <option value="">Not specified</option>
            <option value="original">To the original payment method</option>
            <option value="store_credit">As store credit</option>
            <option value="customer_choice">The customer chooses</option>
          </NativeSelect>
          <p id="refund-method-hint" className={hint}>
            Optional.
          </p>
        </div>
        <div className={field}>
          <Label htmlFor="refundProcessingTime">Refund processing time</Label>
          <Input
            id="refundProcessingTime"
            placeholder="5–7 business days after we receive the item"
            disabled={pending}
            aria-describedby="refund-time-hint"
            value={refundProcessingTime}
            onChange={(e) => setRefundProcessingTime(e.currentTarget.value)}
          />
          <p id="refund-time-hint" className={hint}>
            What your agents tell a customer to expect once a refund is started.
          </p>
        </div>
      </div>

      {error ? (
        <Alert variant="warning">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Save returns facts"}
      </Button>
    </form>
  );
}

/**
 * Store facts — the structured half of the knowledge base. Docs are prose the
 * agent searches; these are the values it quotes and branches on, so they reach
 * it directly, and a scenario playbook can reference them by name (`@`) instead
 * of restating them.
 */
export function FactsPage() {
  const allowed = useRequirePermission("knowledge.view");
  const ctx = useWorkspaceCtx();

  // Shipping and returns save separately; either one holding unsaved edits
  // should stop the merchant walking away from the page.
  const { dirty, reportDirty } = useDirtyFlags();

  const settingsQuery = useQuery({
    queryKey: qk.settings(ctx.workspaceId),
    queryFn: () => api.settings(ctx),
    enabled: allowed,
  });

  if (!allowed) return null;

  return (
    <div className="space-y-6">
      <UnsavedChangesPrompt
        dirty={dirty}
        description="Your store facts haven't been saved yet. Leave this page and you'll lose them."
      />

      <SettingsBreadcrumb current="Facts" />

      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Store facts</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          The numbers and choices your agents quote to customers and act on: how
          long delivery takes, when an order counts as late, how long a customer
          has to return an item. Fill them in once here and reference them from a
          scenario playbook with <span className="font-mono">@</span>, so a
          change lands everywhere at once.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <StoreIcon className="size-4" aria-hidden />
            Your store
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 pt-0">
          {settingsQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <BrandNameForm
              // Remount when the saved name arrives so the input picks up its
              // stored value instead of keeping its initial "".
              key={settingsQuery.data?.brandName ? "loaded" : "empty"}
              brandName={settingsQuery.data?.brandName ?? null}
              ctx={ctx}
              reportDirty={reportDirty}
            />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Truck className="size-4" aria-hidden />
            Shipping &amp; delivery
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 pt-0">
          <p className="text-sm text-muted-foreground">
            These are the difference between an agent that says &ldquo;your order
            is on the way&rdquo; and one that notices it has been stuck for two
            weeks.
          </p>
          {settingsQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <>
              <ShippingFactsForm
                // Remount when the saved profile arrives so the inputs pick up
                // their stored values instead of keeping their initial "".
                key={settingsQuery.data?.shippingFacts ? "loaded" : "empty"}
                profile={settingsQuery.data?.shippingFacts ?? null}
                ctx={ctx}
                reportDirty={reportDirty}
              />
              <AddressUpdateAfterFulfillmentToggle
                // Remount when the saved value arrives, same as the form.
                key={`capability-${String(
                  settingsQuery.data?.addressUpdateAfterFulfillment ?? false,
                )}`}
                enabled={
                  settingsQuery.data?.addressUpdateAfterFulfillment ?? false
                }
                ctx={ctx}
              />
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <RotateCcw className="size-4" aria-hidden />
            Returns &amp; refunds
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 pt-0">
          <p className="text-sm text-muted-foreground">
            Your agents quote these when a customer wants to return an item or
            asks for a refund, instead of guessing from your documents.
          </p>
          {settingsQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <>
              <ReturnsFactsForm
                // Remount when the saved facts arrive so the inputs pick up their
                // stored values instead of keeping their initial "".
                key={settingsQuery.data?.returnsFacts ? "loaded" : "empty"}
                facts={settingsQuery.data?.returnsFacts ?? null}
                ctx={ctx}
                reportDirty={reportDirty}
              />
              <CancellationAfterFulfillmentToggle
                key={`cancel-capability-${String(
                  settingsQuery.data?.cancellationAfterFulfillment ?? false,
                )}`}
                enabled={
                  settingsQuery.data?.cancellationAfterFulfillment ?? false
                }
                ctx={ctx}
              />
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
