import { describe, expect, it } from "vitest";

import {
  connectErrorMessage,
  parseConnectError,
} from "../app/settings/integrations/connect-error";

// U6: the api OAuth callback redirects back with `?error=<provider>:<code>`
// when the merchant cancels consent or the token exchange fails. The page
// parses that contract here; anything unparseable renders nothing rather
// than crashing or echoing attacker-controlled text.
describe("parseConnectError", () => {
  it("splits provider and code", () => {
    expect(parseConnectError("gmail:access_denied")).toEqual({
      provider: "gmail",
      code: "access_denied",
    });
  });

  it("keeps extra colons inside the code", () => {
    expect(parseConnectError("outlook:exchange_failed:500")).toEqual({
      provider: "outlook",
      code: "exchange_failed:500",
    });
  });

  it("returns null for the legacy already_connected code (handled separately)", () => {
    expect(parseConnectError("already_connected")).toBeNull();
  });

  it("returns null for missing / colon-less / empty-part values", () => {
    expect(parseConnectError(undefined)).toBeNull();
    expect(parseConnectError("")).toBeNull();
    expect(parseConnectError("gmail:")).toBeNull();
    expect(parseConnectError(":access_denied")).toBeNull();
  });

  it("rejects an unknown provider rather than echoing it", () => {
    expect(parseConnectError("evilco:access_denied")).toBeNull();
  });
});

describe("connectErrorMessage", () => {
  it("explains a consent denial", () => {
    expect(connectErrorMessage("access_denied")).toMatch(/cancel|denied/i);
  });

  it("falls back to a generic message for unknown codes", () => {
    expect(connectErrorMessage("some_new_code")).toMatch(/went wrong|fail/i);
  });
});
