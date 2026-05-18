import { Context } from "effect";

// ============================================================
// ApprovalLinkConfig
// ============================================================
//
// The values needed to mint approval-email URLs:
//
//   - baseUrl: public origin of the API (e.g. https://support-agent-api.example.com).
//     The runtime concatenates `<baseUrl>/approvals/<id>/approve?token=...`
//     and the matching reject path.
//   - signingKey: HMAC secret used by `approval-tokens.ts`. Same value
//     in the runtime (signing) and the api (verifying); separate from
//     SHOPIFY/GOOGLE secrets so it can be rotated independently.
//   - ttlMs: how long the link stays valid. Default 7 days = comfortably
//     longer than the approval row's own `expiresAt` (24h) — the token
//     outliving the row is harmless because `ApprovalService.approve`
//     rejects already-decided / expired rows.
//
// Abstract Tag in services; `ApprovalLinkConfigFromEnv` lives in
// providers (or wherever the env-reader naturally sits).

export class ApprovalLinkConfig extends Context.Tag("ApprovalLinkConfig")<
  ApprovalLinkConfig,
  {
    readonly baseUrl: string;
    readonly signingKey: string;
    readonly ttlMs: number;
  }
>() {}
