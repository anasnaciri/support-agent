import type { BadgeProps } from "@/components/ui/badge";

type Variant = NonNullable<BadgeProps["variant"]>;

export const caseStatusVariant = (status: string): Variant => {
  switch (status) {
    case "resolved":
      return "success";
    case "human_takeover":
      return "destructive";
    case "waiting_for_approval":
      return "warning";
    case "waiting_for_customer":
    case "waiting_for_supplier":
      return "muted";
    case "new":
    case "triaging":
    case "in_progress":
      return "info";
    default:
      return "secondary";
  }
};

export const approvalStatusVariant = (status: string): Variant => {
  switch (status) {
    case "pending":
      return "warning";
    case "approved":
      return "success";
    case "rejected":
      return "destructive";
    default:
      return "secondary";
  }
};

export const riskVariant = (
  risk: string | null | undefined,
): Variant => {
  switch (risk) {
    case "low":
      return "success";
    case "medium":
      return "warning";
    case "high":
    case "critical":
      return "destructive";
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
      return "info";
    case "user":
      return "success";
    default:
      return "secondary";
  }
};
