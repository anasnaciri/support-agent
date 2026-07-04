import { Workflow } from "lucide-react";

import { api, getDashboardContext } from "@/lib/api-client";
import { resolveFeedback, type FeedbackRule } from "@/lib/toast-feedback";
import { FeedbackToaster } from "@/components/ui/feedback-toaster";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SettingsBreadcrumb } from "@/app/settings/_components/settings-breadcrumb";

import { ResolutionAgentToggle } from "./resolution-agent-toggle";
import { ResolutionPolicyForm } from "./resolution-policy-form";

const FEEDBACK: readonly FeedbackRule[] = [
  { param: "saved", kind: "success", message: "Scenarios saved." },
];

interface PageProps {
  readonly searchParams?: Promise<
    Readonly<Record<string, string | string[] | undefined>>
  >;
}

export default async function ResolutionPolicyPage({ searchParams }: PageProps) {
  const ctx = await getDashboardContext();
  const policy = await api.resolutionPolicy(ctx);
  const feedback = resolveFeedback((await searchParams) ?? {}, FEEDBACK);

  return (
    <div className="space-y-6">
      <SettingsBreadcrumb current="Resolution agent" />

      <div>
        <h1 className="text-3xl font-semibold tracking-tight">
          Resolution agent
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          A single agent that resolves tickets end-to-end, steered by the
          scenarios below. When it&apos;s on, triage routes a matching ticket to
          it; it gathers what it needs, takes the actions you&apos;ve allowed,
          and drafts the customer reply — pausing for your approval on anything
          you marked <em>Ask me first</em>. Leave it off to keep today&apos;s
          routing.
        </p>
      </div>

      <FeedbackToaster toasts={feedback.toasts} consume={feedback.consume} />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Workflow className="size-4" aria-hidden />
            Status
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <ResolutionAgentToggle enabled={policy.resolutionAgentEnabled} />
          <p className="mt-2 text-xs text-muted-foreground">
            {policy.resolutionAgentEnabled
              ? "On — new matching tickets go to the resolution agent."
              : "Off — tickets route to the built-in specialists as before."}
          </p>
        </CardContent>
      </Card>

      <div>
        <h2 className="text-lg font-semibold tracking-tight">Scenarios</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          For each situation, choose what the agent may do and whether it acts
          automatically or asks you first. The built-in scenarios cover the
          common tickets; add your own for anything specific to your store —
          describe when it applies and the agent will route matching messages to
          it.
        </p>
      </div>

      {!policy.resolutionAgentEnabled ? (
        <Alert variant="info">
          <AlertDescription>
            These settings take effect only while the resolution agent is on.
          </AlertDescription>
        </Alert>
      ) : null}

      <ResolutionPolicyForm scenarios={policy.scenarios} />
    </div>
  );
}
