import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, Banknote, HandCoins, SlidersHorizontal, XCircle } from "lucide-react";
import { toast } from "sonner";

import type {
  RefundPolicyMode,
  RefundPolicyView,
} from "@support-agent/dashboard-contracts";

import { api } from "@/lib/api-client";
import { qk } from "@/lib/query-keys";
import { useWorkspaceCtx } from "@/lib/session-context";
import { useRequirePermission } from "@/lib/require-permission";
import { cn } from "@/lib/utils";
import { refundCurrencyMismatch } from "@/lib/refund-currency";
import { resolveRefundThresholds } from "@/lib/parse-thresholds";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { SettingsBreadcrumb } from "@/components/settings-breadcrumb";

const minorToMajor = (minor: number): string => (minor / 100).toFixed(2);

// The Next actions surfaced these via post-redirect-get feedback rules; here we
// toast the identical strings directly from the client-side validation guards
// (the same checks the server action ran before persisting).
const BAD_CURRENCY_MSG =
  "Currency must be a 3-letter ISO code (USD, EUR, GBP, …).";
const BAD_AMOUNT_MSG =
  "Both thresholds must be non-negative decimals with at most two digits after the decimal point.";
const BAD_ORDER_MSG = "The ask threshold must not exceed the deny threshold.";

