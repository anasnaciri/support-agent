import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CryptoConfigError,
  DecryptError,
  decrypt,
  decryptToString,
  encrypt,
  parseKey,
} from "../src/crypto.js";

const goodKey = randomBytes(32);
const goodKeyB64 = goodKey.toString("base64");

describe("crypto — parseKey", () => {
  it("accepts a valid 32-byte base64 key", () => {
    const k = parseKey(goodKeyB64);
    expect(k.length).toBe(32);
    expect(k.equals(goodKey)).toBe(true);
  });

  it("rejects a key of the wrong length", () => {
    const short = randomBytes(16).toString("base64");
    expect(() => parseKey(short)).toThrow(CryptoConfigError);
  });
});

describe("crypto — encrypt/decrypt", () => {
  it("round-trips utf-8 plaintext", () => {
    const out = encrypt(goodKey, "shpoa_abc123");
    expect(decryptToString(goodKey, out)).toBe("shpoa_abc123");
  });

  it("produces a different ciphertext each call (random IV)", () => {
    const a = encrypt(goodKey, "same");
    const b = encrypt(goodKey, "same");
    expect(a.equals(b)).toBe(false);
    // But both decrypt back to the same plaintext.
    expect(decryptToString(goodKey, a)).toBe("same");
    expect(decryptToString(goodKey, b)).toBe("same");
  });

  it("fails with DecryptError when the key is wrong", () => {
    const ct = encrypt(goodKey, "secret");
    const wrong = randomBytes(32);
    expect(() => decrypt(wrong, ct)).toThrow(DecryptError);
  });

  it("fails with DecryptError when the ciphertext is tampered", () => {
    const ct = encrypt(goodKey, "secret");
    // Flip a byte in the ciphertext body (past iv+tag).
    ct[30]! ^= 0xff;
    expect(() => decrypt(goodKey, ct)).toThrow(DecryptError);
  });

  it("fails with DecryptError when the buffer is shorter than iv+tag", () => {
    expect(() => decrypt(goodKey, Buffer.alloc(10))).toThrow(DecryptError);
  });
});
