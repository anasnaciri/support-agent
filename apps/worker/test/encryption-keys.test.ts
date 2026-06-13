import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseEncryptionKeySet } from "../src/bootstrap.js";

// Audit S15 — key rotation. CREDENTIAL_ENCRYPTION_KEY is the primary key the
// worker (re-)encrypts with; CREDENTIAL_ENCRYPTION_KEY_PREVIOUS (optional,
// comma-separated) carries old keys reads still fall back to.

describe("parseEncryptionKeySet", () => {
  it("returns null when no primary key is set", () => {
    expect(parseEncryptionKeySet({})).toBeNull();
    expect(
      parseEncryptionKeySet({
        CREDENTIAL_ENCRYPTION_KEY_PREVIOUS: randomBytes(32).toString("base64"),
      }),
    ).toBeNull();
  });

  it("returns a length-1 set when only the primary is set (back-compat)", () => {
    const primary = randomBytes(32).toString("base64");
    const keys = parseEncryptionKeySet({ CREDENTIAL_ENCRYPTION_KEY: primary });
    expect(keys).not.toBeNull();
    expect(keys!).toHaveLength(1);
    expect(keys![0]!.toString("base64")).toBe(primary);
  });

  it("appends previous keys after the primary (comma-separated, trimmed)", () => {
    const primary = randomBytes(32).toString("base64");
    const prevA = randomBytes(32).toString("base64");
    const prevB = randomBytes(32).toString("base64");
    const keys = parseEncryptionKeySet({
      CREDENTIAL_ENCRYPTION_KEY: primary,
      CREDENTIAL_ENCRYPTION_KEY_PREVIOUS: ` ${prevA} , ${prevB} `,
    });
    expect(keys!.map((k) => k.toString("base64"))).toEqual([
      primary,
      prevA,
      prevB,
    ]);
  });

  it("ignores empty segments in the previous-key list", () => {
    const primary = randomBytes(32).toString("base64");
    const prev = randomBytes(32).toString("base64");
    const keys = parseEncryptionKeySet({
      CREDENTIAL_ENCRYPTION_KEY: primary,
      CREDENTIAL_ENCRYPTION_KEY_PREVIOUS: `${prev},,`,
    });
    expect(keys!.map((k) => k.toString("base64"))).toEqual([primary, prev]);
  });
});
