import { describe, expect, it } from "vitest";
import {
  GOOGLE_GMAIL_SCOPES,
  buildGoogleAuthorizeUrl,
} from "../src/google-install.js";

describe("buildGoogleAuthorizeUrl", () => {
  it("emits the full Gmail scope set, offline access, and consent prompt by default", () => {
    const url = new URL(
      buildGoogleAuthorizeUrl({
        clientId: "cid",
        redirectUri: "https://example.com/cb",
        state: "abc",
      }),
    );
    expect(url.origin + url.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("redirect_uri")).toBe("https://example.com/cb");
    expect(url.searchParams.get("state")).toBe("abc");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    // Each Gmail scope must appear verbatim in the space-separated scope string.
    const scopeParam = url.searchParams.get("scope") ?? "";
    for (const scope of GOOGLE_GMAIL_SCOPES) {
      expect(scopeParam).toContain(scope);
    }
  });

  it("omits prompt=consent when forceConsent=false", () => {
    const url = new URL(
      buildGoogleAuthorizeUrl({
        clientId: "cid",
        redirectUri: "https://example.com/cb",
        state: "abc",
        forceConsent: false,
      }),
    );
    expect(url.searchParams.has("prompt")).toBe(false);
  });

  it("threads loginHint through to the Google authorize URL", () => {
    const url = new URL(
      buildGoogleAuthorizeUrl({
        clientId: "cid",
        redirectUri: "https://example.com/cb",
        state: "abc",
        loginHint: "support@merchant.com",
      }),
    );
    expect(url.searchParams.get("login_hint")).toBe("support@merchant.com");
  });
});
