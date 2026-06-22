// ============================================================
// Dashboard "Rephrase with AI" — one-shot polish of a reply draft
// ============================================================
//
// While drafting a manual reply (see case-reply.ts) the agent can ask the model
// to rewrite their draft to be clearer/warmer before sending. This is a single
// text-generation call — NOT the agent runtime — so it lives as its own thin
// orchestration core, dependency-injected (`hasCredential` / `generate`) so it
// unit-tests with fakes. The HTTP handler wires it to the tenant's LLM
// credential + the LLMService (runToolCalling with no tools → a final message).
//
// Guards (in order): empty draft → tenant has an AI provider configured →
// generate. `no_llm` is split out from `failed` so the dashboard can tell the
// merchant to connect a provider rather than showing a generic error.

import type { ChatMessage } from "@support-agent/agent-core";

export const REPHRASE_SYSTEM =
  "You are helping a customer-support agent polish a reply before it is sent " +
  "to a customer. Rewrite the agent's draft so it reads clearly, warmly, and " +
  "professionally. Preserve the meaning and every fact, name, number, order " +
  "reference, and commitment exactly — never invent details or change what is " +
  "promised. Keep it roughly the same length. Do not add a greeting or sign-off " +
  "that isn't already there, and never answer as if you were the customer. " +
  "Return ONLY the rewritten reply text — no preamble, labels, or quotes.";

export const buildRephraseMessages = (
  text: string,
): ReadonlyArray<ChatMessage> => [
  { role: "user", content: `Rewrite this customer-support reply:\n\n${text}` },
];

export type RephraseOutcome =
  | { readonly kind: "rephrased"; readonly text: string }
  | { readonly kind: "empty_input" }
  | { readonly kind: "no_llm" }
  | { readonly kind: "failed"; readonly error: string };

export interface RephraseDraftOptions {
  /** The agent's current draft. */
  readonly text: string;
  /** Whether the tenant has an active LLM credential to spend. */
  readonly hasCredential: () => Promise<boolean>;
  /** Run the model on the (trimmed) draft; `null`/empty = no usable output. */
  readonly generate: (text: string) => Promise<string | null>;
}

export const rephraseDraft = async (
  opts: RephraseDraftOptions,
): Promise<RephraseOutcome> => {
  const text = opts.text.trim();
  if (text.length === 0) return { kind: "empty_input" };
  if (!(await opts.hasCredential())) return { kind: "no_llm" };

  let out: string | null;
  try {
    out = await opts.generate(text);
  } catch (cause) {
    return {
      kind: "failed",
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }
  const trimmed = (out ?? "").trim();
  if (trimmed.length === 0) return { kind: "failed", error: "empty_output" };
  return { kind: "rephrased", text: trimmed };
};
