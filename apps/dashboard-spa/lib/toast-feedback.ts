// Shared logic for the post-action toasts that replaced the inline result
// banners. A server page resolves its current URL search params against a set
// of declarative rules and hands the result to <FeedbackToaster/>, which fires
// the toasts and strips the consumed params so a refresh doesn't replay them.
//
// The matching mirrors the old inline conditionals: a flag param (`saved=1`),
// an exact code (`error=bad_currency`), or a catch-all fallback (`match: "*"`)
// for unknown codes — the same shape every settings page used by hand.

export type ToastKind = "success" | "error" | "warning" | "info" | "message";

export interface ToastAction {
  readonly label: string;
  readonly href: string;
}

/** A concrete toast to fire — already resolved to display strings, so it is
 *  safe to pass from a server component to the client island. */
export interface ResolvedToast {
  readonly kind: ToastKind;
  readonly message: string;
  readonly description?: string;
  readonly action?: ToastAction;
}

export interface FeedbackRule {
  /** Search-param key to look at, e.g. `"saved"` or `"error"`. */
  readonly param: string;
  /**
   * Value to match. Omit for the flag convention (`?param=1`). Use `"*"` for a
   * catch-all that fires only when no exact-value rule on the same param
   * matched — the equivalent of the old "something went wrong" fallback.
   */
  readonly match?: string;
  readonly kind: ToastKind;
  readonly message: string;
  readonly description?: string;
  readonly action?: ToastAction;
}

export interface FeedbackResult {
  readonly toasts: readonly ResolvedToast[];
  /** Param keys that produced a toast and should be stripped from the URL. */
  readonly consume: readonly string[];
}

export type FeedbackParams =
  | URLSearchParams
  | Readonly<Record<string, string | string[] | undefined>>;

const firstValue = (
  params: FeedbackParams,
  key: string,
): string | undefined => {
  if (params instanceof URLSearchParams) return params.get(key) ?? undefined;
  const raw = params[key];
  return Array.isArray(raw) ? raw[0] : raw;
};

const toToast = (rule: FeedbackRule): ResolvedToast => {
  const toast: ResolvedToast = { kind: rule.kind, message: rule.message };
  return {
    ...toast,
    ...(rule.description !== undefined ? { description: rule.description } : {}),
    ...(rule.action !== undefined ? { action: rule.action } : {}),
  };
};

const WILDCARD = "*";
const FLAG_VALUE = "1";

export function resolveFeedback(
  params: FeedbackParams,
  rules: readonly FeedbackRule[],
): FeedbackResult {
  // Group by param, preserving first-seen order, so each param fires at most
  // its exact matches (or the fallback) and the output order is deterministic.
  const byParam = new Map<string, FeedbackRule[]>();
  for (const rule of rules) {
    const group = byParam.get(rule.param);
    if (group) group.push(rule);
    else byParam.set(rule.param, [rule]);
  }

  const toasts: ResolvedToast[] = [];
  const consume: string[] = [];

  for (const [param, group] of byParam) {
    const value = firstValue(params, param);
    if (value === undefined || value === "") continue;

    const exact = group.filter((r) => (r.match ?? FLAG_VALUE) === value);
    if (exact.length > 0) {
      for (const rule of exact) toasts.push(toToast(rule));
      consume.push(param);
      continue;
    }

    const fallback = group.find((r) => r.match === WILDCARD);
    if (fallback) {
      toasts.push(toToast(fallback));
      consume.push(param);
    }
  }

  return { toasts, consume };
}