// The refund-policy control is a client component because the mode selector
// toggles the threshold inputs between active and disabled in the browser. In
// the non-threshold modes the (controlled) values are retained so switching to
// always-ask / always-deny and saving still preserves the merchant's
// thresholds for when they switch back.
function RefundPolicyForm({ policy }: { policy: RefundPolicyView }) {
  const ctx = useWorkspaceCtx();
  const qc = useQueryClient();

  const [mode, setMode] = useState<RefundPolicyMode>(policy.mode);
  const [currencyCode, setCurrencyCode] = useState(policy.currencyCode);
  const [askAbove, setAskAbove] = useState(
    minorToMajor(policy.askAboveMinorUnits),
  );
  const [denyAbove, setDenyAbove] = useState(
    minorToMajor(policy.denyAboveMinorUnits),
  );

  const thresholdsActive = mode === "thresholds";

  const save = useMutation({
    mutationFn: (input: {
      readonly currencyCode: string;
      readonly askAboveMinorUnits: number;
      readonly denyAboveMinorUnits: number;
      readonly mode: RefundPolicyMode;
    }) => api.setRefundPolicy(ctx, input),
    onSuccess: () => {
      toast.success("Refund policy saved.");
      void qc.invalidateQueries({ queryKey: qk.settings(ctx.workspaceId) });
    },
    onError: () => toast.warning("Something went wrong. Please try again."),
  });

  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    const currency = currencyCode.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) {
      toast.warning(BAD_CURRENCY_MSG);
      return;
    }

    // In `thresholds` mode both amounts govern behaviour and must validate. In
    // always-ask / always-deny they're dormant: a parseable value is persisted
    // (so switching back restores it), but an unparseable one falls back to the
    // STORED value — never coalesced to 0, so a stale tab can't silently zero
    // the merchant's saved thresholds (U10).
    const resolved = resolveRefundThresholds({
      mode,
      askRaw: askAbove,
      denyRaw: denyAbove,
      stored: {
        askMinor: policy.askAboveMinorUnits,
        denyMinor: policy.denyAboveMinorUnits,
      },
    });
    if (!resolved.ok) {
      toast.warning(
        resolved.error === "bad_order" ? BAD_ORDER_MSG : BAD_AMOUNT_MSG,
      );
      return;
    }

    save.mutate({
      currencyCode: currency,
      askAboveMinorUnits: resolved.askMinor,
      denyAboveMinorUnits: resolved.denyMinor,
      mode,
    });
  };

  const optionClass = (selected: boolean) =>
    cn(
      "flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors",
      selected ? "border-primary bg-primary/5" : "border-input hover:bg-accent",
    );

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="grid gap-2 sm:max-w-xs">
        <Label htmlFor="currencyCode">Currency</Label>
        <Input
          id="currencyCode"
          name="currencyCode"
          type="text"
          inputMode="text"
          autoComplete="off"
          maxLength={3}
          value={currencyCode}
          onChange={(e) => setCurrencyCode(e.target.value)}
          required
          aria-describedby="currency-hint"
        />
        <p id="currency-hint" className="text-xs text-muted-foreground">
          ISO 4217. Refunds in other currencies always pause for approval.
        </p>
      </div>

      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium">Refund handling</legend>

        {/* Use thresholds */}
        <label className={optionClass(thresholdsActive)}>
          <input
            type="radio"
            name="mode"
            value="thresholds"
            checked={thresholdsActive}
            onChange={() => setMode("thresholds")}
            className="mt-0.5 size-4 shrink-0"
          />
          <span className="grid w-full gap-3">
            <span className="grid gap-1">
              <span className="flex items-center gap-1.5 text-sm font-medium">
                <SlidersHorizontal className="size-4" aria-hidden />
                Use thresholds
              </span>
              <span className="text-xs text-muted-foreground">
                Auto-run small refunds, pause mid-size ones for approval, block
                large ones, all by amount.
              </span>
            </span>

            <span className="grid gap-4 sm:grid-cols-2 sm:max-w-lg">
              <span className="grid gap-2">
                <Label
                  htmlFor="askAbove"
                  className={cn(!thresholdsActive && "text-muted-foreground")}
                >
                  Ask above
                </Label>
                <Input
                  id="askAbove"
                  name="askAbove"
                  type="text"
                  inputMode="decimal"
                  value={askAbove}
                  onChange={(e) => setAskAbove(e.target.value)}
                  disabled={!thresholdsActive}
                  required={thresholdsActive}
                  aria-describedby="ask-hint"
                />
                <span id="ask-hint" className="text-xs text-muted-foreground">
                  At or below this amount auto-runs.
                </span>
              </span>
              <span className="grid gap-2">
                <Label
                  htmlFor="denyAbove"
                  className={cn(!thresholdsActive && "text-muted-foreground")}
                >
                  Deny above
                </Label>
                <Input
                  id="denyAbove"
                  name="denyAbove"
                  type="text"
                  inputMode="decimal"
                  value={denyAbove}
                  onChange={(e) => setDenyAbove(e.target.value)}
                  disabled={!thresholdsActive}
                  required={thresholdsActive}
                  aria-describedby="deny-hint"
                />
                <span id="deny-hint" className="text-xs text-muted-foreground">
                  Hard cap. Above this never runs, even with approval.
                </span>
              </span>
            </span>
          </span>
        </label>

        {/* Always ask */}
        <label className={optionClass(mode === "always_ask")}>
          <input
            type="radio"
            name="mode"
            value="always_ask"
            checked={mode === "always_ask"}
            onChange={() => setMode("always_ask")}
            className="mt-0.5 size-4 shrink-0"
          />
          <span className="grid gap-1">
            <span className="flex items-center gap-1.5 text-sm font-medium">
              <HandCoins className="size-4" aria-hidden />
              Always ask
            </span>
            <span className="text-xs text-muted-foreground">
              Every refund waits for your approval, regardless of amount. The
              agent drafts it; a human approves before it runs.
            </span>
          </span>
        </label>

        {/* Always deny */}
        <label className={optionClass(mode === "always_deny")}>
          <input
            type="radio"
            name="mode"
            value="always_deny"
            checked={mode === "always_deny"}
            onChange={() => setMode("always_deny")}
            className="mt-0.5 size-4 shrink-0"
          />
          <span className="grid gap-1">
            <span className="flex items-center gap-1.5 text-sm font-medium">
              <Ban className="size-4 text-destructive" aria-hidden />
              Always deny
            </span>
            <span className="text-xs text-muted-foreground">
              Block every refund. The agent never issues a refund; it drafts a
              reply instead, and you handle refunds yourself.
            </span>
          </span>
        </label>
      </fieldset>

      <Button type="submit" disabled={save.isPending}>
        {save.isPending ? "Saving…" : "Save"}
      </Button>
    </form>
  );
}

/**
 * Restock-on-cancel checkbox for the refund-policy page's "Order cancellations"
 * section. Mutates on change (no Save button) and invalidates settings in
 * place — same pattern as the resolution-agent toggle.
 */
function CancellationRestockToggle({ restock }: { readonly restock: boolean }) {
  const ctx = useWorkspaceCtx();
  const qc = useQueryClient();
  const [checked, setChecked] = useState(restock);

  const toggle = useMutation({
    mutationFn: (next: boolean) => api.setCancellationRestock(ctx, next),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.settings(ctx.workspaceId) });
    },
    onError: () => {
      // Revert the optimistic flip so the checkbox reflects the stored value.
      setChecked((prev) => !prev);
      toast.warning("Something went wrong. Please try again.");
    },
  });

  return (
    <label className="flex cursor-pointer items-center gap-3">
      <input
        type="checkbox"
        name="restock"
        checked={checked}
        onChange={(e) => {
          const next = e.currentTarget.checked;
          setChecked(next);
          toggle.mutate(next);
        }}
        className="size-4 rounded border-input accent-primary"
      />
      <span className="text-sm font-medium">
        Return cancelled items to inventory
      </span>
    </label>
  );
}

