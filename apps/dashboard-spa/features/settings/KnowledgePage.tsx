import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { BookOpen, FileText, Link2, Pencil, RotateCcw, Truck } from "lucide-react";

import { api } from "@/lib/api-client";
import { qk } from "@/lib/query-keys";
import { useWorkspaceCtx } from "@/lib/session-context";
import { useRequirePermission } from "@/lib/require-permission";
import { knowledgeErrorMessage } from "@/lib/knowledge-messages";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Link } from "@/components/ui/link";
import { Textarea } from "@/components/ui/textarea";
import { SettingsBreadcrumb } from "@/components/settings-breadcrumb";
import { ConfirmButton } from "@/features/tickets/ConfirmButton";
import type {
  CustomsDutiesPayerView,
  KnowledgeDocumentSummaryView,
  RefundMethodView,
  ReturnShippingPayerView,
  ReturnsFactsView,
  ShippingProfileView,
} from "@support-agent/dashboard-contracts";

// Map an api error body ({ error, reason? }) to a compact banner code so the
// message map can show a friendly message (e.g. "fetch_failed:blocked_host").
const failCode = (body: unknown): string => {
  if (body && typeof body === "object") {
    const b = body as { error?: unknown; reason?: unknown };
    const error = typeof b.error === "string" ? b.error : "error";
    const reason = typeof b.reason === "string" ? b.reason : undefined;
    return reason ? `${error}:${reason}` : error;
  }
  return "error";
};

type Ctx = { readonly workspaceId: string };

// A destructive per-row delete gated behind the branded confirm dialog. Its own
// mutation keeps the pending spinner scoped to the row being deleted. On success
// the Next action redirected to ?deleted=1 ("Document deleted.").
function DeleteDocButton({
  doc,
  ctx,
}: {
  readonly doc: KnowledgeDocumentSummaryView;
  readonly ctx: Ctx;
}) {
  const qc = useQueryClient();
  const del = useMutation({
    mutationFn: () => api.deleteKnowledge(ctx, doc.id),
    onSuccess: () => {
      toast.success("Document deleted.");
      void qc.invalidateQueries({ queryKey: qk.knowledge(ctx.workspaceId) });
    },
    onError: () => {
      toast.warning("Something went wrong. Please try again.");
    },
  });

  return (
    <ConfirmButton
      variant="ghost"
      size="sm"
      title={`Delete “${doc.title}”?`}
      description="Your agents stop referencing this document immediately. This can't be undone."
      confirmLabel="Delete document"
      pending={del.isPending}
      onConfirm={() => del.mutate()}
    >
      Delete
    </ConfirmButton>
  );
}

// The paste-a-document / add-from-URL create form. Ported from useActionState
// (U4): on a failed URL fetch or validation error we KEEP the merchant's input —
// a large pasted policy document must never be discarded — so the fields stay
// controlled and are only cleared on success.
function KnowledgeCreateForm({
  sourceType,
  ctx,
}: {
  readonly sourceType: "text" | "url";
  readonly ctx: Ctx;
}) {
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const idPrefix = sourceType === "url" ? "url" : "paste";

  const create = useMutation({
    mutationFn: () =>
      sourceType === "url"
        ? api.createKnowledge(ctx, {
            title: title.trim(),
            sourceType: "url",
            sourceUrl: sourceUrl.trim(),
          })
        : api.createKnowledge(ctx, {
            title: title.trim(),
            sourceType: "text",
            content,
          }),
    onSuccess: (res) => {
      if (res.status !== 200) {
        setError(failCode(res.body));
        return;
      }
      setError(null);
      toast.success("Document saved.");
      setTitle("");
      setContent("");
      setSourceUrl("");
      void qc.invalidateQueries({ queryKey: qk.knowledge(ctx.workspaceId) });
    },
    onError: () => {
      setError("error");
    },
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      setError("invalid_title");
      return;
    }
    if (sourceType === "url") {
      if (!sourceUrl.trim()) {
        setError("invalid_url");
        return;
      }
    } else if (!content.trim()) {
      setError("missing_content");
      return;
    }
    setError(null);
    create.mutate();
  };

  const pending = create.isPending;

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="grid gap-2">
        <Label htmlFor={`${idPrefix}-title`}>Title</Label>
        <Input
          id={`${idPrefix}-title`}
          name="title"
          placeholder={sourceType === "url" ? "Shipping policy" : "Returns policy"}
          required
          disabled={pending}
          value={title}
          onChange={(e) => setTitle(e.currentTarget.value)}
        />
      </div>
      {sourceType === "url" ? (
        <div className="grid gap-2">
          <Label htmlFor="url-source">Page URL</Label>
          <Input
            id="url-source"
            name="sourceUrl"
            type="url"
            inputMode="url"
            placeholder="https://yourstore.com/policies/shipping"
            required
            disabled={pending}
            aria-describedby="url-hint"
            value={sourceUrl}
            onChange={(e) => setSourceUrl(e.currentTarget.value)}
          />
          <p id="url-hint" className="text-xs text-muted-foreground">
            We fetch the page once and store a snapshot of its text. You can
            re-sync it later from the document&apos;s page.
          </p>
        </div>
      ) : (
        <div className="grid gap-2">
          <Label htmlFor="paste-content">Text</Label>
          <Textarea
            id="paste-content"
            name="content"
            rows={8}
            placeholder="Paste your shipping policy, returns policy, FAQ, …"
            required
            disabled={pending}
            value={content}
            onChange={(e) => setContent(e.currentTarget.value)}
          />
        </div>
      )}
      {error ? (
        <Alert variant="warning">
          <AlertDescription>{knowledgeErrorMessage(error)}</AlertDescription>
        </Alert>
      ) : null}
      <Button type="submit" disabled={pending}>
        {pending
          ? sourceType === "url"
            ? "Fetching…"
            : "Saving…"
          : sourceType === "url"
            ? "Fetch & save"
            : "Save document"}
      </Button>
    </form>
  );
}

