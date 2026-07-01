// Legal acceptance captured at the self-hosted /sign-up page.
//
// WorkOS's hosted sign-up UI can't enforce a custom checkbox, so the dashboard
// hosts its own /sign-up page with the required Data Processing Notice + DPA
// checkbox. The checkbox sets a short-lived `legal_consent` cookie before the
// Google OAuth handoff; the /callback `onSuccess` hook reads that cookie and
// stamps the acceptance timestamp onto the WorkOS user's metadata. Onboarding
// then skips its own checkbox when that timestamp is present.
//
// Only a timestamp lives at the user level here — the versioned, *enforced*
// legal record stays tenant-scoped (apps/api stamps it at onboarding), so the
// dashboard never needs the legal version constants (which live in
// @support-agent/services, outside the trimmed Path B dependency set).

/** Short-lived cookie that signals "this user accepted on the /sign-up page". */
export const LEGAL_CONSENT_COOKIE = "legal_consent";

/** WorkOS user-metadata key holding the sign-up acceptance timestamp (ISO). */
export const LEGAL_ACCEPTED_AT_KEY = "legalAcceptedAt";

/**
 * Merge the sign-up acceptance timestamp into a user's existing WorkOS
 * metadata without dropping other keys. WorkOS metadata values are strings.
 */
export const buildAcceptanceMetadata = (
  existing: Record<string, string>,
  now: Date,
): Record<string, string> => ({
  ...existing,
  [LEGAL_ACCEPTED_AT_KEY]: now.toISOString(),
});

/** Whether the user already accepted the notice + DPA at sign-up. */
export const hasAcceptedAtSignup = (
  metadata: Record<string, string>,
): boolean => (metadata[LEGAL_ACCEPTED_AT_KEY] ?? "").length > 0;
