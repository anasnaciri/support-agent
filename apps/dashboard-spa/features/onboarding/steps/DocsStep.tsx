import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { FileText, Loader2, Plus } from "lucide-react";

import { api } from "@/lib/api-client";
import { qk } from "@/lib/query-keys";
import { useWorkspaceCtx } from "@/lib/session-context";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { NativeSelect } from "@/components/ui/native-select";
import { ConfirmButton } from "@/features/tickets/ConfirmButton";
import type { WizardStepProps } from "../steps";

// Step 2. Connecting the store queues a background import of the shop's
// shipping/refund policies and its About/Contact/FAQ pages. That job runs in the
// worker, so the docs land a moment after the redirect — we poll rather than
// show an empty list and imply we found nothing.
//
// Zero documents is a legitimate outcome (a store may publish no policy pages),
// so this step never blocks: the agent falls back to the Facts on the next step,
// which is the grounding that actually matters.

const POLL_MS = 2_000;

export function DocsStep({ onDone, canEdit }: WizardStepProps) {
  const ctx = useWorkspaceCtx();
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);

  const docs = useQuery({
    queryKey: qk.knowledge(ctx.workspaceId),
    queryFn: () => api.knowledge(ctx),
    // Keep looking while the import might still be running. Once anything has
    // landed we stop: a merchant who wants more can add them by hand.
    refetchInterval: (query) =>
      (query.state.data?.length ?? 0) === 0 ? POLL_MS : false,
  });

  const create = useMutation({
    mutationFn: (input: Parameters<typeof api.createKnowledge>[1]) =>
      api.createKnowledge(ctx, input),
    onSuccess: async (res) => {
      if (res.status !== 200) {
        toast.warning(
          "Couldn't add that document. Check the link and try again.",
        );
        return;
      }
      await qc.invalidateQueries({ queryKey: qk.knowledge(ctx.workspaceId) });
      setAdding(false);
      toast.success("Document added.");
    },
    onError: () => toast.warning("Couldn't add that document."),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteKnowledge(ctx, id),
    onSuccess: async (res) => {
      if (res.status !== 200) {
        toast.warning("Couldn't delete that document.");
        return;
      }
      await qc.invalidateQueries({ queryKey: qk.knowledge(ctx.workspaceId) });
      toast.success("Document deleted.");
    },
    onError: () => toast.warning("Couldn't delete that document."),
  });

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const title = String(form.get("title") ?? "").trim();
    const sourceType = String(form.get("sourceType") ?? "text");
    if (!title) return;
    if (sourceType === "url") {
      const sourceUrl = String(form.get("sourceUrl") ?? "").trim();
      if (!sourceUrl) return;
      create.mutate({ title, sourceType: "url", sourceUrl });
    } else {
      const content = String(form.get("content") ?? "").trim();
      if (!content) return;
      create.mutate({ title, sourceType: "text", content });
    }
  };

  const list = docs.data ?? [];
  const importing = docs.isLoading || (list.length === 0 && docs.isFetching);

  return (
    <div className="space-y-6">
      {importing ? (
        <Card>
          <CardContent className="flex items-center gap-3 py-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Reading your store pages and policies…
          </CardContent>
        </Card>
      ) : list.length === 0 ? (
        <Card>
          <CardContent className="py-6 text-sm text-muted-foreground">
            We didn't find any policy or information pages published on your
            store. That's fine — the next step captures the facts your agent
            actually needs. You can always add documents later.
          </CardContent>
        </Card>
      ) : (
        <ul className="divide-y rounded-lg border">
          {list.map((doc) => (
            <li key={doc.id} className="flex items-center gap-3 px-4 py-3">
              <FileText className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-sm">
                {doc.title}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {doc.sourceType === "url" ? "From your store" : "Pasted"}
              </span>
              {canEdit ? (
                <ConfirmButton
                  variant="ghost"
                  size="sm"
                  title={`Delete “${doc.title}”?`}
                  description="Your agent stops referencing this document immediately. This can't be undone."
                  confirmLabel="Delete document"
                  pending={remove.isPending && remove.variables === doc.id}
                  onConfirm={() => remove.mutate(doc.id)}
                >
                  Delete
                </ConfirmButton>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {adding ? (
        <Card>
          <CardContent className="py-6">
            <form onSubmit={onSubmit} className="space-y-4">
              <div className="grid gap-1.5">
                <Label htmlFor="title">Title</Label>
                <Input id="title" name="title" required maxLength={200} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="sourceType">Source</Label>
                <NativeSelect id="sourceType" name="sourceType" defaultValue="text">
                  <option value="text">Paste the text</option>
                  <option value="url">Fetch from a link</option>
                </NativeSelect>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="sourceUrl">Link (if fetching)</Label>
                <Input
                  id="sourceUrl"
                  name="sourceUrl"
                  type="url"
                  placeholder="https://yourstore.com/pages/faq"
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="content">Text (if pasting)</Label>
                <Textarea id="content" name="content" rows={5} />
              </div>
              <div className="flex gap-2">
                <Button type="submit" size="sm" disabled={create.isPending}>
                  {create.isPending && (
                    <Loader2 className="size-4 animate-spin" />
                  )}
                  Add document
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setAdding(false)}
                >
                  Cancel
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      ) : (
        <Button
          variant="outline"
          size="sm"
          onClick={() => setAdding(true)}
          disabled={!canEdit}
        >
          <Plus className="size-4" />
          Add a document
        </Button>
      )}

      <div>
        <Button onClick={onDone}>
          {list.length === 0 ? "Continue without documents" : "Looks right, continue"}
        </Button>
      </div>
    </div>
  );
}
