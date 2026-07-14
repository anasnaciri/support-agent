import { describe, expect, it } from "vitest";
import { TELEGRAM_APPROVAL_COPY } from "../features/onboarding/steps/TelegramStep";

describe("onboarding Telegram copy", () => {
  it("explains approval examples without em dashes", () => {
    expect(TELEGRAM_APPROVAL_COPY).not.toContain("—");
    expect(TELEGRAM_APPROVAL_COPY).toContain("refunds and cancellations");
  });
});
