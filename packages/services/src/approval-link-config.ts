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
//   - ttlMs: how long the emailed link stays valid (production: 30 days).
//     Approvals are human-latency objects, so the link must outlive a
//     weekend/holiday. The approval row itself has no age-based expiry
//     sweep, so the token TTL is the only thing that ages a link out. A
//     long-lived token is safe because it is a bearer credential bound to a
//     single approval id + action, and `ApprovalService.approve` rejects
//     already-decided rows — so an old link can only ever act on the one
//     still-pending draft it was minted for.
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
