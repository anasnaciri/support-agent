import type { ShopifyCustomer } from "@support-agent/agent-core";
import { User } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import { customerStats } from "@/lib/customer-panel-data";

interface Props {
  readonly customer: ShopifyCustomer | null;
  readonly customerEmail: string | null;
  /**
   * The order's email, confirmed by the requester on an order/customer mismatch
   * case (runtime-stamped, never model-set). Shown distinctly from `Email`,
   * which is the corresponding address and may be a typo or a different sender.
   */
  readonly verifiedOrderEmail?: string | null;
  /** Rendered in the panel header (the edit-customer pencil). */
  readonly headerAction?: React.ReactNode;
}

const fullName = (c: ShopifyCustomer): string | null => {
  const parts = [c.firstName, c.lastName].filter(
    (s): s is string => typeof s === "string" && s.length > 0,
  );
  return parts.length > 0 ? parts.join(" ") : null;
};

/** Up to two initials from a display name, else the email's first letter. */
const initialsOf = (name: string | null, email: string | null): string => {
  const source = name ?? email ?? "";
  const words = source.split(/[\s@._-]+/).filter(Boolean);
  const letters = (words[0]?.[0] ?? "") + (words.length > 1 ? words[1]![0]! : "");
  return letters.toUpperCase() || "?";
};

const PanelShell = ({
  children,
  headerAction,
}: {
  readonly children: React.ReactNode;
  readonly headerAction?: React.ReactNode;
}) => (
  <Card>
    <CardHeader className="flex flex-row items-center justify-between gap-2 p-4 pb-3 2xl:p-6 2xl:pb-3">
      <CardTitle className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
        <User className="size-3.5" aria-hidden />
        Customer
      </CardTitle>
      {headerAction}
    </CardHeader>
    <CardContent className="p-4 pt-0 2xl:p-6 2xl:pt-0">{children}</CardContent>
  </Card>
);

const Stat = ({
  label,
  value,
  hint,
}: {
  readonly label: string;
  readonly value: string;
  readonly hint: string | null;
}) => (
  <div className="rounded-lg border border-border bg-muted/30 px-2.5 py-2">
    <div className="truncate font-mono text-[0.9375rem] font-medium leading-tight">
      {value}
      {hint ? (
        <span className="ml-1 text-[0.625rem] font-normal text-muted-foreground">
          {hint}
        </span>
      ) : null}
    </div>
    <div className="mt-1 text-[0.625rem] uppercase tracking-wider text-muted-foreground">
      {label}
    </div>
  </div>
);

/** A labelled contact line (email / phone / address). */
const Detail = ({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) => (
  <div className="flex items-baseline gap-2">
    <dt className="w-24 shrink-0 text-[0.6875rem] uppercase tracking-wider text-muted-foreground">
      {label}
    </dt>
    <dd className="min-w-0 flex-1 break-words text-sm">{children}</dd>
  </div>
);

/** The customer avatar + name/email header shared by every state. */
const Identity = ({
  name,
  email,
}: {
  readonly name: string | null;
  readonly email: string | null;
}) => (
  <div className="flex items-center gap-3">
    <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
      {initialsOf(name, email)}
    </div>
    <div className="min-w-0">
      {name ? <div className="truncate text-sm font-semibold">{name}</div> : null}
      <div className="truncate text-xs text-muted-foreground">
        {email ?? "No email on file"}
      </div>
    </div>
  </div>
);

export const CustomerPanel = ({
  customer,
  customerEmail,
  verifiedOrderEmail,
  headerAction,
}: Props) => {
  const verified =
    typeof verifiedOrderEmail === "string" && verifiedOrderEmail.length > 0
      ? verifiedOrderEmail
      : null;

  if (!customer && !customerEmail && !verified) {
    return (
      <PanelShell headerAction={headerAction}>
        <p className="text-pretty text-sm italic text-muted-foreground">
          No customer linked to this case yet.
        </p>
      </PanelShell>
    );
  }

  if (!customer) {
    return (
      <PanelShell headerAction={headerAction}>
        <Identity name={null} email={customerEmail} />
        {verified ? (
          <dl className="mt-4">
            <Detail label="Verified order email">{verified}</Detail>
          </dl>
        ) : null}
        <p className="mt-3 text-pretty text-sm italic text-muted-foreground">
          No matching Shopify customer (or store not connected).
        </p>
      </PanelShell>
    );
  }

  const name = fullName(customer);
  const email = customer.email ?? customerEmail;
  const addr = customer.defaultAddress;
  const stats = customerStats(customer);

  return (
    <PanelShell headerAction={headerAction}>
      <Identity name={name} email={email} />

      <div className="mt-4 grid grid-cols-3 gap-2">
        {stats.map((s) => (
          <Stat key={s.label} label={s.label} value={s.value} hint={s.hint} />
        ))}
      </div>

      <dl className="mt-4 space-y-1.5">
        {verified && verified !== customer.email ? (
          <Detail label="Verified order email">{verified}</Detail>
        ) : null}
        {customer.phone ? <Detail label="Phone">{customer.phone}</Detail> : null}
        {addr ? (
          <Detail label="Address">
            {[addr.city, addr.province, addr.country]
              .filter((s): s is string => Boolean(s))
              .join(", ") || "—"}
          </Detail>
        ) : null}
      </dl>
    </PanelShell>
  );
};
