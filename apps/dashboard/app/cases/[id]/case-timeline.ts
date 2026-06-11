import type {
  CaseConversationThreadUnavailableReason,
} from "@support-agent/dashboard-contracts";

export type CaseTimelineMode = "full" | "simplified" | "email";

export const parseCaseTimelineMode = (
  value: string | undefined,
): CaseTimelineMode =>
  value === "simplified" || value === "email" ? value : "full";

export const buildCaseTimelineHref = (
  caseId: string,
  params: Readonly<Record<string, string | undefined>>,
  mode: CaseTimelineMode,
): string => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) query.set(key, value);
  }
  if (mode === "full") {
    query.delete("timeline");
  } else {
    query.set("timeline", mode);
  }
  const search = query.toString();
  return search ? `/cases/${caseId}?${search}` : `/cases/${caseId}`;
};

const formatUnit = (value: number, unit: string): string => {
  const rounded =
    value >= 10 || Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1);
  return `${rounded} ${unit}`;
};

export const formatAttachmentSize = (sizeBytes: number): string => {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return formatUnit(sizeBytes / 1024, "KB");
  return formatUnit(sizeBytes / (1024 * 1024), "MB");
};

export const conversationThreadUnavailableView = (
  reason: CaseConversationThreadUnavailableReason,
): {
  readonly title: string;
  readonly description: string;
  readonly showIntegrationsLink: boolean;
} => {
  switch (reason) {
    case "no_thread":
      return {
        title: "No email thread linked",
        description: "This case is not linked to a customer email conversation.",
        showIntegrationsLink: false,
      };
    case "thread_not_found":
      return {
        title: "Email thread not found",
        description: "The connected mailbox no longer contains this conversation.",
        showIntegrationsLink: false,
      };
    case "auth_required":
      return {
        title: "Reconnect the mailbox",
        description:
          "The connected mailbox must be reconnected before its email thread can be loaded.",
        showIntegrationsLink: true,
      };
    case "mailbox_ambiguous":
      return {
        title: "Mailbox cannot be safely identified",
        description:
          "This older case is not bound to a specific mailbox, and more than one matching mailbox is connected.",
        showIntegrationsLink: true,
      };
    case "provider_unavailable":
      return {
        title: "Email provider temporarily unavailable",
        description: "Refresh the page to try loading the live email thread again.",
        showIntegrationsLink: false,
      };
  }
};
