/**
 * Build the final browser redirect URL for a connector OAuth install.
 *
 * Historically this appended `&login_hint=<dashboard login email>` for every
 * non-Shopify connector to "prefill the account" on the provider consent
 * screen. That was wrong: the dashboard login email (WorkOS) is the merchant's
 * *account*, which is almost never the support mailbox they actually want to
 * connect. For Microsoft in particular, `login_hint` pre-selects (and can lock
 * onto) that account, so merchants couldn't choose the mailbox they meant to
 * connect. We now NEVER prefill — the user picks the account on the provider's
 * own screen.
 *
 * Kept as a pure helper (rather than inlined) so the "no prefill" decision has
 * a regression guard: if a future change re-introduces a `login_hint`, the
 * test for this function fails. `email` is accepted (and ignored) so callers
 * don't have to special-case threading it through.
 */
export const connectRedirectUrl = (
  baseUrl: string,
  _provider: string,
  _email: string | null | undefined,
): string => baseUrl;
