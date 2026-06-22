export interface RetrySendVisibilityInput {
  readonly caseStatus: string;
  readonly activeReplyDelivery: null | {
    readonly id?: string;
    readonly caseId?: string;
    readonly status: string;
  };
  readonly riskFlags: ReadonlyArray<string>;
}

export const shouldShowRetrySendAction = ({
  caseStatus,
  activeReplyDelivery,
}: RetrySendVisibilityInput): boolean =>
  caseStatus === "human_takeover" &&
  activeReplyDelivery !== null &&
  activeReplyDelivery.status !== "sent";
