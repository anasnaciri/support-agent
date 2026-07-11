import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { toast } from "sonner";
import { FileText, Link2, RefreshCw } from "lucide-react";

import { api } from "@/lib/api-client";
import { qk } from "@/lib/query-keys";
import { useWorkspaceCtx } from "@/lib/session-context";
import { useRequirePermission } from "@/lib/require-permission";
import { useAppNavigate } from "@/lib/navigation";
import { knowledgeErrorMessage } from "@/lib/knowledge-messages";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Link } from "@/components/ui/link";
import { Textarea } from "@/components/ui/textarea";
import { SettingsBreadcrumb } from "@/components/settings-breadcrumb";
import { ConfirmButton } from "@/features/tickets/ConfirmButton";
import type { KnowledgeDocumentView } from "@support-agent/dashboard-contracts";

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

// The document editor. Split out so its controlled fields seed from the loaded
// doc (it only mounts once the doc query resolves). Holds the edit form, the
// URL snapshot / re-sync card, and the delete card.
function DocDetail({
  doc,
  ctx,
}: {
  readonly doc: KnowledgeDocumentView;
  readonly ctx: Ctx;
}) {
  const qc = useQueryClient();
  const nav = useAppNavigate();
  const isUrl = doc.sourceType === "url";

  const [title, setTitle] = useState(doc.title);
  const [content, setContent] = useState(doc.content);

  const invalidate = (): void => {
    void qc.invalidateQueries({ queryKey: qk.knowledgeDoc(ctx.workspaceId, doc.id) });
    void qc.invalidateQueries({ queryKey: qk.knowledge(ctx.workspaceId) });
  };

  const update = useMutation({
    mutationFn: () => {
      const input: { title?: string; content?: string } = {};
      if (title.trim()) input.title = title.trim();
      // The content field is only present on the text-doc edit form.
      if (!isUrl) input.content = content;
      return api.updateKnowledge(ctx, doc.id, input);
    },
    onSuccess: (res) => {
      if (res.status !== 200) {
        toast.warning(knowledgeErrorMessage(failCode(res.body)));
        return;
      }
      toast.success("Document saved.");
      invalidate();
    },
    onError: () => {
      toast.warning("Something went wrong. Please try again.");
    },
  });

  const resync = useMutation({
    mutationFn: () => api.resyncKnowledge(ctx, doc.id),
    onSuccess: (res) => {
      if (res.status !== 200) {
        toast.warning(knowledgeErrorMessage(failCode(res.body)));
        return;
      }
      const changed = (res.body as { changed?: boolean } | null)?.changed === true;
      if (changed) {
        toast.success("Re-synced: the page content changed.");
      } else {
        toast.info("Re-synced: the page content was unchanged.");
      }
      invalidate();
    },
    onError: () => {
      toast.warning("Something went wrong. Please try again.");
    },
  });

  const del = useMutation({
    mutationFn: () => api.deleteKnowledge(ctx, doc.id),
    onSuccess: () => {
      toast.success("Document deleted.");
      void qc.invalidateQueries({ queryKey: qk.knowledge(ctx.workspaceId) });
      nav.replace("/settings/knowledge");
    },
    onError: () => {
      toast.warning("Something went wrong. Please try again.");
    },
  });

  const onUpdate = (e: FormEvent) => {
    e.preventDefault();
    update.mutate();
  };

  return (
    <div className="space-y-6">
      <SettingsBreadcrumb
        items={[{ href: "/settings/knowledge", label: "Knowledge base" }]}
        current={doc.title}
      />

      <div className="flex items-center gap-3">
        <h1 className="text-3xl font-semibold tracking-tight">{doc.title}</h1>
        <Badge variant="secondary" className="gap-1">
          {isUrl ? (
            <Link2 className="size-3" aria-hidden />
          ) : (
            <FileText className="size-3" aria-hidden />
          )}
          {isUrl ? "URL" : "Pasted"}
        </Badge>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            {isUrl ? "Title" : "Edit document"}
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <form onSubmit={onUpdate} className="space-y-4">
            <div className="grid gap-2">
              <Label htmlFor="title">Title</Label>
              <Input
                id="title"
                name="title"
                required
                value={title}
                onChange={(e) => setTitle(e.currentTarget.value)}
              />
            </div>
            {!isUrl ? (
              <div className="grid gap-2">
                <Label htmlFor="content">Text</Label>
                <Textarea
                  id="content"
                  name="content"
                  rows={12}
                  required
                  value={content}
                  onChange={(e) => setContent(e.currentTarget.value)}
                />
              </div>
            ) : null}
            <Button type="submit" disabled={update.isPending}>
              {update.isPending ? "Saving…" : "Save"}
            </Button>
          </form>
        </CardContent>
      </Card>

      {isUrl ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Link2 className="size-4" aria-hidden />
              Saved copy
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 pt-0">
            <p className="text-sm text-muted-foreground">
              Fetched from{" "}
              <a
                href={doc.sourceUrl ?? "#"}
                target="_blank"
                rel="noreferrer noopener"
                className="text-primary underline-offset-4 hover:underline"
              >
                {doc.sourceUrl}
              </a>
              {doc.fetchedAt ? ` on ${doc.fetchedAt.slice(0, 10)}` : null}. The
              agents read this snapshot, so re-sync to pull the latest page.
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={resync.isPending}
              onClick={() => resync.mutate()}
            >
              <RefreshCw className="size-3.5" aria-hidden />
              {resync.isPending ? "Re-syncing…" : "Re-sync"}
            </Button>
            <Textarea
              readOnly
              rows={12}
              value={doc.content}
              className="bg-muted/40 font-mono text-xs"
            />
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Delete</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <p className="mb-3 text-sm text-muted-foreground">
            Remove this document. Your agents will stop referencing it.
          </p>
          <ConfirmButton
            size="sm"
            title={`Delete “${doc.title}”?`}
            description="Your agents stop referencing this document immediately. This can't be undone."
            confirmLabel="Delete document"
            pending={del.isPending}
            onConfirm={() => del.mutate()}
          >
            Delete document
          </ConfirmButton>
        </CardContent>
      </Card>
    </div>
  );
}

export function KnowledgeDocPage() {
  const allowed = useRequirePermission("knowledge.view");
  const ctx = useWorkspaceCtx();
  const params = useParams({ strict: false });
  const id = (params as { docId?: string }).docId ?? "";

  const { data: doc, isLoading } = useQuery({
    queryKey: qk.knowledgeDoc(ctx.workspaceId, id),
    queryFn: () => api.knowledgeDoc(ctx, id),
    enabled: allowed && id.length > 0,
  });

  if (!allowed) return null;

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }

  if (!doc) {
    return (
      <div className="space-y-3">
        <p className="text-sm font-medium">Document not found</p>
        <Link
          href="/settings/knowledge"
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ← Knowledge base
        </Link>
      </div>
    );
  }

  return <DocDetail doc={doc} ctx={ctx} />;
}
