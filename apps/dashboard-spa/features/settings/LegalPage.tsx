import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { FileText, ShieldCheck } from "lucide-react";

import { api } from "@/lib/api-client";
import { qk } from "@/lib/query-keys";
import { useWorkspaceCtx } from "@/lib/session-context";
import { dataProcessingNoticeUrl } from "@/lib/legal";
import { formatRelativeTime } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Link } from "@/components/ui/link";
import { SettingsBreadcrumb } from "@/components/settings-breadcrumb";

export function LegalPage() {
  const ctx = useWorkspaceCtx();
  const qc = useQueryClient();
  const noticeUrl = dataProcessingNoticeUrl();

  const settingsQuery = useQuery({
    queryKey: qk.settings(ctx.workspaceId),
    queryFn: () => api.settings(ctx),
  });

  const acceptM = useMutation({
    mutationFn: async () => {
      const res = await api.acceptLegal(ctx);
      if (res.status !== 200) throw new Error("accept_failed");
      return res;
    },
    onSuccess: () => {
      toast.success("Legal terms accepted.");
      // Mirrors the action's revalidatePath targets: /settings + /settings/legal
      // (settings), /settings/integrations (connections), /settings/llm (llm).
      qc.invalidateQueries({ queryKey: qk.settings(ctx.workspaceId) });
      qc.invalidateQueries({ queryKey: qk.connections(ctx.workspaceId) });
      qc.invalidateQueries({ queryKey: qk.llm(ctx.workspaceId) });
    },
    onError: () => {
      toast.warning("Could not record acceptance. Please try again.");
    },
  });

  const legal = settingsQuery.data?.legalAcceptance ?? null;

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

      {settingsQuery.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
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
              <Button
                type="submit"
                onClick={() => acceptM.mutate()}
                disabled={acceptM.isPending}
              >
                {legal ? "Accept current versions" : "Accept and continue"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
