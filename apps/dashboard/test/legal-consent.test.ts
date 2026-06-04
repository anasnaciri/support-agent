import { describe, expect, it } from "vitest";

import {
  LEGAL_ACCEPTED_AT_KEY,
  LEGAL_CONSENT_COOKIE,
  buildAcceptanceMetadata,
  hasAcceptedAtSignup,
} from "../lib/legal-consent";

describe("legal-consent helpers", () => {
  it("exposes stable cookie + metadata key names", () => {
    expect(LEGAL_CONSENT_COOKIE).toBe("legal_consent");
    expect(LEGAL_ACCEPTED_AT_KEY).toBe("legalAcceptedAt");
  });

  describe("buildAcceptanceMetadata", () => {
    it("stamps an ISO acceptance timestamp under the metadata key", () => {
      const now = new Date("2026-06-04T12:00:00.000Z");
      const out = buildAcceptanceMetadata({}, now);
      expect(out[LEGAL_ACCEPTED_AT_KEY]).toBe("2026-06-04T12:00:00.000Z");
    });

    it("preserves existing user metadata keys", () => {
      const now = new Date("2026-06-04T12:00:00.000Z");
      const out = buildAcceptanceMetadata({ plan: "pilot" }, now);
      expect(out["plan"]).toBe("pilot");
      expect(out[LEGAL_ACCEPTED_AT_KEY]).toBe("2026-06-04T12:00:00.000Z");
    });
  });

  describe("hasAcceptedAtSignup", () => {
    it("is true when the timestamp key is present and non-empty", () => {
      expect(
        hasAcceptedAtSignup({ [LEGAL_ACCEPTED_AT_KEY]: "2026-06-04T12:00:00.000Z" }),
      ).toBe(true);
    });

    it("is false when the key is absent or empty", () => {
      expect(hasAcceptedAtSignup({})).toBe(false);
      expect(hasAcceptedAtSignup({ [LEGAL_ACCEPTED_AT_KEY]: "" })).toBe(false);
    });
  });
});
