import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { BookOpen, FileText, Link2, Pencil } from "lucide-react";

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
import type { KnowledgeDocumentSummaryView } from "@support-agent/dashboard-contracts";

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

export function KnowledgePage() {
  const allowed = useRequirePermission("knowledge.view");
  const ctx = useWorkspaceCtx();

  const { data, isLoading } = useQuery({
    queryKey: qk.knowledge(ctx.workspaceId),
    queryFn: () => api.knowledge(ctx),
    enabled: allowed,
  });

  if (!allowed) return null;

  const documents = data ?? [];

  return (
    <div className="space-y-6">
      <SettingsBreadcrumb current="Docs" />

      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Docs</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Add your store policies — shipping, returns, refunds, FAQs — by pasting
          the text or linking a page. Your support agents read these when
          answering customers and deciding refunds, so they follow your policies
          instead of guessing. The numbers they act on live in{" "}
          <Link href="/settings/facts" className="underline underline-offset-2">
            Facts
          </Link>
          .
        </p>
      </div>

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
