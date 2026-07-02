import { describe, expect, it } from "vitest";

import { ApiError, UnauthorizedError } from "../lib/errors";
import { shouldStartLoginForAuthError } from "../lib/session-context";

describe("shouldStartLoginForAuthError", () => {
  it("starts login only for a real unauthenticated session", () => {
    expect(shouldStartLoginForAuthError(new UnauthorizedError())).toBe(true);
  });

  it("does not log out the user for transient auth-session failures", () => {
    expect(shouldStartLoginForAuthError(new ApiError("temporary", 503))).toBe(
      false,
    );
    expect(shouldStartLoginForAuthError(new Error("network"))).toBe(false);
  });
});
