import { notFound } from "next/navigation";
import { FileText, Link2, RefreshCw } from "lucide-react";

import { api, getDashboardContext } from "@/lib/api-client";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SettingsBreadcrumb } from "@/app/settings/_components/settings-breadcrumb";

import {
  deleteKnowledgeAction,
  resyncKnowledgeAction,
  updateKnowledgeAction,
} from "../actions";
import { knowledgeErrorMessage } from "../_messages";

interface PageProps {
  readonly params: Promise<{ id: string }>;
  readonly searchParams?: Promise<
    Readonly<Record<string, string | string[] | undefined>>
  >;
}

const one = (
  v: string | string[] | undefined,
): string | undefined => (Array.isArray(v) ? v[0] : v);

export default async function KnowledgeEditPage({
  params,
  searchParams,
}: PageProps) {
  const { id } = await params;
  const ctx = await getDashboardContext();
  const doc = await api.knowledgeDoc(ctx, id);
  if (!doc) notFound();

  const sp = (await searchParams) ?? {};
  const saved = one(sp["saved"]) === "1";
  const resynced = one(sp["resynced"]);
  const errorCode = one(sp["error"]);
  const isUrl = doc.sourceType === "url";

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

      {saved ? (
        <Alert variant="success">
          <AlertDescription>Document saved.</AlertDescription>
        </Alert>
      ) : null}
      {resynced === "changed" ? (
        <Alert variant="success">
          <AlertDescription>Re-synced — the page content changed.</AlertDescription>
        </Alert>
      ) : null}
      {resynced === "nochange" ? (
        <Alert variant="info">
          <AlertDescription>
            Re-synced — the page content was unchanged.
          </AlertDescription>
        </Alert>
      ) : null}
      {errorCode ? (
        <Alert variant="warning">
          <AlertDescription>{knowledgeErrorMessage(errorCode)}</AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">
            {isUrl ? "Title" : "Edit document"}
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <form action={updateKnowledgeAction} className="space-y-4">
            <input type="hidden" name="id" value={doc.id} />
            <div className="grid gap-2">
              <Label htmlFor="title">Title</Label>
              <Input id="title" name="title" defaultValue={doc.title} required />
            </div>
            {!isUrl ? (
              <div className="grid gap-2">
                <Label htmlFor="content">Text</Label>
                <Textarea
                  id="content"
                  name="content"
                  rows={12}
                  defaultValue={doc.content}
                  required
                />
              </div>
            ) : null}
            <Button type="submit">Save</Button>
          </form>
        </CardContent>
      </Card>

      {isUrl ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Link2 className="size-4" aria-hidden />
              Snapshot
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
              agents read this snapshot — re-sync to pull the latest page.
            </p>
            <form action={resyncKnowledgeAction}>
              <input type="hidden" name="id" value={doc.id} />
              <Button type="submit" variant="outline" size="sm">
                <RefreshCw className="size-3.5" aria-hidden />
                Re-sync
              </Button>
            </form>
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
          <form action={deleteKnowledgeAction}>
            <input type="hidden" name="id" value={doc.id} />
            <Button type="submit" variant="destructive" size="sm">
              Delete document
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
