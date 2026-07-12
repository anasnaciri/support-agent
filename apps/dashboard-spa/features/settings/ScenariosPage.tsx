import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  Plus,
  RotateCcw,
  Save,
  Trash2,
  Truck,
} from "lucide-react";
import { toast } from "sonner";

import type {
  CustomsDutiesPayerView,
  FactReferenceEntryView,
  RefundMethodView,
  ResolutionScenarioView,
  ReturnsFactsView,
  ReturnShippingPayerView,
  ShippingFactsView,
} from "@support-agent/dashboard-contracts";

import { api } from "@/lib/api-client";
import { qk } from "@/lib/query-keys";
import { useSession, useWorkspaceCtx } from "@/lib/session-context";
import { useRequirePermission } from "@/lib/require-permission";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  PERMISSION_OPTIONS,
  REMEDY_ACTIONS,
  SUPPLIER_MODE_OPTIONS,
  deniedActionsFor,
} from "@/lib/resolution-action-labels";
import {
  NEW_SCENARIO_PREFIX,
  SCENARIO_KEYS_FIELD,
  fieldName,
  parseResolutionForm,
  resolutionPolicySnapshot,
} from "@/lib/parse-resolution";
import {
  formValuesDirty,
  useDirtyFlags,
  useReportDirty,
  type ReportDirty,
} from "@/lib/unsaved-changes";
import { UnsavedChangesPrompt } from "@/components/unsaved-changes-prompt";
import { Button } from "@/components/ui/button";
import { GlassSwitch } from "@/components/ui/glass-switch";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Link } from "@/components/ui/link";
import { NativeSelect } from "@/components/ui/native-select";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { SettingsBreadcrumb } from "@/components/settings-breadcrumb";
import { PlaybookNotesField } from "./PlaybookNotesField";

export const SCENARIOS_FACTS_SIDEBAR_STORAGE_KEY =
  "settings:scenarios:facts-sidebar";

type SidebarStorage = Pick<Storage, "getItem" | "setItem">;