export function RefundPolicyPage() {
  const ctx = useWorkspaceCtx();
  const allowed = useRequirePermission("settings.refund_policy");

  const settingsQuery = useQuery({
    queryKey: qk.settings(ctx.workspaceId),
    queryFn: () => api.settings(ctx),
    enabled: allowed,
  });

  const currencyQuery = useQuery({
    queryKey: qk.shopCurrency(ctx.workspaceId),
    // Best-effort — the warning is omitted if the store currency is unknown.
    queryFn: () =>
      api.shopCurrency(ctx).catch(() => ({ currencyCode: null as string | null })),
    enabled: allowed,
  });

  if (!allowed) return null;

  const settings = settingsQuery.data;
  const policy = settings?.refundPolicy;
  const shopCurrencyCode = currencyQuery.data?.currencyCode ?? null;

  const showCurrencyWarning = policy
    ? refundCurrencyMismatch(policy.currencyCode, shopCurrencyCode, policy.mode)
    : false;

  return (
    <div className="space-y-6">
      <SettingsBreadcrumb current="Refund policy" />

      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Refund policy</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Set amount limits for refunds. Refunds at or below the{" "}
          <strong>ask threshold</strong> run automatically. Refunds between the
          two thresholds pause for your approval. Refunds above the{" "}
          <strong>deny threshold</strong> are blocked; the agent drafts a reply
          for you instead. Or skip the amounts entirely:{" "}
          <strong>always ask</strong> holds every refund for your approval, and{" "}
          <strong>always deny</strong> blocks them all.
        </p>
      </div>

      {!settings || !policy ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <>
          {showCurrencyWarning ? (
            <Alert variant="warning">
              <AlertDescription>
                Your Shopify store charges in{" "}
                <strong>{shopCurrencyCode}</strong>, but this policy is set to{" "}
                <strong>{policy.currencyCode}</strong>. Refunds won&apos;t match
                your thresholds and will all pause for approval &mdash; set the
                currency to {shopCurrencyCode} to fix this.
              </AlertDescription>
            </Alert>
          ) : null}

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Banknote className="size-4" aria-hidden />
                Thresholds
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <RefundPolicyForm policy={policy} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <XCircle className="size-4" aria-hidden />
                Order cancellations
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 pt-0">
              <p className="text-sm text-muted-foreground">
                When a customer asks to cancel an order that hasn&apos;t shipped
                yet, the agent can cancel and refund it. The cancellation and its
                refund follow the thresholds above. Choose whether the cancelled
                order&apos;s items go back into your inventory.
              </p>
              <CancellationRestockToggle restock={settings.cancellationRestock} />
            </CardContent>
          </Card>

          <div className="rounded-md border bg-muted/40 p-4 text-sm text-muted-foreground">
            <p className="mb-2 font-medium text-foreground">Current behaviour</p>
            {policy.mode === "always_deny" ? (
              <p>
                <strong className="text-foreground">Always deny is on.</strong>{" "}
                Every refund is blocked regardless of amount &mdash; the agent
                falls back to a drafted reply. The thresholds are ignored until
                you switch back to <em>Use thresholds</em>.
              </p>
            ) : policy.mode === "always_ask" ? (
              <p>
                <strong className="text-foreground">Always ask is on.</strong>{" "}
                Every refund waits for your approval regardless of amount &mdash;
                the agent drafts it and a human approves before it runs. The
                thresholds are ignored until you switch back to{" "}
                <em>Use thresholds</em>.
              </p>
            ) : (
              <ul className="list-disc space-y-1 pl-5">
                <li>
                  <strong className="text-foreground">Allow:</strong> 0 &ndash;{" "}
                  {minorToMajor(policy.askAboveMinorUnits)} {policy.currencyCode}{" "}
                  &mdash; auto-runs.
                </li>
                <li>
                  <strong className="text-foreground">Ask:</strong>{" "}
                  {minorToMajor(policy.askAboveMinorUnits)} &ndash;{" "}
                  {minorToMajor(policy.denyAboveMinorUnits)} {policy.currencyCode}{" "}
                  &mdash; pauses for approval.
                </li>
                <li>
                  <strong className="text-foreground">Deny:</strong> &gt;{" "}
                  {minorToMajor(policy.denyAboveMinorUnits)} {policy.currencyCode}{" "}
                  &mdash; falls back to a drafted reply.
                </li>
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}
