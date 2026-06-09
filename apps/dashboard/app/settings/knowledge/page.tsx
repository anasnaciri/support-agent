import { BookOpen, FileText, Link2, Pencil } from "lucide-react";

import { api, getDashboardContext } from "@/lib/api-client";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SettingsBreadcrumb } from "@/app/settings/_components/settings-breadcrumb";

import { createKnowledgeAction, deleteKnowledgeAction } from "./actions";
import { knowledgeErrorMessage } from "./_messages";

interface PageProps {
  readonly searchParams?: Promise<
    Readonly<Record<string, string | string[] | undefined>>
  >;
}

const one = (
  v: string | string[] | undefined,
): string | undefined => (Array.isArray(v) ? v[0] : v);

export default async function KnowledgePage({ searchParams }: PageProps) {
  const ctx = await getDashboardContext();
  const documents = await api.knowledge(ctx);
  const params = (await searchParams) ?? {};

  const saved = one(params["saved"]) === "1";
  const deleted = one(params["deleted"]) === "1";
  const errorCode = one(params["error"]);

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

      {saved ? (
        <Alert variant="success">
          <AlertDescription>Document saved.</AlertDescription>
        </Alert>
      ) : null}
      {deleted ? (
        <Alert variant="success">
          <AlertDescription>Document deleted.</AlertDescription>
        </Alert>
      ) : null}
      {errorCode ? (
        <Alert variant="warning">
          <AlertDescription>{knowledgeErrorMessage(errorCode)}</AlertDescription>
        </Alert>
      ) : null}

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
                      <Button type="submit" variant="ghost" size="sm">
                        Delete
                      </Button>
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
            <form action={createKnowledgeAction} className="space-y-4">
              <input type="hidden" name="sourceType" value="text" />
              <div className="grid gap-2">
                <Label htmlFor="paste-title">Title</Label>
                <Input
                  id="paste-title"
                  name="title"
                  placeholder="Returns policy"
                  required
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="paste-content">Text</Label>
                <Textarea
                  id="paste-content"
                  name="content"
                  rows={8}
                  placeholder="Paste your shipping policy, returns policy, FAQ, …"
                  required
                />
              </div>
              <Button type="submit">Save document</Button>
            </form>
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
            <form action={createKnowledgeAction} className="space-y-4">
              <input type="hidden" name="sourceType" value="url" />
              <div className="grid gap-2">
                <Label htmlFor="url-title">Title</Label>
                <Input
                  id="url-title"
                  name="title"
                  placeholder="Shipping policy"
                  required
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="url-source">Page URL</Label>
                <Input
                  id="url-source"
                  name="sourceUrl"
                  type="url"
                  inputMode="url"
                  placeholder="https://yourstore.com/policies/shipping"
                  required
                  aria-describedby="url-hint"
                />
                <p id="url-hint" className="text-xs text-muted-foreground">
                  We fetch the page once and store a snapshot of its text. You can
                  re-sync it later from the document&apos;s page.
                </p>
              </div>
              <Button type="submit">Fetch &amp; save</Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
