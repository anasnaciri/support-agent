// ============================================================
// Microsoft (Graph / Outlook) OAuth — pure helpers
// ============================================================
//
// Mirrors `google-install.ts`: the install / callback HTTP handlers in
// `server.ts` delegate every signature + URL-shaping decision here so they
// stay unit-testable without a server. There is only one Microsoft connector
// (`outlook`), so — unlike Google — the state doesn't need to carry a provider.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// ------------------------------------------------------------
// Scopes — kept in lockstep with `graph-token.ts:GRAPH_MAIL_SCOPES`.
// ------------------------------------------------------------
//
// `offline_access` is what makes Microsoft hand back a refresh token, which
// the connector rotates the access token from (and which Microsoft itself
// rotates on every refresh).

export const MICROSOFT_OUTLOOK_SCOPES: ReadonlyArray<string> = [
  // Read message + conversation bodies so the agent can quote prior context,
  // and create/update reply drafts before sending.
  "https://graph.microsoft.com/Mail.ReadWrite",
  // Send replies / askCustomer messages on the merchant's behalf.
  "https://graph.microsoft.com/Mail.Send",
  // Refresh token issuance.
  "offline_access",
  // Surface the connected mailbox address on the connection record.
  "openid",
  "email",
  "profile",
];

// ------------------------------------------------------------
// State signing
// ------------------------------------------------------------

const b64url = (b: Buffer): string => b.toString("base64url");
const fromB64url = (s: string): Buffer => Buffer.from(s, "base64url");

export interface MicrosoftInstallStatePayload {
  readonly tenantId: string;
  readonly nonce: string;
}

export const signMicrosoftInstallState = (
  signingKey: string,
  input: { readonly tenantId: string; readonly nonce?: string },
): string => {
  const payload = JSON.stringify({
    tenantId: input.tenantId,
    nonce: input.nonce ?? b64url(randomBytes(16)),
  });
  const encodedPayload = b64url(Buffer.from(payload, "utf8"));
  const sig = createHmac("sha256", signingKey).update(payload).digest();
  return `${encodedPayload}.${b64url(sig)}`;
};

export const verifyMicrosoftInstallState = (
  signingKey: string,
  state: string,
): MicrosoftInstallStatePayload | null => {
  const parts = state.split(".");
  if (parts.length !== 2) return null;
  const [encodedPayload, encodedSig] = parts;
  if (!encodedPayload || !encodedSig) return null;

  let payloadBytes: Buffer;
  let sig: Buffer;
  try {
    payloadBytes = fromB64url(encodedPayload);
    sig = fromB64url(encodedSig);
  } catch {
    return null;
  }

  const payload = payloadBytes.toString("utf8");
  const expected = createHmac("sha256", signingKey).update(payload).digest();
  if (expected.length !== sig.length) return null;
  if (!timingSafeEqual(expected, sig)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const candidate = parsed as Record<string, unknown>;
  if (typeof candidate["tenantId"] !== "string" || !candidate["tenantId"]) {
    return null;
  }
  if (typeof candidate["nonce"] !== "string" || !candidate["nonce"]) {
    return null;
  }
  return { tenantId: candidate["tenantId"], nonce: candidate["nonce"] };
};

// ------------------------------------------------------------
// Authorize URL builder
// ------------------------------------------------------------

export interface MicrosoftInstallUrlOptions {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  /** Azure AD tenant segment. Defaults to "common" (multi-tenant). */
  readonly tenant?: string;
  /** Defaults to the full Outlook scope set above. */
  readonly scopes?: ReadonlyArray<string>;
  /** Optional `login_hint` (mailbox address) so Microsoft pre-selects the account. */
  readonly loginHint?: string;
}

export const buildMicrosoftAuthorizeUrl = (
  opts: MicrosoftInstallUrlOptions,
): string => {
  const tenant = opts.tenant ?? "common";
  const scopes = opts.scopes ?? MICROSOFT_OUTLOOK_SCOPES;
  const params = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    state: opts.state,
    response_type: "code",
    response_mode: "query",
    scope: scopes.join(" "),
    // Force the consent screen so a refresh token is always issued, even on
    // a re-install where the user previously granted access.
    prompt: "consent",
  });
  if (opts.loginHint) params.set("login_hint", opts.loginHint);
  return `https://login.microsoftonline.com/${encodeURIComponent(
    tenant,
  )}/oauth2/v2.0/authorize?${params.toString()}`;
};
