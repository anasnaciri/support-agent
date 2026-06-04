"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { api, getDashboardContext } from "@/lib/api-client";

const LLM_PROVIDERS = ["openrouter", "anthropic", "openai"] as const;
const isLlmProvider = (p: string): boolean =>
  (LLM_PROVIDERS as ReadonlyArray<string>).includes(p);

export const connectLlmAction = async (formData: FormData): Promise<void> => {
  const ctx = await getDashboardContext();

  const providerRaw = formData.get("provider");
  const apiKeyRaw = formData.get("apiKey");
  const baseURLRaw = formData.get("baseURL");

  const provider = typeof providerRaw === "string" ? providerRaw.trim() : "";
  const apiKey = typeof apiKeyRaw === "string" ? apiKeyRaw.trim() : "";
  const baseURL = typeof baseURLRaw === "string" ? baseURLRaw.trim() : "";

  if (!isLlmProvider(provider)) {
    redirect("/settings/llm?error=bad_provider");
  }
  if (apiKey.length < 8) {
    redirect("/settings/llm?error=missing_key");
  }

  // The api encrypts + stores the key (the dashboard holds no encryption key
  // on Workers). The plaintext key transits dashboard → api over TLS.
  const res = await api.connectLlm(ctx, {
    provider,
    apiKey,
    ...(baseURL.length > 0 ? { baseURL } : {}),
  });
  if (res.status === 400) {
    const err = (res.body as { error?: string } | null)?.error ?? "bad_provider";
    redirect(`/settings/llm?error=${err}`);
  }

  revalidatePath("/settings/llm");
  revalidatePath("/settings/integrations");
  redirect("/settings/llm?connected=1");
};

export const revokeLlmAction = async (): Promise<void> => {
  const ctx = await getDashboardContext();
  await api.revokeLlm(ctx);
  revalidatePath("/settings/llm");
  revalidatePath("/settings/integrations");
  redirect("/settings/llm?revoked=1");
};