// The store's structured shipping facts. These sit next to the pasted policy
// documents because two of them aren't prose the agent reads — they're numbers
// it acts on. The delivery time is the window lateness is judged against, and
// the delay threshold is the exact point past which the agent opens a supplier
// check, so both travel to the agent directly rather than through search.
function ShippingProfileForm({
  profile,
  ctx,
}: {
  readonly profile: ShippingProfileView | null;
  readonly ctx: Ctx;
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

  const save = useMutation({
    mutationFn: (input: {
      readonly processingTime: string;
      readonly deliveryTime: string;
      readonly shippingCost: string | null;
      readonly customsDuties: CustomsDutiesPayerView | null;
      readonly delayedAfterDays: number;
      readonly lostPackageInvestigationDays: number | null;
    }) => api.setShippingProfile(ctx, input),
    onSuccess: (res) => {
      if (res.status !== 200) {
        setError("Something went wrong. Please check the fields and try again.");
        return;
      }
      setError(null);
      toast.success("Shipping details saved.");
      void qc.invalidateQueries({ queryKey: qk.settings(ctx.workspaceId) });
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
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="processingTime">
            Order processing time before shipment
          </Label>
          <Input
            id="processingTime"
            placeholder="1–2 business days"
            required
            disabled={pending}
            value={processingTime}
            onChange={(e) => setProcessingTime(e.currentTarget.value)}
          />
        </div>
        <div className="grid gap-2">
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
          <p id="delivery-hint" className="text-xs text-muted-foreground">
            Average time from shipment to delivery.
          </p>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="shippingCost">
            Shipping cost &amp; free-shipping threshold
          </Label>
          <Input
            id="shippingCost"
            placeholder="$4.95, free over $50"
            disabled={pending}
            value={shippingCost}
            onChange={(e) => setShippingCost(e.currentTarget.value)}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="customsDuties">
            Customs / import duties — who pays?
          </Label>
          <select
            id="customsDuties"
            disabled={pending}
            value={customsDuties}
            onChange={(e) => setCustomsDuties(e.currentTarget.value)}
            className="h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
          >
            <option value="">Not specified</option>
            <option value="customer">The customer pays</option>
            <option value="merchant">We pay</option>
            <option value="not_applicable">Doesn&apos;t apply</option>
          </select>
        </div>
      </div>

      <div className="grid gap-2 sm:max-w-sm">
        <Label htmlFor="delayedAfterDays">
          After how many days in transit should a shipment be treated as
          delayed?
        </Label>
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
        <p id="delay-hint" className="text-xs text-muted-foreground">
          Your agents open a supplier check past this point instead of telling
          the customer the order is on schedule.
        </p>
      </div>

      <div className="grid gap-2 sm:max-w-sm">
        <Label htmlFor="lostPackageInvestigationDays">
          After how many days in transit should a package be treated as lost?
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
        <p id="lost-hint" className="text-xs text-muted-foreground">
          Past this point your agents stop waiting and make the customer whole —
          a refund or reshipment — instead of only checking with the supplier.
          Optional; leave blank if you handle this case by case.
        </p>
      </div>

      {error ? (
        <Alert variant="warning">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Save shipping details"}
      </Button>
    </form>
  );
}

// The store's structured returns facts. Like the shipping profile, the return
// window is a number the agent branches on (in-policy vs not) rather than prose
// it reads, and the payer / method / processing-time are values it quotes to the
// customer — so they travel to the agent directly instead of through search.
function ReturnsFactsForm({
  facts,
  ctx,
}: {
  readonly facts: ReturnsFactsView | null;
  readonly ctx: Ctx;
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
      toast.success("Returns details saved.");
      void qc.invalidateQueries({ queryKey: qk.settings(ctx.workspaceId) });
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
  const selectClass =
    "h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50";

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="grid gap-2 sm:max-w-sm">
        <Label htmlFor="returnWindowDays">
          How many days after delivery can a customer return an item?
        </Label>
        <Input
          id="returnWindowDays"
          type="number"
          inputMode="numeric"
          min={1}
          placeholder="30"
          required
          disabled={pending}
          value={returnWindowDays}
          onChange={(e) => setReturnWindowDays(e.currentTarget.value)}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="returnShippingPayer">
            Return shipping — who pays?
          </Label>
          <select
            id="returnShippingPayer"
            disabled={pending}
            value={returnShippingPayer}
            onChange={(e) => setReturnShippingPayer(e.currentTarget.value)}
            className={selectClass}
          >
            <option value="">Not specified</option>
            <option value="customer">The customer pays</option>
            <option value="merchant">We pay (free returns)</option>
            <option value="depends">It depends</option>
          </select>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="refundMethod">How are refunds issued?</Label>
          <select
            id="refundMethod"
            disabled={pending}
            value={refundMethod}
            onChange={(e) => setRefundMethod(e.currentTarget.value)}
            className={selectClass}
          >
            <option value="">Not specified</option>
            <option value="original">To the original payment method</option>
            <option value="store_credit">As store credit</option>
            <option value="customer_choice">The customer chooses</option>
          </select>
        </div>
      </div>

      <div className="grid gap-2 sm:max-w-sm">
        <Label htmlFor="refundProcessingTime">Refund processing time</Label>
        <Input
          id="refundProcessingTime"
          placeholder="5–7 business days after we receive the item"
          disabled={pending}
          aria-describedby="refund-time-hint"
          value={refundProcessingTime}
          onChange={(e) => setRefundProcessingTime(e.currentTarget.value)}
        />
        <p id="refund-time-hint" className="text-xs text-muted-foreground">
          What your agents tell a customer to expect once a refund is started.
        </p>
      </div>

      {error ? (
        <Alert variant="warning">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Save returns details"}
      </Button>
    </form>
  );
}

export function KnowledgePage() {
  const allowed = useRequirePermission("knowledge.view");
  const ctx = useWorkspaceCtx();

  const { data, isLoading } = useQuery({
    queryKey: qk.knowledge(ctx.workspaceId),
    queryFn: () => api.knowledge(ctx),
    enabled: allowed,
  });

  const settingsQuery = useQuery({
    queryKey: qk.settings(ctx.workspaceId),
    queryFn: () => api.settings(ctx),
    enabled: allowed,
  });

  if (!allowed) return null;

  const documents = data ?? [];

  return (
    <div className="space-y-6">
      <SettingsBreadcrumb current="Knowledge base" />

      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Knowledge base</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Add your store policies — shipping, returns, refunds, FAQs — by pasting
          the text or linking a page. Your support agents read these when
          answering customers and deciding refunds, so they follow your policies
          instead of guessing.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Truck className="size-4" aria-hidden />
            Shipping &amp; delivery
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 pt-0">
          <p className="text-sm text-muted-foreground">
            Your agents quote these to customers and use them to judge whether an
            order is running late. Filling them in is the difference between an
            agent that says &ldquo;your order is on the way&rdquo; and one that
            notices it has been stuck for two weeks.
          </p>
          {settingsQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <ShippingProfileForm
              // Remount when the saved profile arrives so the inputs pick up
              // their stored values instead of keeping their initial "".
              key={settingsQuery.data?.shippingProfile ? "loaded" : "empty"}
              profile={settingsQuery.data?.shippingProfile ?? null}
              ctx={ctx}
            />
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
            asks for a refund, and use the return window to tell an in-policy
            return from a late one — instead of guessing from your documents.
          </p>
          {settingsQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <ReturnsFactsForm
              // Remount when the saved facts arrive so the inputs pick up their
              // stored values instead of keeping their initial "".
              key={settingsQuery.data?.returnsFacts ? "loaded" : "empty"}
              facts={settingsQuery.data?.returnsFacts ?? null}
              ctx={ctx}
            />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <BookOpen className="size-4" aria-hidden />
            Your documents
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : documents.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No documents yet. Add your first one below.
            </p>
          ) : (
            <ul className="divide-y divide-border rounded-md border">
              {documents.map((doc) => (
                <li
                  key={doc.id}
                  className="flex items-center justify-between gap-3 px-4 py-3"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">{doc.title}</span>
                      <Badge variant="secondary" className="shrink-0 gap-1">
                        {doc.sourceType === "url" ? (
                          <Link2 className="size-3" aria-hidden />
                        ) : (
                          <FileText className="size-3" aria-hidden />
                        )}
                        {doc.sourceType === "url" ? "URL" : "Pasted"}
                      </Badge>
                    </div>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {doc.sourceType === "url" && doc.sourceUrl
                        ? doc.sourceUrl
                        : `Updated ${doc.updatedAt.slice(0, 10)}`}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button asChild variant="outline" size="sm">
                      <Link href={`/settings/knowledge/${doc.id}`}>
                        <Pencil className="size-3.5" aria-hidden />
                        Edit
                      </Link>
                    </Button>
                    <DeleteDocButton doc={doc} ctx={ctx} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <FileText className="size-4" aria-hidden />
              Paste a document
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <KnowledgeCreateForm sourceType="text" ctx={ctx} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Link2 className="size-4" aria-hidden />
              Add from a URL
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <KnowledgeCreateForm sourceType="url" ctx={ctx} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
