import { describe, expect, it } from "vitest";
import {
  WORKER_REQUIRED_PROD_ENV,
  assertProductionServicesConfigured,
} from "../src/bootstrap.js";

// 5th-audit #6: a production worker must NOT silently boot with Test/no-op
// WorkOS/Resend/etc. — that would skip org deletion + the deletion email and
// sign approval links with a predictable dev key.

const allSet: Record<string, string> = {
  NODE_ENV: "production",
  CREDENTIAL_ENCRYPTION_KEY: "k",
  APPROVAL_SIGNING_KEY: "s",
  WORKOS_API_KEY: "w",
  RESEND_API_KEY: "r",
  RESEND_FROM_ADDRESS: "from@example.com",
};

describe("assertProductionServicesConfigured", () => {
  it("throws in production when a required service env var is missing", () => {
    const { WORKOS_API_KEY: _omit, ...withoutWorkos } = allSet;
    expect(() => assertProductionServicesConfigured(withoutWorkos)).toThrow(
      /WORKOS_API_KEY/,
    );
  });

  it("lists every missing var", () => {
    expect(() =>
      assertProductionServicesConfigured({ NODE_ENV: "production" }),
    ).toThrow(/CREDENTIAL_ENCRYPTION_KEY.*RESEND_FROM_ADDRESS|RESEND_FROM_ADDRESS/);
    // Each required var should appear in the message.
    let message = "";
    try {
      assertProductionServicesConfigured({ NODE_ENV: "production" });
    } catch (e) {
      message = (e as Error).message;
    }
    for (const name of WORKER_REQUIRED_PROD_ENV) {
      expect(message).toContain(name);
    }
  });

  it("does not throw in production when all required vars are set", () => {
    expect(() => assertProductionServicesConfigured(allSet)).not.toThrow();
  });

  it("allows production to explicitly disable platform mail without Resend", () => {
    const {
      RESEND_API_KEY: _apiKey,
      RESEND_FROM_ADDRESS: _from,
      ...withoutResend
    } = allSet;
    expect(() =>
      assertProductionServicesConfigured({
        ...withoutResend,
        PLATFORM_MAIL_ENABLED: "false",
      }),
    ).not.toThrow();
  });

  it("still requires Resend when platform mail is enabled explicitly", () => {
    const {
      RESEND_API_KEY: _apiKey,
      RESEND_FROM_ADDRESS: _from,
      ...withoutResend
    } = allSet;
    expect(() =>
      assertProductionServicesConfigured({
        ...withoutResend,
        PLATFORM_MAIL_ENABLED: "true",
      }),
    ).toThrow(/RESEND_API_KEY.*RESEND_FROM_ADDRESS|RESEND_FROM_ADDRESS/);
  });

  it("never throws outside production (dev/CI may use no-op fallbacks)", () => {
    expect(() =>
      assertProductionServicesConfigured({ NODE_ENV: "test" }),
    ).not.toThrow();
    expect(() => assertProductionServicesConfigured({})).not.toThrow();
  });
});
