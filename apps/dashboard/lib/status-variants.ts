import type { BadgeProps } from "@/components/ui/badge";

type Variant = NonNullable<BadgeProps["variant"]>;

// Tickets, audit, and approvals use the brighter, more-saturated *Bright badge
// variants so status colors pop. Neutral/waiting states stay quiet (muted) for
// hierarchy. The settings helpers below keep the calmer base tints.
export const ticketStatusVariant = (status: string): Variant => {
  switch (status) {
    case "resolved":
      return "successBright";
    case "archived":
      return "secondary";
    case "human_takeover":
      return "destructiveBright";
    case "waiting_for_approval":
      // Calmer amber, not the bright yellow — the vivid hue read low-contrast
      // on the off-white background.
      return "warning";
    case "waiting_for_customer":
    case "waiting_for_fulfillment_operator":
      return "muted";
    case "new":
    case "triaging":
    case "in_progress":
      return "infoBright";
    default:
      return "secondary";
  }
};

export const approvalStatusVariant = (status: string): Variant => {
  switch (status) {
    case "pending":
      // Calmer amber, not the bright yellow — low contrast on the off-white
      // background (mirrors ticketStatusVariant's waiting_for_approval).
      return "warning";
    case "approved":
      return "successBright";
    case "rejected":
      return "destructiveBright";
    default:
      return "secondary";
  }
};

export const riskVariant = (
  risk: string | null | undefined,
): Variant => {
  switch (risk) {
    case "low":
      return "successBright";
    case "medium":
      // Calmer amber, not the bright yellow — low contrast on the off-white
      // background.
      return "warning";
    case "high":
    case "critical":
      return "destructiveBright";
    default:
      return "muted";
  }
};

export const permissionVariant = (
  perm: string | null | undefined,
): Variant => {
  switch (perm) {
    case "allow":
      return "success";
    case "ask":
      return "warning";
    case "deny":
      return "destructive";
    default:
      return "muted";
  }
};

export const integrationStatusVariant = (status: string): Variant => {
  switch (status) {
    case "active":
      return "success";
    case "revoked":
      return "destructive";
    default:
      return "muted";
  }
};

export const actorVariant = (actorType: string): Variant => {
  switch (actorType) {
    case "system":
      return "muted";
    case "agent":
      return "infoBright";
    case "user":
      return "successBright";
    default:
      return "secondary";
  }
};
