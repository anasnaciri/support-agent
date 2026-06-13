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

/**
 * Build a decryption key SET (audit S15 rotation) from a primary key plus an
 * optional comma-separated list of previous keys. Returns the keys primary
 * first — exactly the order `decryptWithKeys` / `decryptToStringWithKeys`
 * expect. Each element is parsed with {@link parseKey}; empty/whitespace
 * segments in `previous` are ignored. With no `previous`, the result is a
 * length-1 set identical to the pre-rotation single-key behaviour.
 *
 * Rotation how-to: move the OLD key to `previous` and put the NEW key in
 * `primary`. Reads work against both; each row re-encrypts to the new key on
 * its next write.
 */
export const parseKeySet = (
  primary: string,
  previous?: string | null,
): ReadonlyArray<Buffer> => {
  const prev = (previous ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => parseKey(s));
  return [parseKey(primary), ...prev];
};

// ============================================================
// AES-256-GCM encrypt / decrypt
// ============================================================

/**
 * Ciphertext format version (audit S15). v1 prefixes a single version
 * byte so the layout can evolve and key rotation can be implemented
 * with a decrypt-key set instead of an all-at-once re-encryption
 * migration. Legacy (pre-versioning) buffers have no prefix — `decrypt`
 * accepts both.
 */
const VERSION_V1 = 0x01;

/**
 * AES-256-GCM encrypt. Layout of the returned buffer (v1):
 *
 *   version (1 byte, 0x01) || iv (12 bytes) || gcm_tag (16 bytes) || ciphertext
 *
 * The 12-byte IV is randomly generated per call so the same plaintext +
 * key encrypts to different ciphertexts. Storing version + iv + tag
 * inline keeps the schema to a single bytea column.
 */
export const encrypt = (key: Buffer, plaintext: Buffer | string): Buffer => {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv) as CipherGCM;
  const buf =
    typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext;
  const ct = Buffer.concat([cipher.update(buf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([VERSION_V1]), iv, tag, ct]);
};

const decryptRaw = (key: Buffer, buf: Buffer): Buffer => {
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

/**
 * Inverse of `encrypt`. Accepts both v1 (version-prefixed) and legacy
 * (bare iv||tag||ct) layouts: a legacy buffer whose first IV byte
 * happens to be 0x01 mis-parses as v1, fails GCM authentication, and is
 * retried as legacy — the AEAD tag makes the disambiguation safe. Fails
 * with `DecryptError` if the buffer is malformed, the GCM tag doesn't
 * authenticate, or the wrong key is used.
 */
export const decrypt = (key: Buffer, buf: Buffer): Buffer => {
  if (buf.length > IV_BYTES + TAG_BYTES && buf[0] === VERSION_V1) {
    try {
      return decryptRaw(key, buf.subarray(1));
    } catch {
      // Could be a legacy buffer starting with 0x01 — fall through.
    }
  }
  return decryptRaw(key, buf);
};

/**
 * Decrypt with a key set, primary first (audit S15). Enables rotation:
 * point CREDENTIAL_ENCRYPTION_KEY at the new key and pass the previous
 * one(s) as fallbacks; writes use the new key while reads keep working
 * until rows are re-encrypted on touch.
 */
export const decryptWithKeys = (
  keys: ReadonlyArray<Buffer>,
  buf: Buffer,
): Buffer => {
  let lastError: unknown = null;
  for (const key of keys) {
    try {
      return decrypt(key, buf);
    } catch (cause) {
      lastError = cause;
    }
  }
  if (lastError instanceof DecryptError) throw lastError;
  throw new DecryptError({ reason: "no decryption key matched" });
};

export const decryptToString = (key: Buffer, buf: Buffer): string =>
  decrypt(key, buf).toString("utf8");

/**
 * `decryptWithKeys` for utf-8 plaintext — the rotation-aware counterpart of
 * `decryptToString` (audit S15). Pass the key set primary-first; the first
 * key that authenticates wins, so old ciphertext keeps reading after a key
 * roll until the row is re-encrypted under the new primary on next write.
 */
export const decryptToStringWithKeys = (
  keys: ReadonlyArray<Buffer>,
  buf: Buffer,
): string => decryptWithKeys(keys, buf).toString("utf8");
