export interface RetrySendVisibilityInput {
  readonly ticketStatus: string;
  readonly activeReplyDelivery: null | {
    readonly id?: string;
    readonly ticketId?: string;
    readonly status: string;
  };
  readonly riskFlags: ReadonlyArray<string>;
}

export const shouldShowRetrySendAction = ({
  ticketStatus,
  activeReplyDelivery,
}: RetrySendVisibilityInput): boolean =>
  ticketStatus === "human_takeover" &&
  activeReplyDelivery !== null &&
  activeReplyDelivery.status !== "sent";