const browserStorage = (): SidebarStorage | null => {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

export const readScenariosFactsSidebarExpanded = (
  storage: SidebarStorage | null = browserStorage(),
): boolean => {
  try {
    return storage?.getItem(SCENARIOS_FACTS_SIDEBAR_STORAGE_KEY) === "open";
  } catch {
    return false;
  }
};

export const writeScenariosFactsSidebarExpanded = (
  expanded: boolean,
  storage: SidebarStorage | null = browserStorage(),
): void => {
  try {
    storage?.setItem(
      SCENARIOS_FACTS_SIDEBAR_STORAGE_KEY,
      expanded ? "open" : "closed",
    );
  } catch {
    /* private mode */
  }
};

export interface ShippingFactsSidebarForm {
  readonly processingTime: string;
  readonly deliveryTime: string;
  readonly shippingCost: string;
  readonly customsDuties: string;
  readonly delayedAfterDays: string;
  readonly lostPackageInvestigationDays: string;
}

type ShippingFactsSidebarInput = {
  readonly processingTime: string;
  readonly deliveryTime: string;
  readonly shippingCost: string | null;
  readonly customsDuties: CustomsDutiesPayerView | null;
  readonly delayedAfterDays: number;
  readonly lostPackageInvestigationDays: number | null;
};

type SidebarInputResult<A> =
  | { readonly ok: true; readonly input: A }
  | { readonly ok: false; readonly error: string };

const isCustomsDutiesPayer = (
  value: string,
): value is CustomsDutiesPayerView =>
  value === "customer" ||
  value === "merchant" ||
  value === "not_applicable";

const parsePositiveInteger = (raw: string): number | null => {
  const parsed = Number(raw.trim());
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : null;
};

export const shippingFactsSidebarFormFrom = (
  facts: ShippingFactsView | null,
): ShippingFactsSidebarForm => ({
  processingTime: facts?.processingTime ?? "",
  deliveryTime: facts?.deliveryTime ?? "",
  shippingCost: facts?.shippingCost ?? "",
  customsDuties: facts?.customsDuties ?? "",
  delayedAfterDays: facts ? String(facts.delayedAfterDays) : "",
  lostPackageInvestigationDays:
    facts?.lostPackageInvestigationDays != null
      ? String(facts.lostPackageInvestigationDays)
      : "",
});

export const buildShippingFactsSidebarInput = (
  form: ShippingFactsSidebarForm,
): SidebarInputResult<ShippingFactsSidebarInput> => {
  const processingTime = form.processingTime.trim();
  if (!processingTime) {
    return {
      ok: false,
      error: "Tell us how long orders take to leave your warehouse.",
    };
  }
  const deliveryTime = form.deliveryTime.trim();
  if (!deliveryTime) {
    return {
      ok: false,
      error: "Tell us how long delivery usually takes after shipment.",
    };
  }
  const delayedAfterDays = parsePositiveInteger(form.delayedAfterDays);
  if (delayedAfterDays == null) {
    return { ok: false, error: "Enter a whole number of days, 1 or more." };
  }
  const lostRaw = form.lostPackageInvestigationDays.trim();
  const lostPackageInvestigationDays =
    lostRaw === "" ? null : parsePositiveInteger(lostRaw);
  if (lostRaw !== "" && lostPackageInvestigationDays == null) {
    return {
      ok: false,
      error:
        "Enter a whole number of days, 1 or more, for when to make the customer whole (or leave it blank).",
    };
  }
  return {
    ok: true,
    input: {
      processingTime,
      deliveryTime,
      shippingCost: form.shippingCost.trim() || null,
      customsDuties: isCustomsDutiesPayer(form.customsDuties)
        ? form.customsDuties
        : null,
      delayedAfterDays,
      lostPackageInvestigationDays,
    },
  };
};

export interface ReturnsFactsSidebarForm {
  readonly returnWindowDays: string;
  readonly returnShippingPayer: string;
  readonly refundMethod: string;
  readonly refundProcessingTime: string;
}

type ReturnsFactsSidebarInput = {
  readonly returnWindowDays: number;
  readonly returnShippingPayer: ReturnShippingPayerView | null;
  readonly refundMethod: RefundMethodView | null;
  readonly refundProcessingTime: string | null;
};

const isReturnShippingPayer = (
  value: string,
): value is ReturnShippingPayerView =>
  value === "customer" || value === "merchant" || value === "depends";

const isRefundMethod = (value: string): value is RefundMethodView =>
  value === "original" ||
  value === "store_credit" ||
  value === "customer_choice";

export const returnsFactsSidebarFormFrom = (
  facts: ReturnsFactsView | null,
): ReturnsFactsSidebarForm => ({
  returnWindowDays: facts ? String(facts.returnWindowDays) : "",
  returnShippingPayer: facts?.returnShippingPayer ?? "",
  refundMethod: facts?.refundMethod ?? "",
  refundProcessingTime: facts?.refundProcessingTime ?? "",
});

export const buildReturnsFactsSidebarInput = (
  form: ReturnsFactsSidebarForm,
): SidebarInputResult<ReturnsFactsSidebarInput> => {
  const returnWindowDays = parsePositiveInteger(form.returnWindowDays);
  if (returnWindowDays == null) {
    return {
      ok: false,
      error: "Enter a whole number of days, 1 or more, for your return window.",
    };
  }
  return {
    ok: true,
    input: {
      returnWindowDays,
      returnShippingPayer: isReturnShippingPayer(form.returnShippingPayer)
        ? form.returnShippingPayer
        : null,
      refundMethod: isRefundMethod(form.refundMethod)
        ? form.refundMethod
        : null,
      refundProcessingTime: form.refundProcessingTime.trim() || null,
    },
  };
};

interface SidebarFact {
  readonly id: string;
  readonly label: string;
  readonly value: string | null;
}

interface SidebarFactGroup {
  readonly id: "shipping" | "returns";
  readonly title: string;
  readonly facts: ReadonlyArray<SidebarFact>;
}

const SIDEBAR_FACT_GROUPS: ReadonlyArray<{
  readonly id: SidebarFactGroup["id"];
  readonly title: string;
}> = [
  { id: "shipping", title: "Shipping & delivery" },
  { id: "returns", title: "Returns & refunds" },
];

export const sidebarFactGroups = (
  entries: ReadonlyArray<FactReferenceEntryView>,
): ReadonlyArray<SidebarFactGroup> =>
  SIDEBAR_FACT_GROUPS.map((group) => ({
    ...group,
    facts: entries
      .filter((entry) => entry.namespace === group.id && entry.field != null)
      .map((entry) => ({
        id: entry.id,
        label: entry.label,
        value: entry.value,
      })),
  })).filter((group) => group.facts.length > 0);

type DashboardCtx = { readonly workspaceId: string };

const compactField = "grid gap-1.5";
const compactHint = "text-xs text-muted-foreground";

const invalidateSidebarFacts = (
  qc: ReturnType<typeof useQueryClient>,
  workspaceId: string,
) => {
  void qc.invalidateQueries({ queryKey: qk.settings(workspaceId) });
  void qc.invalidateQueries({ queryKey: qk.factReferences(workspaceId) });
};

function FactValueList({
  facts,
}: {
  readonly facts: ReadonlyArray<SidebarFact>;
}) {
  return (
    <dl className="grid gap-2">
      {facts.map((fact) => (
        <div key={fact.id} className="rounded-lg bg-muted/45 px-3 py-2">
          <dt className="text-xs font-medium text-muted-foreground">
            {fact.label}
          </dt>
          <dd
            className={cn(
              "mt-1 text-sm text-pretty",
              fact.value ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {fact.value ?? "Not set"}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function FactsPermissionNote({
  canViewFacts,
}: {
  readonly canViewFacts: boolean;
}) {
  return (
    <div className="rounded-lg bg-muted/45 px-3 py-2 text-sm text-muted-foreground">
      <p className="text-pretty">
        You need knowledge-base management permission to edit these values.
      </p>
      {canViewFacts ? (
        <Link
          href="/settings/facts"
          className="mt-2 inline-flex text-primary underline underline-offset-2"
        >
          Open Facts
        </Link>
      ) : null}
    </div>
  );
}

function ShippingFactsSidebarCard({
  ctx,
  facts,
  factValues,
  canManageFacts,
  canViewFacts,
  reportDirty,
}: {
  readonly ctx: DashboardCtx;
  readonly facts: ShippingFactsView | null;
  readonly factValues: ReadonlyArray<SidebarFact>;
  readonly canManageFacts: boolean;
  readonly canViewFacts: boolean;
  readonly reportDirty: ReportDirty;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState(() => shippingFactsSidebarFormFrom(facts));
  const [saved, setSaved] = useState(form);
  const [error, setError] = useState<string | null>(null);

  useReportDirty(reportDirty, "facts:shipping", formValuesDirty(saved, form));

  const save = useMutation({
    mutationFn: (input: ShippingFactsSidebarInput) =>
      api.setShippingFacts(ctx, input),
    onSuccess: (res) => {
      if (res.status !== 200) {
        setError("Something went wrong. Please check the fields and try again.");
        return;
      }
      setError(null);
      setSaved(form);
      toast.success("Shipping facts saved.");
      invalidateSidebarFacts(qc, ctx.workspaceId);
    },
    onError: () => toast.warning("Something went wrong. Please try again."),
  });

  const setField = <K extends keyof ShippingFactsSidebarForm>(
    key: K,
    value: ShippingFactsSidebarForm[K],
  ) => setForm((current) => ({ ...current, [key]: value }));

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const result = buildShippingFactsSidebarInput(form);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    save.mutate(result.input);
  };

  const pending = save.isPending;

  return (
    <Card>
      <CardHeader className="p-4 pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Truck className="size-4" aria-hidden />
          Shipping &amp; delivery
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 p-4 pt-0">
        <FactValueList facts={factValues} />

        <Separator />

        {canManageFacts ? (
          <form onSubmit={onSubmit} className="space-y-3">
            <div className={compactField}>
              <Label htmlFor="sidebar-processing-time">
                Order processing time
              </Label>
              <Input
                id="sidebar-processing-time"
                placeholder="1-2 business days"
                required
                disabled={pending}
                value={form.processingTime}
                onChange={(e) =>
                  setField("processingTime", e.currentTarget.value)
                }
              />
            </div>
            <div className={compactField}>
              <Label htmlFor="sidebar-delivery-time">Delivery time</Label>
              <Input
                id="sidebar-delivery-time"
                placeholder="7-12 days"
                required
                disabled={pending}
                value={form.deliveryTime}
                onChange={(e) => setField("deliveryTime", e.currentTarget.value)}
              />
            </div>
            <div className={compactField}>
              <Label htmlFor="sidebar-shipping-cost">Shipping cost</Label>
              <Input
                id="sidebar-shipping-cost"
                placeholder="$4.95, free over $50"
                disabled={pending}
                value={form.shippingCost}
                onChange={(e) => setField("shippingCost", e.currentTarget.value)}
              />
            </div>
            <div className={compactField}>
              <Label htmlFor="sidebar-customs-duties">Customs duties</Label>
              <NativeSelect
                id="sidebar-customs-duties"
                disabled={pending}
                value={form.customsDuties}
                onChange={(e) => setField("customsDuties", e.currentTarget.value)}
              >
                <option value="">Not specified</option>
                <option value="customer">The customer pays</option>
                <option value="merchant">We pay</option>
                <option value="not_applicable">Doesn&apos;t apply</option>
              </NativeSelect>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-1">
              <div className={compactField}>
                <Label htmlFor="sidebar-delayed-after-days">
                  Delayed after
                </Label>
                <Input
                  id="sidebar-delayed-after-days"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  placeholder="14"
                  required
                  disabled={pending}
                  value={form.delayedAfterDays}
                  onChange={(e) =>
                    setField("delayedAfterDays", e.currentTarget.value)
                  }
                />
                <p className={compactHint}>Days in transit.</p>
              </div>
              <div className={compactField}>
                <Label htmlFor="sidebar-lost-after-days">Lost after</Label>
                <Input
                  id="sidebar-lost-after-days"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  placeholder="30"
                  disabled={pending}
                  value={form.lostPackageInvestigationDays}
                  onChange={(e) =>
                    setField(
                      "lostPackageInvestigationDays",
                      e.currentTarget.value,
                    )
                  }
                />
                <p className={compactHint}>Optional.</p>
              </div>
            </div>

            {error ? (
              <Alert variant="warning">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}

            <Button type="submit" size="sm" disabled={pending}>
              {pending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <Save className="size-4" aria-hidden />
              )}
              {pending ? "Saving..." : "Save shipping facts"}
            </Button>
          </form>
        ) : (
          <FactsPermissionNote canViewFacts={canViewFacts} />
        )}
      </CardContent>
    </Card>
  );
}

function ReturnsFactsSidebarCard({
  ctx,
  facts,
  factValues,
  canManageFacts,
  canViewFacts,
  reportDirty,
}: {
  readonly ctx: DashboardCtx;
  readonly facts: ReturnsFactsView | null;
  readonly factValues: ReadonlyArray<SidebarFact>;
  readonly canManageFacts: boolean;
  readonly canViewFacts: boolean;
  readonly reportDirty: ReportDirty;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState(() => returnsFactsSidebarFormFrom(facts));
  const [saved, setSaved] = useState(form);
  const [error, setError] = useState<string | null>(null);

  useReportDirty(reportDirty, "facts:returns", formValuesDirty(saved, form));

  const save = useMutation({
    mutationFn: (input: ReturnsFactsSidebarInput) =>
      api.setReturnsFacts(ctx, input),
    onSuccess: (res) => {
      if (res.status !== 200) {
        setError("Something went wrong. Please check the fields and try again.");
        return;
      }
      setError(null);
      setSaved(form);
      toast.success("Returns facts saved.");
      invalidateSidebarFacts(qc, ctx.workspaceId);
    },
    onError: () => toast.warning("Something went wrong. Please try again."),
  });

  const setField = <K extends keyof ReturnsFactsSidebarForm>(
    key: K,
    value: ReturnsFactsSidebarForm[K],
  ) => setForm((current) => ({ ...current, [key]: value }));

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const result = buildReturnsFactsSidebarInput(form);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    save.mutate(result.input);
  };

  const pending = save.isPending;

  return (
    <Card>
      <CardHeader className="p-4 pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <RotateCcw className="size-4" aria-hidden />
          Returns &amp; refunds
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 p-4 pt-0">
        <FactValueList facts={factValues} />

        <Separator />

        {canManageFacts ? (
          <form onSubmit={onSubmit} className="space-y-3">
            <div className={compactField}>
              <Label htmlFor="sidebar-return-window">Return window</Label>
              <Input
                id="sidebar-return-window"
                type="number"
                inputMode="numeric"
                min={1}
                placeholder="30"
                required
                disabled={pending}
                value={form.returnWindowDays}
                onChange={(e) =>
                  setField("returnWindowDays", e.currentTarget.value)
                }
              />
              <p className={compactHint}>Days after delivery.</p>
            </div>
            <div className={compactField}>
              <Label htmlFor="sidebar-return-shipping">
                Return shipping payer
              </Label>
              <NativeSelect
                id="sidebar-return-shipping"
                disabled={pending}
                value={form.returnShippingPayer}
                onChange={(e) =>
                  setField("returnShippingPayer", e.currentTarget.value)
                }
              >
                <option value="">Not specified</option>
                <option value="customer">The customer pays</option>
                <option value="merchant">We pay</option>
                <option value="depends">It depends</option>
              </NativeSelect>
            </div>
            <div className={compactField}>
              <Label htmlFor="sidebar-refund-method">Refund method</Label>
              <NativeSelect
                id="sidebar-refund-method"
                disabled={pending}
                value={form.refundMethod}
                onChange={(e) => setField("refundMethod", e.currentTarget.value)}
              >
                <option value="">Not specified</option>
                <option value="original">Original payment method</option>
                <option value="store_credit">Store credit</option>
                <option value="customer_choice">Customer chooses</option>
              </NativeSelect>
            </div>
            <div className={compactField}>
              <Label htmlFor="sidebar-refund-time">Refund processing time</Label>
              <Input
                id="sidebar-refund-time"
                placeholder="5-7 business days"
                disabled={pending}
                value={form.refundProcessingTime}
                onChange={(e) =>
                  setField("refundProcessingTime", e.currentTarget.value)
                }
              />
            </div>

            {error ? (
              <Alert variant="warning">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}

            <Button type="submit" size="sm" disabled={pending}>
              {pending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <Save className="size-4" aria-hidden />
              )}
              {pending ? "Saving..." : "Save returns facts"}
            </Button>
          </form>
        ) : (
          <FactsPermissionNote canViewFacts={canViewFacts} />
        )}
      </CardContent>
    </Card>
  );
}

function ScenarioFactsSidebar({
  ctx,
  canManageFacts,
  canViewFacts,
  reportDirty,
}: {
  readonly ctx: DashboardCtx;
  readonly canManageFacts: boolean;
  readonly canViewFacts: boolean;
  readonly reportDirty: ReportDirty;
}) {
  const [expanded, setExpanded] = useState(readScenariosFactsSidebarExpanded);

  const referencesQuery = useQuery({
    queryKey: qk.factReferences(ctx.workspaceId),
    queryFn: () => api.factReferences(ctx),
    enabled: expanded,
  });
  const settingsQuery = useQuery({
    queryKey: qk.settings(ctx.workspaceId),
    queryFn: () => api.settings(ctx),
    enabled: expanded,
  });

  const groups = useMemo(
    () => sidebarFactGroups(referencesQuery.data ?? []),
    [referencesQuery.data],
  );
  const shippingGroup = groups.find((group) => group.id === "shipping");
  const returnsGroup = groups.find((group) => group.id === "returns");

  const toggle = () => {
    setExpanded((current) => {
      const next = !current;
      writeScenariosFactsSidebarExpanded(next);
      return next;
    });
  };

  const settings = settingsQuery.data;
  const loading = referencesQuery.isLoading || settingsQuery.isLoading;

  return (
    <aside
      aria-label="Store facts"
      className={cn(
        "order-first shrink-0 xl:order-none xl:self-start",
        "transition-[width] duration-200 ease-out",
        expanded ? "xl:w-[24rem]" : "xl:w-12",
      )}
    >
      <div className="xl:sticky xl:top-6">
        <div
          className={cn(
            "flex items-start gap-3",
            expanded ? "justify-between" : "justify-end",
          )}
        >
          {expanded ? (
            <div className="min-w-0">
              <h2 className="text-base font-semibold tracking-tight">
                Store facts
              </h2>
              <p className="mt-1 text-xs text-muted-foreground text-pretty">
                Referenced by scenario playbooks.
              </p>
            </div>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-controls="scenario-facts-sidebar-panel"
            aria-expanded={expanded}
            aria-label={
              expanded ? "Collapse facts sidebar" : "Expand facts sidebar"
            }
            title={expanded ? "Collapse facts sidebar" : "Expand facts sidebar"}
            onClick={toggle}
          >
            {expanded ? (
              <ChevronRight className="size-4" aria-hidden />
            ) : (
              <ChevronLeft className="size-4" aria-hidden />
            )}
          </Button>
        </div>

        {expanded ? (
          <div id="scenario-facts-sidebar-panel" className="mt-3 space-y-3">
            {loading ? (
              <Card>
                <CardContent className="p-4">
                  <p className="text-sm text-muted-foreground">Loading...</p>
                </CardContent>
              </Card>
            ) : null}

            {!loading && settings ? (
              <>
                {shippingGroup ? (
                  <ShippingFactsSidebarCard
                    key={`shipping-${JSON.stringify(settings.shippingFacts)}`}
                    ctx={ctx}
                    facts={settings.shippingFacts}
                    factValues={shippingGroup.facts}
                    canManageFacts={canManageFacts}
                    canViewFacts={canViewFacts}
                    reportDirty={reportDirty}
                  />
                ) : null}
                {returnsGroup ? (
                  <ReturnsFactsSidebarCard
                    key={`returns-${JSON.stringify(settings.returnsFacts)}`}
                    ctx={ctx}
                    facts={settings.returnsFacts}
                    factValues={returnsGroup.facts}
                    canManageFacts={canManageFacts}
                    canViewFacts={canViewFacts}
                    reportDirty={reportDirty}
                  />
                ) : null}
              </>
            ) : null}

            {!loading && !settings ? (
              <Card>
                <CardContent className="p-4">
                  <p className="text-sm text-muted-foreground">
                    Facts could not be loaded.
                  </p>
                </CardContent>
              </Card>
            ) : null}
          </div>
        ) : null}
      </div>
    </aside>
  );
}

interface CustomCard {
  /** Stable React key + form-field prefix (a `custom_*` or `__new_*` key). */
  readonly formKey: string;
  /** The saved scenario this card edits, or null for a freshly-added one. */
  readonly initial: ResolutionScenarioView | null;
}

/**
 * One scenario card. Built-in cards show a read-only header (their name + when
 * they apply are immutable, forced server-side) and carry those values as
 * hidden inputs. Custom cards make the name + recognition editable and add a
 * remove button. The editable fields — which remedy actions the agent may take
 * and whether each needs approval, supplier handling, the Active toggle, and
 * free-text notes — are identical for both.
 */
export function ScenarioCard({
  formKey,
  scenario,
  onRemove,
  ctx,
}: {
  readonly formKey: string;
  readonly scenario: ResolutionScenarioView | null;
  readonly onRemove?: () => void;
  readonly ctx: { readonly workspaceId: string };
}) {
  const custom = onRemove != null;
  const [active, setActive] = useState(scenario ? scenario.enabled : true);
  const byTool = new Map(
    (scenario?.enabledActions ?? []).map((a) => [a.tool, a.permission]),
  );
  const defaultSupplierMode = scenario?.supplierMode ?? "none";

  // The form is uncontrolled (it submits via FormData), but the playbook warning
  // has to react to these two the moment they change: a note that names an action
  // the switches just turned off is a playbook the agent will refuse to follow.
  const [enabledTools, setEnabledTools] = useState<ReadonlySet<string>>(
    () => new Set(byTool.keys()),
  );
  const [supplierMode, setSupplierMode] = useState(defaultSupplierMode);
  const deniedActions = deniedActionsFor(enabledTools, supplierMode);

  const toggleTool = (tool: string, on: boolean) =>
    setEnabledTools((prev) => {
      const next = new Set(prev);
      if (on) next.add(tool);
      else next.delete(tool);
      return next;
    });

  return (
    <Card className={active ? "transition-opacity" : "opacity-55 transition-opacity"}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            {custom ? (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor={fieldName(formKey, "label")}>
                    Scenario name
                  </Label>
                  <Input
                    id={fieldName(formKey, "label")}
                    name={fieldName(formKey, "label")}
                    defaultValue={scenario?.label ?? ""}
                    placeholder="e.g. Wholesale order question"
                    required
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={fieldName(formKey, "recognition")}>
                    When should the agent treat a message as this?
                  </Label>
                  <Textarea
                    id={fieldName(formKey, "recognition")}
                    name={fieldName(formKey, "recognition")}
                    rows={2}
                    defaultValue={scenario?.recognition ?? ""}
                    placeholder="Describe it in plain language, e.g. a bulk / B2B buyer asking about a large order."
                    required
                  />
                </div>
              </div>
            ) : (
              <>
                <CardTitle className="text-base">{scenario?.label}</CardTitle>
                {scenario?.recognition ? (
                  <p className="text-sm text-muted-foreground">
                    {scenario.recognition}
                  </p>
                ) : null}
                {/* Immutable fields ride along so the saved payload is faithful;
                    the server re-derives them from the seeded defaults anyway. */}
                <input
                  type="hidden"
                  name={fieldName(formKey, "__label")}
                  value={scenario?.label ?? ""}
                />
                <input
                  type="hidden"
                  name={fieldName(formKey, "__recognition")}
                  value={scenario?.recognition ?? ""}
                />
              </>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <span className="font-medium">Active</span>
              <GlassSwitch
                name={fieldName(formKey, "enabled")}
                checked={active}
                onChange={(e) => setActive(e.currentTarget.checked)}
              />
            </label>
            {custom ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={onRemove}
                aria-label="Remove scenario"
              >
                <Trash2 className="size-4" aria-hidden />
              </Button>
            ) : null}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Which remedies the agent may reach for in THIS scenario, and whether
            each runs on its own. This is the hard gate: the runtime removes a
            disabled action from the model's tool list entirely. */}
        <fieldset className="space-y-3">
          <legend className="text-sm font-medium">
            Actions the agent can take
          </legend>
          {REMEDY_ACTIONS.map((action) => {
            const enabled = enabledTools.has(action.tool);
            const permission = byTool.get(action.tool) ?? "ask";
            return (
              <div
                key={action.tool}
                className="flex flex-wrap items-center gap-x-3 gap-y-2"
              >
                <label className="flex flex-1 items-start gap-2">
                  <input
                    type="checkbox"
                    name={fieldName(formKey, `action:${action.tool}:enabled`)}
                    checked={enabled}
                    onChange={(e) =>
                      toggleTool(action.tool, e.currentTarget.checked)
                    }
                    className="mt-0.5 size-4 rounded border-input accent-primary"
                  />
                  <span className="text-sm">
                    <span className="font-medium">{action.label}</span>
                    <span className="block text-xs text-muted-foreground">
                      {action.help}
                    </span>
                  </span>
                </label>
                {/* The approval choice only means something for an action the
                    agent is allowed to take at all. */}
                <NativeSelect
                  name={fieldName(formKey, `action:${action.tool}:permission`)}
                  defaultValue={permission}
                  disabled={!enabled}
                  aria-label={`${action.label} approval`}
                  className="w-44"
                >
                  {PERMISSION_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </NativeSelect>
              </div>
            );
          })}
          <p className="text-xs text-muted-foreground">
            Reading the order, searching your knowledge base, asking the customer
            a question, and replying are always on.
          </p>
        </fieldset>

        <Separator />

        {/* Supplier handling. */}
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">
            When a supplier is involved
          </legend>
          {SUPPLIER_MODE_OPTIONS.map((o) => (
            <label key={o.value} className="flex items-start gap-2">
              <input
                type="radio"
                name={fieldName(formKey, "supplierMode")}
                value={o.value}
                checked={supplierMode === o.value}
                onChange={() => setSupplierMode(o.value)}
                className="mt-0.5 size-4 border-input accent-primary"
              />
              <span className="text-sm">
                <span className="font-medium">{o.label}</span>
                <span className="block text-xs text-muted-foreground">
                  {o.help}
                </span>
              </span>
            </label>
          ))}
        </fieldset>

        <Separator />

        {/* Free-text playbook: @-references to store facts and docs, /-references
            to the actions the agent can take. */}
        <div className="space-y-1.5">
          <Label htmlFor={fieldName(formKey, "notes")}>Playbook notes</Label>
          <PlaybookNotesField
            id={fieldName(formKey, "notes")}
            name={fieldName(formKey, "notes")}
            defaultValue={scenario?.notes ?? ""}
            placeholder="How should the agent handle this? e.g. check tracking first, then offer a refund if it's genuinely lost."
            ctx={ctx}
            deniedActions={deniedActions}
          />
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * The scenario editor. Built-in cards are fixed; merchants can add their own
 * scenarios (name + when-it-applies + the same action/supplier/notes controls)
 * and remove the custom ones. A hidden manifest lists every card's form key so
 * the submit handler can reconstruct the list (built-ins, existing customs, and
 * freshly-added `__new_*` cards alike) from the submitted FormData.
 */
function ResolutionPolicyForm({
  scenarios,
  reportDirty,
}: {
  readonly scenarios: ReadonlyArray<ResolutionScenarioView>;
  readonly reportDirty: ReportDirty;
}) {
  const ctx = useWorkspaceCtx();
  const qc = useQueryClient();
  const builtins = scenarios.filter((s) => s.builtin);
  const [customs, setCustoms] = useState<ReadonlyArray<CustomCard>>(() =>
    scenarios
      .filter((s) => !s.builtin)
      .map((s) => ({ formKey: s.key, initial: s })),
  );
  const [nextId, setNextId] = useState(0);

  // The cards are uncontrolled (defaultValue + FormData on submit), so what the
  // form would save lives in the DOM, not in state: dirtiness is the DOM
  // snapshot compared against the one taken at load / at the last save.
  const formRef = useRef<HTMLFormElement | null>(null);
  const savedSnapshot = useRef<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [revision, setRevision] = useState(0);

  const snapshot = useCallback((): string | null => {
    const form = formRef.current;
    if (!form) return null;
    const fd = new FormData(form);
    return resolutionPolicySnapshot((name) => {
      const value = fd.get(name);
      return typeof value === "string" ? value : null;
    });
  }, []);

  // Snapshot in an effect rather than in the edit handler: the playbook editor
  // writes its note into a hidden input on render, so reading the DOM while the
  // event is still in flight would be one keystroke behind.
  useEffect(() => {
    const current = snapshot();
    if (current == null) return;
    savedSnapshot.current ??= current;
    setDirty(current !== savedSnapshot.current);
  }, [revision, customs, snapshot]);

  useReportDirty(reportDirty, "scenarios", dirty);

  const saveM = useMutation({
    mutationFn: (next: ReadonlyArray<ResolutionScenarioView>) =>
      api.setResolutionPolicy(ctx, next),
    onSuccess: () => {
      savedSnapshot.current = snapshot();
      setDirty(false);
      toast.success("Scenarios saved.");
      void qc.invalidateQueries({
        queryKey: qk.resolutionPolicy(ctx.workspaceId),
      });
    },
    onError: () => {
      toast.warning("Something went wrong. Please try again.");
    },
  });

  const addCustom = () => {
    setCustoms((cs) => [
      ...cs,
      { formKey: `${NEW_SCENARIO_PREFIX}${nextId}`, initial: null },
    ]);
    setNextId((n) => n + 1);
  };
  const removeCustom = (formKey: string) =>
    setCustoms((cs) => cs.filter((c) => c.formKey !== formKey));

  const manifest = JSON.stringify([
    ...builtins.map((s) => s.key),
    ...customs.map((c) => c.formKey),
  ]);

  // The Next server action parsed FormData through parseResolutionForm; here we
  // read the same FormData off the submitted form and hand the typed payload
  // straight to the api. The api's decoder remains the authority on built-in
  // immutability and custom-key assignment.
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const get = (name: string): string | null => {
      const v = fd.get(name);
      return typeof v === "string" ? v : null;
    };
    saveM.mutate(parseResolutionForm(get));
  };

  const bumpRevision = () => setRevision((r) => r + 1);

  return (
    <form
      ref={formRef}
      onSubmit={onSubmit}
      onInput={bumpRevision}
      onChange={bumpRevision}
      className="space-y-5"
    >
      <input type="hidden" name={SCENARIO_KEYS_FIELD} value={manifest} />

      {builtins.map((s) => (
        <ScenarioCard key={s.key} formKey={s.key} scenario={s} ctx={ctx} />
      ))}

      {customs.map((c) => (
        <ScenarioCard
          key={c.formKey}
          formKey={c.formKey}
          scenario={c.initial}
          onRemove={() => removeCustom(c.formKey)}
          ctx={ctx}
        />
      ))}

      <Button
        type="button"
        variant="outline"
        onClick={addCustom}
        className="w-full"
      >
        <Plus className="size-4" aria-hidden />
        Add scenario
      </Button>

      <Button type="submit" disabled={saveM.isPending}>
        {saveM.isPending ? (
          <Loader2 className="size-4 animate-spin" aria-hidden />
        ) : null}
        {saveM.isPending ? "Saving…" : "Save scenarios"}
      </Button>
    </form>
  );
}

export function ScenariosPage() {
  const allowed = useRequirePermission("settings.agents");
  const ctx = useWorkspaceCtx();
  const { permissions } = useSession();
  const canManageFacts = permissions.has("knowledge.manage");
  const canViewFacts = canManageFacts || permissions.has("knowledge.view");

  // The scenarios form and each facts card save separately; any one of them
  // holding unsaved edits should stop the merchant walking away from the page.
  const { dirty, reportDirty } = useDirtyFlags();

  const { data: policy, isLoading } = useQuery({
    queryKey: qk.resolutionPolicy(ctx.workspaceId),
    queryFn: () => api.resolutionPolicy(ctx),
    enabled: allowed,
  });

  if (!allowed) return null;

  if (isLoading || !policy) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }

  return (
    <div className="space-y-6">
      <UnsavedChangesPrompt
        dirty={dirty}
        description="Your scenario changes haven't been saved yet. Leave this page and you'll lose them."
      />

      <SettingsBreadcrumb current="Scenarios" />

      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Scenarios</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          A single agent handles every incoming ticket end-to-end, steered by
          the scenarios below. It reads the customer&apos;s message, picks the
          scenario that fits, gathers what it needs, takes the actions
          you&apos;ve allowed, and drafts the reply, pausing for your approval
          on anything you marked <em>Ask me first</em>. A message that matches no
          scenario is handed to you rather than guessed at.
        </p>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_auto] xl:items-start">
        <div className="min-w-0 space-y-5">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Scenarios</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              For each situation, choose what the agent may do and whether it
              acts automatically or asks you first. The built-in scenarios cover
              the common tickets; add your own for anything specific to your
              store. Describe when it applies and the agent will route matching
              messages to it.
            </p>
          </div>

          <ResolutionPolicyForm
            scenarios={policy.scenarios}
            reportDirty={reportDirty}
          />
        </div>

        <ScenarioFactsSidebar
          ctx={ctx}
          canManageFacts={canManageFacts}
          canViewFacts={canViewFacts}
          reportDirty={reportDirty}
        />
      </div>
    </div>
  );
}
