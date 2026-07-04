import { describe, expect, it } from "vitest";

import { canonicalSignInUrl } from "../lib/auth-origin";

describe("dashboard auth origin", () => {
  it("redirects sign-in to the callback origin before setting the PKCE cookie", () => {
    expect(
      canonicalSignInUrl({
        requestUrl: "http://127.0.0.1:3000/sign-in",
        redirectUri: "http://localhost:3000/callback",
      }),
    ).toBe("http://localhost:3000/sign-in");
  });

  it("preserves the sign-in query string when canonicalising the origin", () => {
    expect(
      canonicalSignInUrl({
        requestUrl: "http://127.0.0.1:3000/sign-in?returnTo=%2Ftickets",
        redirectUri: "http://localhost:3000/callback",
      }),
    ).toBe("http://localhost:3000/sign-in?returnTo=%2Ftickets");
  });

  it("does nothing when the request already matches the callback origin", () => {
    expect(
      canonicalSignInUrl({
        requestUrl: "http://localhost:3000/sign-in",
        redirectUri: "http://localhost:3000/callback",
      }),
    ).toBeNull();
  });

  it("does nothing when the redirect URI is absent or malformed", () => {
    expect(
      canonicalSignInUrl({
        requestUrl: "http://127.0.0.1:3000/sign-in",
        redirectUri: "",
      }),
    ).toBeNull();
    expect(
      canonicalSignInUrl({
        requestUrl: "http://127.0.0.1:3000/sign-in",
        redirectUri: "not-a-url",
      }),
    ).toBeNull();
  });
});
