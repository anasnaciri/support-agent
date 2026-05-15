import { Data } from "effect";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  type CipherGCM,
  type DecipherGCM,
} from "node:crypto";

// ============================================================
// Errors
// ============================================================

export class CryptoConfigError extends Data.TaggedError("CryptoConfigError")<{
  readonly reason: string;
}> {}

export class DecryptError extends Data.TaggedError("DecryptError")<{
  readonly reason: string;
}> {}

// ============================================================
// Key handling
// ============================================================

const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

/**
 * Parse a base64-encoded 32-byte key. Throws `CryptoConfigError` on bad
 * input — caller decides whether to crash (boot path) or surface to a user
 * (CLI tool).
 */
export const parseKey = (b64: string): Buffer => {
  let raw: Buffer;
  try {
    raw = Buffer.from(b64, "base64");
  } catch {
    throw new CryptoConfigError({ reason: "key is not valid base64" });
  }
  if (raw.length !== KEY_BYTES) {
    throw new CryptoConfigError({
      reason: `key must be ${KEY_BYTES} bytes after base64-decode (got ${raw.length})`,
    });
  }
  return raw;
};

// ============================================================
// AES-256-GCM encrypt / decrypt
// ============================================================

/**
 * AES-256-GCM encrypt. Layout of the returned buffer:
 *
 *   iv (12 bytes) || gcm_tag (16 bytes) || ciphertext (variable)
 *
 * The 12-byte IV is randomly generated per call so the same plaintext +
 * key encrypts to different ciphertexts. Storing iv + tag inline keeps
 * the schema to a single bytea column.
 */
export const encrypt = (key: Buffer, plaintext: Buffer | string): Buffer => {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv) as CipherGCM;
  const buf =
    typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext;
  const ct = Buffer.concat([cipher.update(buf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]);
};

/**
 * Inverse of `encrypt`. Returns the decrypted plaintext bytes. Fails with
 * `DecryptError` if the buffer is too short, if the GCM tag doesn't
 * authenticate, or if the wrong key is used — the GCM AEAD construction
 * guarantees that tampering or wrong-key produces a tag-mismatch error
 * rather than silently-garbled plaintext.
 */
export const decrypt = (key: Buffer, buf: Buffer): Buffer => {
  if (buf.length < IV_BYTES + TAG_BYTES) {
    throw new DecryptError({ reason: "ciphertext shorter than iv+tag header" });
  }
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ct = buf.subarray(IV_BYTES + TAG_BYTES);
  const dec = createDecipheriv("aes-256-gcm", key, iv) as DecipherGCM;
  dec.setAuthTag(tag);
  try {
    return Buffer.concat([dec.update(ct), dec.final()]);
  } catch (cause) {
    throw new DecryptError({
      reason: cause instanceof Error ? cause.message : "unknown",
    });
  }
};

export const decryptToString = (key: Buffer, buf: Buffer): string =>
  decrypt(key, buf).toString("utf8");
