import { requirePermission } from "@/lib/require-permission";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { inviteFulfillmentOperatorAction } from "./actions";

interface SearchParams {
  readonly searchParams: Promise<{
    readonly ok?: string;
    readonly error?: string;
  }>;
}

export default async function FulfillmentOperatorsSettingsPage({
  searchParams,
}: SearchParams) {
  await requirePermission("members.manage");
  const sp = await searchParams;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Fulfillment partners</h1>
        <p className="pt-1 text-sm text-muted-foreground">
          Invite a warehouse or fulfillment partner contact. They get a sign-in link and a
          portal showing only the tickets your agent escalates to them — the
          problem, order reference, ship-to, and tracking, never your customers&apos;
          details.
        </p>
      </div>

      {sp.ok === "invited" ? (
        <Alert>
          <AlertDescription>
            Invitation sent. They&apos;ll see escalated tickets after they sign in.
          </AlertDescription>
        </Alert>
      ) : null}
      {sp.error ? (
        <Alert variant="destructive">
          <AlertDescription>
            Couldn&apos;t send the invitation ({sp.error}).
          </AlertDescription>
        </Alert>
      ) : null}

      <form
        action={inviteFulfillmentOperatorAction}
        className="space-y-4 rounded-lg border border-border bg-background p-5"
      >
        <div className="space-y-1.5">
          <Label htmlFor="name">Fulfillment partner name</Label>
          <Input id="name" name="name" placeholder="Acme Warehouse" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            name="email"
            type="email"
            required
            placeholder="ops@acme-warehouse.com"
          />
        </div>
        <SubmitButton pendingLabel="Sending…">Send invitation</SubmitButton>
      </form>
    </div>
  );
}
