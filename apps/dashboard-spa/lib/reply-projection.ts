import { useMemo, useRef, useState } from "react";
import type {
  DashboardConversationMessage,
  TicketConversationThreadResult,
} from "@support-agent/dashboard-contracts";

export interface ReplyProjectionActions {
  readonly start: (message: DashboardConversationMessage) => void;
  readonly confirm: (
    optimisticId: string,
    confirmed: DashboardConversationMessage,
  ) => void;
  readonly fail: (optimisticId: string) => void;
}

interface ProjectedReply {
  readonly renderKey: string;
  readonly providerId: string | null;
  readonly message: DashboardConversationMessage;
}

interface ProjectionState {
  readonly scope: string;
  readonly replies: ReadonlyArray<ProjectedReply>;
}

export interface ReplyProjection {
  readonly thread: TicketConversationThreadResult;
  readonly messageKey: (message: DashboardConversationMessage) => string;
  readonly replies: ReplyProjectionActions;
}

const OUTLOOK_READ_BACK_WINDOW_MS = 2 * 60 * 1000;

const fallbackSentCopy = (
  reply: ProjectedReply,
  serverMessages: ReadonlyArray<DashboardConversationMessage>,
  claimedIds: ReadonlySet<string>,
): DashboardConversationMessage | null => {
  if (!reply.providerId) return null;
  const confirmedAt = Date.parse(reply.message.sentAt);
  const candidates = serverMessages
    .filter(
      (message) =>
        !claimedIds.has(message.id) &&
        message.direction === "outbound" &&
        message.bodyText === reply.message.bodyText &&
        Math.abs(Date.parse(message.sentAt) - confirmedAt) <=
          OUTLOOK_READ_BACK_WINDOW_MS,
    )
    .sort(
      (a, b) =>
        Math.abs(Date.parse(a.sentAt) - confirmedAt) -
        Math.abs(Date.parse(b.sentAt) - confirmedAt),
    );
  return candidates[0] ?? null;
};

export const useReplyProjection = ({
  scope,
  serverThread,
}: {
  readonly scope: string;
  readonly serverThread: TicketConversationThreadResult;
}): ReplyProjection => {
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const [state, setState] = useState<ProjectionState>({ scope, replies: [] });

  const actions = useMemo<ReplyProjectionActions>(() => {
    const update = (
      change: (
        replies: ReadonlyArray<ProjectedReply>,
      ) => ReadonlyArray<ProjectedReply>,
    ): void => {
      if (currentScope.current !== scope) return;
      setState((previous) => {
        const replies = previous.scope === scope ? previous.replies : [];
        const next = change(replies);
        return next === replies && previous.scope === scope
          ? previous
          : { scope, replies: next };
      });
    };

    return {
      start: (message) =>
        update((replies) => [
          ...replies,
          { renderKey: message.id, providerId: null, message },
        ]),
      confirm: (optimisticId, confirmed) =>
        update((replies) =>
          replies.map((reply) =>
            reply.renderKey === optimisticId
              ? {
                  ...reply,
                  providerId: confirmed.id,
                  message: confirmed,
                }
              : reply,
          ),
        ),
      fail: (optimisticId) =>
        update((replies) =>
          replies.filter((reply) => reply.renderKey !== optimisticId),
        ),
    };
  }, [scope]);

  const replies = state.scope === scope ? state.replies : [];
  return useMemo(() => {
    if (serverThread.status !== "available" || replies.length === 0) {
      return {
        thread: serverThread,
        messageKey: (message: DashboardConversationMessage) => message.id,
        replies: actions,
      };
    }

    const serverMessages = serverThread.thread.messages;
    const serverIds = new Set(serverMessages.map((message) => message.id));
    const renderKeys = new Map<string, string>();
    const claimedIds = new Set<string>();
    const matchedReplyKeys = new Set<string>();
    for (const reply of replies) {
      if (reply.providerId && serverIds.has(reply.providerId)) {
        renderKeys.set(reply.providerId, reply.renderKey);
        claimedIds.add(reply.providerId);
        matchedReplyKeys.add(reply.renderKey);
      } else {
        const sentCopy = fallbackSentCopy(reply, serverMessages, claimedIds);
        if (sentCopy) {
          renderKeys.set(sentCopy.id, reply.renderKey);
          claimedIds.add(sentCopy.id);
          matchedReplyKeys.add(reply.renderKey);
        } else {
          renderKeys.set(reply.message.id, reply.renderKey);
        }
      }
    }
    const overlays = replies
      .filter((reply) => !matchedReplyKeys.has(reply.renderKey))
      .map((reply) => reply.message);
    const messages = [...serverMessages, ...overlays].sort((a, b) =>
      a.sentAt.localeCompare(b.sentAt),
    );

    return {
      thread: {
        status: "available" as const,
        thread: { ...serverThread.thread, messages },
      },
      messageKey: (message: DashboardConversationMessage) =>
        renderKeys.get(message.id) ?? message.id,
      replies: actions,
    };
  }, [actions, replies, serverThread]);
};
