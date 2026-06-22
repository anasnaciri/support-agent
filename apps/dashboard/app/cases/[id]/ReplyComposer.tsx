import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { SubmitButton } from "@/components/ui/submit-button";

import { sendReplyAction } from "./actions";

interface ReplyComposerProps {
  readonly caseId: string;
  /** Shown in the placeholder so the agent knows who they're writing to. */
  readonly customerEmail: string | null;
}

// Human draft-and-send composer. Only rendered while a human is driving the
// case (human_takeover), so no one races the agent to the customer's inbox.
// The reply goes out on the existing email thread; the case stays in
// human_takeover afterwards. (Rephrase + model picker land in later slices.)
export function ReplyComposer({ caseId, customerEmail }: ReplyComposerProps) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Reply to customer</CardTitle>
      </CardHeader>
      <CardContent>
        <form action={sendReplyAction} className="space-y-3">
          <input type="hidden" name="caseId" value={caseId} />
          <Textarea
            name="bodyText"
            required
            rows={6}
            placeholder={
              customerEmail
                ? `Write a reply to ${customerEmail}…`
                : "Write a reply to the customer…"
            }
            className="bg-card"
          />
          <div className="flex items-center justify-end">
            <SubmitButton
              pendingLabel="Sending…"
              title="Send this reply to the customer on the existing email thread"
            >
              Send reply
            </SubmitButton>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
