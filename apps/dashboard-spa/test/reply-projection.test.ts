// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  act,
  createElement,
  type ReactElement,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  DashboardConversationMessage,
  TicketConversationThreadResult,
} from "@support-agent/dashboard-contracts";

import { ChatThread } from "../features/tickets/ChatThread.js";
import {
  useReplyProjection,
  type ReplyProjectionActions,
} from "../lib/reply-projection.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const message = (
  id: string,
  bodyText: string,
  sentAt: string,
): DashboardConversationMessage => ({
  id,
  direction: "outbound",
  from: { name: "You", email: "support@example.com" },
  to: [{ name: "Jane", email: "jane@example.com" }],
  subject: "Order #1016",
  bodyText,
  sanitizedBodyHtml: null,
  sentAt,
  attachments: [],
});

const thread = (
  ...messages: ReadonlyArray<DashboardConversationMessage>
): TicketConversationThreadResult => ({
  status: "available",
  thread: { subject: "Order #1016", participants: [], messages: [...messages] },
});

const optimistic = message(
  "optimistic:client-1",
  "Your replacement is on the way.",
  "2026-07-18T10:05:00.000Z",
);
const confirmed = message(
  "provider-message-1",
  optimistic.bodyText,
  "2026-07-18T10:05:01.000Z",
);

function Harness({
  serverThread,
  confirmedMessage = confirmed,
  scope = "workspace-1:ticket-1",
  captureActions,
}: {
  readonly serverThread: TicketConversationThreadResult;
  readonly confirmedMessage?: DashboardConversationMessage;
  readonly scope?: string;
  readonly captureActions?: (actions: ReplyProjectionActions) => void;
}): ReactElement {
  const projection = useReplyProjection({
    scope,
    serverThread,
  });
  captureActions?.(projection.replies);
  return createElement(
    "div",
    null,
    createElement(
      "button",
      { onClick: () => projection.replies.start(optimistic) },
      "start",
    ),
    createElement(
      "button",
      {
        onClick: () =>
          projection.replies.confirm(optimistic.id, confirmedMessage),
      },
      "confirm",
    ),
    createElement(ChatThread, {
      result: projection.thread,
      messageKey: projection.messageKey,
      workspaceId: "workspace-1",
      ticketId: "ticket-1",
      processing: false,
      resolved: false,
    }),
  );
}

let root: Root;
let container: HTMLDivElement;

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("optimistic reply projection", () => {
  it("keeps one mounted bubble through stale refetch, confirmation, and read-back", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    const render = (serverThread: TicketConversationThreadResult): void => {
      act(() => root.render(createElement(Harness, { serverThread })));
    };
    const bubble = (): HTMLElement => {
      const bodies = [...container.querySelectorAll("p")].filter(
        (candidate) => candidate.textContent === optimistic.bodyText,
      );
      expect(bodies).toHaveLength(1);
      return bodies[0]!.parentElement!.parentElement!;
    };

    render(thread());
    act(() => container.querySelector<HTMLButtonElement>("button")!.click());
    const originalBubble = bubble();

    render(thread());
    expect(bubble()).toBe(originalBubble);

    act(() =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "confirm")!
        .click(),
    );
    expect(bubble()).toBe(originalBubble);

    render(thread(confirmed));
    expect(bubble()).toBe(originalBubble);
  });

  it("reconciles an Outlook sent copy when Graph confirmed with its transient draft id", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const draftConfirmation = { ...confirmed, id: "graph-draft-id" };
    const sentCopy = { ...confirmed, id: "graph-sent-id" };
    const render = (serverThread: TicketConversationThreadResult): void => {
      act(() =>
        root.render(
          createElement(Harness, {
            serverThread,
            confirmedMessage: draftConfirmation,
          }),
        ),
      );
    };

    render(thread());
    act(() => container.querySelector<HTMLButtonElement>("button")!.click());
    const originalBubble = [...container.querySelectorAll("p")].find(
      (candidate) => candidate.textContent === optimistic.bodyText,
    )!.parentElement!.parentElement!;
    act(() =>
      [...container.querySelectorAll("button")]
        .find((button) => button.textContent === "confirm")!
        .click(),
    );

    render(thread(sentCopy));
    const bodies = [...container.querySelectorAll("p")].filter(
      (candidate) => candidate.textContent === optimistic.bodyText,
    );
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.parentElement!.parentElement).toBe(originalBubble);
  });

  it("does not show or complete a previous ticket's pending reply after navigation", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    let ticketOneActions: ReplyProjectionActions | null = null;

    act(() =>
      root.render(
        createElement(Harness, {
          serverThread: thread(),
          scope: "workspace-1:ticket-1",
          captureActions: (actions) => {
            ticketOneActions = actions;
          },
        }),
      ),
    );
    act(() => container.querySelector<HTMLButtonElement>("button")!.click());
    expect(container.textContent).toContain(optimistic.bodyText);

    act(() =>
      root.render(
        createElement(Harness, {
          serverThread: thread(),
          scope: "workspace-1:ticket-2",
        }),
      ),
    );
    expect(container.textContent).not.toContain(optimistic.bodyText);

    act(() => ticketOneActions!.confirm(optimistic.id, confirmed));
    expect(container.textContent).not.toContain(optimistic.bodyText);
  });
});
