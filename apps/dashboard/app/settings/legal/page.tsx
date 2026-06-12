import Link from "next/link";
import { FileText, ShieldCheck } from "lucide-react";

import { api, getDashboardContext } from "@/lib/api-client";
import { dataProcessingNoticeUrl } from "@/lib/legal";
import { formatRelativeTime } from "@/lib/format";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SettingsBreadcrumb } from "@/app/settings/_components/settings-breadcrumb";

import { acceptLegalAction } from "./actions";

interface PageProps {
  readonly searchParams?: Promise<
    Readonly<Record<string, string | string[] | undefined>>
  >;
}

export default async function LegalSettingsPage({ searchParams }: PageProps) {
  const ctx = await getDashboardContext();
  const params = (await searchParams) ?? {};
  const acceptedBanner =
    (Array.isArray(params["accepted"])
      ? params["accepted"][0]
      : params["accepted"]) === "1";
  const errorRaw = Array.isArray(params["error"])
    ? params["error"][0]
    : params["error"];
  const [settings, noticeUrl] = await Promise.all([
    api.settings(ctx),
    Promise.resolve(dataProcessingNoticeUrl()),
  ]);
  const legal = settings.legalAcceptance;

  return (
    <div className="space-y-6">
      <SettingsBreadcrumb current="Legal" />

      <div>
        <h1 className="text-3xl font-semibold tracking-tight">Legal</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Accounts can only be connected after you accept the current data
          processing notice and addendum.
        </p>
      </div>

      {acceptedBanner ? (
        <Alert variant="success">
          <AlertDescription>Legal terms accepted.</AlertDescription>
        </Alert>
      ) : null}
      {errorRaw === "accept_failed" ? (
        <Alert variant="warning">
          <AlertDescription>
            Could not record acceptance. Please try again.
          </AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldCheck className="size-4" aria-hidden />
              Data processing acceptance
            </CardTitle>
            <Badge variant={legal ? "success" : "warning"}>
              {legal ? "accepted" : "required"}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4 pt-0">
          {legal ? (
            <div className="space-y-1 text-sm">
              <p>
                Accepted{" "}
                <span className="font-medium text-foreground">
                  {formatRelativeTime(legal.acceptedAt)}
                </span>
                .
              </p>
              <p className="text-xs text-muted-foreground">
                Notice version{" "}
                <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                  {legal.dataProcessingNoticeVersion}
                </code>{" "}
                · DPA version{" "}
                <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                  {legal.dpaVersion}
                </code>
              </p>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              Accept once for this workspace before connecting Shopify, Gmail,
              Google Sheets, or an AI provider.
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {noticeUrl ? (
              <Button variant="outline" asChild>
                <a href={noticeUrl} target="_blank" rel="noreferrer">
                  <FileText className="size-4" aria-hidden />
                  View notice
                </a>
              </Button>
            ) : (
              <Button variant="outline" asChild>
                <Link href="/settings/legal">
                  <FileText className="size-4" aria-hidden />
                  View notice
                </Link>
              </Button>
            )}
            <form action={acceptLegalAction}>
              <Button type="submit">
                {legal ? "Accept current versions" : "Accept and continue"}
              </Button>
            </form>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
