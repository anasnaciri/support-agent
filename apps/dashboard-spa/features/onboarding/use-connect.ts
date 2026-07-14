import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import type {
  ConnectorConnectionView,
  OnboardingStepKeyView,
} from "@support-agent/dashboard-contracts";

import { api } from "@/lib/api-client";
import { qk } from "@/lib/query-keys";
import { useWorkspaceCtx } from "@/lib/session-context";
import { connectRedirectUrl } from "@/lib/connect-redirect";
import { connectErrorMessage } from "@/lib/connect-error";

/**
 * Start a connector OAuth install from inside the wizard.
 *
 * The browser leaves the SPA entirely (Shopify's / Google's consent screen) and
 * comes back to `/settings/integrations?connected=…`, where the shell's gate
 * bounces a still-onboarding merchant back to the wizard. That works only if
 * the wizard first records WHERE the merchant was: we persist the resume
 * pointer before handing off, and await it — a redirect that races the write
 * would drop the merchant back at the top of the wizard.
 */
export const useWizardConnect = (step: OnboardingStepKeyView) => {
  const ctx = useWorkspaceCtx();

  return useMutation({
    mutationFn: async (provider: string) => {
      await api.onboardingAdvance(ctx, { nextStep: step });
      const result = await api.connectUrl(ctx, provider);
      if ("denied" in result) return { denied: result.denied };
      if ("alreadyConnected" in result) return { alreadyConnected: true };
      window.location.assign(connectRedirectUrl(result.url, provider, null));
      return { redirecting: true };
    },
    onSuccess: (result) => {
      if ("denied" in result && result.denied) {
        toast.warning(connectErrorMessage(result.denied));
      }
    },
    onError: () =>
      toast.warning("Couldn't start the connection. Please try again."),
  });
};

/** The workspace's connector rows — how every step knows whether it's done. */
export const useConnections = () => {
  const ctx = useWorkspaceCtx();
  return useQuery({
    queryKey: qk.connections(ctx.workspaceId),
    queryFn: () => api.connections(ctx),
  });
};

export const activeConnection = (
  connections: ReadonlyArray<ConnectorConnectionView> | undefined,
  provider: string,
): ConnectorConnectionView | undefined =>
  connections?.find((c) => c.provider === provider && c.status === "active");
