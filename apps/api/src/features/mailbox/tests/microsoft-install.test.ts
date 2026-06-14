import { describe, expect, it } from "vitest";
import {
  MICROSOFT_OUTLOOK_SCOPES,
  buildMicrosoftAuthorizeUrl,
  signMicrosoftInstallState,
  verifyMicrosoftInstallState,
} from "../microsoft-install.js";

describe("buildMicrosoftAuthorizeUrl", () => {
  it("emits the Outlook scope set, code flow, and consent prompt", () => {
    const url = new URL(
      buildMicrosoftAuthorizeUrl({
        clientId: "cid",
        redirectUri: "https://example.com/cb",
        state: "abc",
      }),
    );
    expect(url.origin + url.pathname).toBe(
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    );
    expect(url.searchParams.get("client_id")).toBe("cid");
    expect(url.searchParams.get("redirect_uri")).toBe("https://example.com/cb");
    expect(url.searchParams.get("state")).toBe("abc");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("prompt")).toBe("consent");
    const scopeParam = url.searchParams.get("scope") ?? "";
    for (const scope of MICROSOFT_OUTLOOK_SCOPES) {
      expect(scopeParam).toContain(scope);
    }
  });

  it("uses the configured Azure AD tenant in the authorize path", () => {
    const url = new URL(
      buildMicrosoftAuthorizeUrl({
        clientId: "cid",
        redirectUri: "https://example.com/cb",
        state: "abc",
        tenant: "contoso.onmicrosoft.com",
      }),
    );
    expect(url.pathname).toBe(
      "/contoso.onmicrosoft.com/oauth2/v2.0/authorize",
    );
  });

  it("threads loginHint through to the authorize URL", () => {
    const url = new URL(
      buildMicrosoftAuthorizeUrl({
        clientId: "cid",
        redirectUri: "https://example.com/cb",
        state: "abc",
        loginHint: "support@merchant.com",
      }),
    );
    expect(url.searchParams.get("login_hint")).toBe("support@merchant.com");
  });
});

describe("Microsoft install state", () => {
  it("round-trips the tenant id", () => {
    const state = signMicrosoftInstallState("secret", {
      tenantId: "tenant-1",
      nonce: "nonce-1",
    });
    expect(verifyMicrosoftInstallState("secret", state)).toEqual({
      tenantId: "tenant-1",
      nonce: "nonce-1",
    });
  });

  it("rejects state signed with a different secret", () => {
    const state = signMicrosoftInstallState("secret", {
      tenantId: "tenant-1",
      nonce: "nonce-1",
    });
    expect(verifyMicrosoftInstallState("wrong-secret", state)).toBeNull();
  });

  it("rejects a malformed state", () => {
    expect(verifyMicrosoftInstallState("secret", "not-a-state")).toBeNull();
  });
});
