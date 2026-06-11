"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { api, getDashboardContext } from "@/lib/api-client";

// Map an api error body ({ error, reason? }) to a compact banner code so the
// page can show a friendly message (e.g. "fetch_failed:blocked_host").
const failCode = (body: unknown): string => {
  if (body && typeof body === "object") {
    const b = body as { error?: unknown; reason?: unknown };
    const error = typeof b.error === "string" ? b.error : "error";
    const reason = typeof b.reason === "string" ? b.reason : undefined;
    return reason ? `${error}:${reason}` : error;
  }
  return "error";
};

const str = (formData: FormData, key: string): string => {
  const v = formData.get(key);
  return typeof v === "string" ? v : "";
};

/** useActionState shape for the create forms (U4). */
export interface KnowledgeCreateState {
  readonly error: string;
}

// Create is a useActionState action (not PRG): a failed URL fetch or
// validation error returns state and the form KEEPS the merchant's input —
// a large pasted document must never be discarded by a redirect (U4).
// Success still redirects to the saved banner.
export const createKnowledgeAction = async (
  _prev: KnowledgeCreateState | null,
  formData: FormData,
): Promise<KnowledgeCreateState | null> => {
  const ctx = await getDashboardContext();
  const title = str(formData, "title").trim();
  if (!title) return { error: "invalid_title" };

  const res =
    formData.get("sourceType") === "url"
      ? await (async () => {
          const sourceUrl = str(formData, "sourceUrl").trim();
          if (!sourceUrl) return { error: "invalid_url" } as const;
          return api.createKnowledge(ctx, {
            title,
            sourceType: "url",
            sourceUrl,
          });
        })()
      : await (async () => {
          const content = str(formData, "content");
          if (!content.trim()) return { error: "missing_content" } as const;
          return api.createKnowledge(ctx, {
            title,
            sourceType: "text",
            content,
          });
        })();

  if ("error" in res) return res;
  if (res.status !== 200) {
    return { error: failCode(res.body) };
  }
  revalidatePath("/settings/knowledge");
  redirect("/settings/knowledge?saved=1");
};

export const updateKnowledgeAction = async (
  formData: FormData,
): Promise<void> => {
  const ctx = await getDashboardContext();
  const id = str(formData, "id");
  const title = str(formData, "title").trim();
  const input: { title?: string; content?: string } = {};
  if (title) input.title = title;
  // The content field is only present on the text-doc edit form.
  const content = formData.get("content");
  if (typeof content === "string") input.content = content;

  const res = await api.updateKnowledge(ctx, id, input);
  if (res.status !== 200) {
    redirect(
      `/settings/knowledge/${id}?error=${encodeURIComponent(failCode(res.body))}`,
    );
  }
  revalidatePath(`/settings/knowledge/${id}`);
  revalidatePath("/settings/knowledge");
  redirect(`/settings/knowledge/${id}?saved=1`);
};

export const deleteKnowledgeAction = async (
  formData: FormData,
): Promise<void> => {
  const ctx = await getDashboardContext();
  const id = str(formData, "id");
  await api.deleteKnowledge(ctx, id);
  revalidatePath("/settings/knowledge");
  redirect("/settings/knowledge?deleted=1");
};

export const resyncKnowledgeAction = async (
  formData: FormData,
): Promise<void> => {
  const ctx = await getDashboardContext();
  const id = str(formData, "id");
  const res = await api.resyncKnowledge(ctx, id);
  if (res.status !== 200) {
    redirect(
      `/settings/knowledge/${id}?error=${encodeURIComponent(failCode(res.body))}`,
    );
  }
  const changed = (res.body as { changed?: boolean } | null)?.changed === true;
  revalidatePath(`/settings/knowledge/${id}`);
  redirect(
    `/settings/knowledge/${id}?resynced=${changed ? "changed" : "nochange"}`,
  );
};
