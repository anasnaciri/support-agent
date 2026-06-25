import { BookOpen, FileText, Link2, Pencil } from "lucide-react";

import { api, getDashboardContext } from "@/lib/api-client";
import {
  resolveFeedback,
  type FeedbackRule,
  type ResolvedToast,
} from "@/lib/toast-feedback";
import { FeedbackToaster } from "@/components/ui/feedback-toaster";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmSubmitButton } from "@/components/ui/confirm-submit-button";
import { SettingsBreadcrumb } from "@/app/settings/_components/settings-breadcrumb";

import { deleteKnowledgeAction } from "./actions";
import { KnowledgeCreateForm } from "./_create-form";
import { knowledgeErrorMessage } from "./_messages";

interface PageProps {
  readonly searchParams?: Promise<
    Readonly<Record<string, string | string[] | undefined>>
  >;
}

const one = (
  v: string | string[] | undefined,
): string | undefined => (Array.isArray(v) ? v[0] : v);

const FEEDBACK: readonly FeedbackRule[] = [
  { param: "saved", kind: "success", message: "Document saved." },
  { param: "deleted", kind: "success", message: "Document deleted." },
];

export default async function KnowledgePage({ searchParams }: PageProps) {
  const ctx = await getDashboardContext();
  const documents = await api.knowledge(ctx);
  const params = (await searchParams) ?? {};

  const { toasts, consume } = resolveFeedback(params, FEEDBACK);
  // The `error` codes carry a compact reason (`fetch_failed:timeout`, …); the
  // friendly text comes from the shared message map rather than an enumeration.
  const errorCode = one(params["error"]);
  const feedbackToasts: ResolvedToast[] = [...toasts];
  const feedbackConsume = [...consume];
  if (errorCode) {
    feedbackToasts.push({
      kind: "warning",
      message: knowledgeErrorMessage(errorCode),
    });
    feedbackConsume.push("error");
  }

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

      <FeedbackToaster toasts={feedbackToasts} consume={feedbackConsume} />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <BookOpen className="size-4" aria-hidden />
            Your documents
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {documents.length === 0 ? (
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
                      <a href={`/settings/knowledge/${doc.id}`}>
                        <Pencil className="size-3.5" aria-hidden />
                        Edit
                      </a>
                    </Button>
                    <form action={deleteKnowledgeAction}>
                      <input type="hidden" name="id" value={doc.id} />
                      <ConfirmSubmitButton
                        variant="ghost"
                        size="sm"
                        title={`Delete “${doc.title}”?`}
                        description="Your agents stop referencing this document immediately. This can't be undone."
                        confirmLabel="Delete document"
                      >
                        Delete
                      </ConfirmSubmitButton>
                    </form>
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
            <KnowledgeCreateForm sourceType="text" />
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
            <KnowledgeCreateForm sourceType="url" />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
