import { ThreadId } from "@support-agent/agent-core";
import type { ConnectorProvider } from "./connector-credential-store.js";

// ============================================================
// Provider-namespaced thread ids
// ============================================================
//
// A tenant can hold several conversation connectors at once (Gmail +
// Outlook + IMAP). The runtime keys tickets on an opaque `ThreadId`, so the
// provider a thread lives on is encoded INTO the id at the connector
// boundary: `gmail:<gmail threadId>`, `outlook:<Graph conversationId>`,
// `imap:<RFC 5322 root Message-ID>`. Inbound edges namespace before
// publishing `message.received`; the conversation router parses the prefix
// to dispatch and hands the connector the raw provider id. Everything
// between — events, tickets, tools, agents — stays provider-blind.

/** Connector providers that carry customer conversations. */
export const CONVERSATION_PROVIDERS = ["gmail", "outlook", "imap"] as const;

export type ConversationProviderId = (typeof CONVERSATION_PROVIDERS)[number];

export const isConversationProvider = (
  provider: string,
): provider is ConversationProviderId =>
  (CONVERSATION_PROVIDERS as ReadonlyArray<string>).includes(provider);

/** Subset of `ConnectorProvider` — enforced at compile time. */
type _AssertSubset = ConversationProviderId & ConnectorProvider;

export const namespaceThreadId = (
  provider: ConversationProviderId,
  rawId: string,
): ThreadId => ThreadId(`${provider}:${rawId}`);

/**
 * Split a namespaced thread id back into provider + raw provider id. Only
 * the FIRST colon splits — raw ids (e.g. IMAP Message-IDs) may contain
 * colons of their own. Returns `null` for unknown prefixes, missing
 * prefixes, and empty raw ids; callers decide how to fail.
 */
export const parseThreadId = (
  threadId: string,
): { readonly provider: ConversationProviderId; readonly raw: ThreadId } | null => {
  const sep = threadId.indexOf(":");
  if (sep <= 0) return null;
  const provider = threadId.slice(0, sep);
  const raw = threadId.slice(sep + 1);
  if (!isConversationProvider(provider) || raw.length === 0) return null;
  return { provider, raw: ThreadId(raw) };
};
