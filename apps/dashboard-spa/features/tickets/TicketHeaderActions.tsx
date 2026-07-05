import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Bot,
  Check,
  Hand,
  Loader2,
  MoreVertical,
  RefreshCw,
  RotateCcw,
} from "lucide-react";

import { api } from "@/lib/api-client";
import { useTicketMutation } from "@/lib/use-ticket-mutation";
import { ticketActionMenuItems } from "@/lib/ticket-actions-menu";
import { ticketStatusLabel } from "@/lib/labels";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { EscalateSupplierDialog } from "./EscalateSupplierDialog";

// Merchant-facing copy for the hand-settable status targets; unknown targets
// fall back to a humanized "Mark as <status>". Mirrors the Next page.
const STATUS_MENU_LABEL: Record<
  string,
  { readonly label: string; readonly title: string }
> = {
  in_progress: {
    label: "Reopen (in progress)",
    title: "Move this ticket back to in progress",
  },
  waiting_for_customer: {
    label: "Mark waiting on customer",
    title: "Park this ticket waiting on the customer",
  },
  archived: {
    label: "Archive now",
    title:
      "Archive this ticket without waiting 30 days; it is deleted 12 months after archiving",
  },
  failed: { label: "Mark as failed", title: "Close this ticket as failed" },
};

interface Props {
  readonly workspaceId: string;
  readonly ticketId: string;
  readonly canResolve: boolean;
  readonly canTakeOver: boolean;
  readonly canResume: boolean;
  readonly showRetrySend: boolean;
  /** Offer "Escalate to supplier" in the ⋮ menu (not already with a supplier, not terminal). */
  readonly canEscalateSupplier: boolean;
  /** Offer "Block sender" in the ⋮ menu (ticket has a customer email + member holds settings.blocked_senders). */
  readonly canBlockSender: boolean;
  /** Hand-settable status targets (matrix-validated by the api). */
  readonly statusTargets: ReadonlyArray<string>;
  /** The RefundDialog trigger, when the order is refundable; sits before the ⋮ menu. */
  readonly refundSlot?: ReactNode;
}

/**
 * Cross-fades a spinner over the action icon while a mutation is pending.
 * Both icons stay in the DOM (spinner absolutely positioned on top) so enter
 * and exit both animate without a motion library.
 */
const swapIn = "scale-100 opacity-100 blur-0";
const swapOut = "scale-[0.25] opacity-0 blur-[4px]";
const swapTransition =
  "transition-[opacity,filter,scale] duration-300 ease-[cubic-bezier(0.2,0,0,1)]";

const PendingSwapIcon = ({
  pending,
  children,
}: {
  readonly pending: boolean;
  readonly children: ReactNode;
}) => (
  <span className="relative inline-flex" aria-hidden>
    <span
      className={cn(
        "absolute inset-0 flex items-center justify-center",
        swapTransition,
        pending ? swapIn : swapOut,
      )}
    >
      <Loader2 className="animate-spin" />
    </span>
    <span className={cn("inline-flex", swapTransition, pending ? swapOut : swapIn)}>
      {children}
    </span>
  </span>
);

// Icon-only triggers are 36px square; the ::after pseudo-element pads the hit
// area out to 40px without colliding with the 6px-gapped neighbors.
const hitAreaExtension = "relative after:absolute after:-inset-0.5 after:content-['']";

const IconActionButton = ({
  onClick,
  pending,
  title,
  variant = "outline",
  children,
}: {
  readonly onClick: () => void;
  readonly pending: boolean;
  readonly title: string;
  readonly variant?: "outline" | "success";
  readonly children: ReactNode;
}) => (
  <Button
    size="icon"
    variant={variant}
    onClick={onClick}
    disabled={pending}
    aria-label={title}
    title={title}
    className={hitAreaExtension}
  >
    <PendingSwapIcon pending={pending}>{children}</PendingSwapIcon>
  </Button>
);

interface HeaderMenuItem {
  readonly key: string;
  readonly label: string;
  readonly title: string;
  readonly pending: boolean;
  readonly run: () => void;
}

/** An icon trigger + dropdown, shared by the retry (↺) and overflow (⋮) menus. */
const HeaderMenu = ({
  open,
  onOpenChange,
  label,
  trigger,
  items,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly label: string;
  readonly trigger: ReactNode;
  readonly items: ReadonlyArray<HeaderMenuItem>;
}) => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onClickOutside = (e: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) onOpenChange(false);
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open, onOpenChange]);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && open) {
            e.preventDefault();
            onOpenChange(false);
          }
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        className={cn(
          "inline-flex size-9 items-center justify-center rounded-md border border-input bg-transparent text-muted-foreground shadow-sm transition-[color,background-color,scale] duration-150 ease-out hover:bg-accent hover:text-accent-foreground active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
          hitAreaExtension,
        )}
      >
        {trigger}
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-1 min-w-[12rem] origin-top-right animate-in fade-in-0 zoom-in-95 slide-in-from-top-1 overflow-hidden rounded-md border bg-popover py-1 text-popover-foreground shadow-md duration-150"
        >
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              title={item.title}
              disabled={item.pending}
              onClick={item.run}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50",
              )}
            >
              {item.pending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : null}
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
};

export function TicketHeaderActions({
  workspaceId,
  ticketId,
  canResolve,
  canTakeOver,
  canResume,
  showRetrySend,
  canEscalateSupplier,
  canBlockSender,
  statusTargets,
  refundSlot,
}: Props) {
  const ctx = { workspaceId };
  const [retryOpen, setRetryOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [escalateOpen, setEscalateOpen] = useState(false);
  const [pendingStatus, setPendingStatus] = useState<string | null>(null);

  const base = { workspaceId, ticketId } as const;
  const resolveM = useTicketMutation({
    ...base,
    action: "resolve",
    mutationFn: () => api.resolveTicket(ctx, ticketId),
  });
  const takeoverM = useTicketMutation({
    ...base,
    action: "takeover",
    mutationFn: () => api.takeover(ctx, ticketId),
  });
  const resumeM = useTicketMutation({
    ...base,
    action: "resume",
    mutationFn: () => api.resume(ctx, ticketId),
  });
  const retrySendM = useTicketMutation({
    ...base,
    action: "retrySend",
    mutationFn: () => api.retrySend(ctx, ticketId),
  });
  const retryM = useTicketMutation({
    ...base,
    action: "retry",
    mutationFn: () => api.retry(ctx, ticketId),
    onDone: () => setRetryOpen(false),
  });
  const retryTriageM = useTicketMutation({
    ...base,
    action: "retry",
    mutationFn: () => api.retry(ctx, ticketId, { fromTriage: true }),
    onDone: () => setRetryOpen(false),
  });
  // Not a useTicketMutation: the outcome isn't a ticket-state kind, and the
  // list that changes is the settings blocklist, not the ticket queries.
  const blockSenderM = useMutation({
    mutationFn: () => api.blockTicketSender(ctx, ticketId),
    onSuccess: (res) => {
      setMenuOpen(false);
      if (res.status === 200) {
        const body = res.body as {
          blocked?: string;
          alreadyBlocked?: boolean;
        } | null;
        const who = body?.blocked ?? "this sender";
        if (body?.alreadyBlocked) {
          toast.info(`${who} is already blocked.`);
        } else {
          toast.success(`Future emails from ${who} will be ignored.`);
        }
        return;
      }
      const err = (res.body as { error?: string } | null)?.error;
      toast.warning(
        err === "missing_customer_email"
          ? "This ticket has no customer email to block."
          : "Something went wrong. Please try again.",
      );
    },
    onError: () => {
      toast.warning("Something went wrong. Please try again.");
    },
  });
  const setStatusM = useTicketMutation({
    ...base,
    action: "setStatus",
    mutationFn: (status: string) => api.setStatus(ctx, ticketId, status),
    onDone: () => {
      setPendingStatus(null);
      setMenuOpen(false);
    },
  });

  const retryItems = ticketActionMenuItems({ canResume }).map((item) => {
    const m = item.key === "retryNow" ? retryM : retryTriageM;
    return {
      key: item.key,
      label: m.isPending ? item.pendingLabel : item.label,
      title: item.title,
      pending: m.isPending,
      run: () => m.mutate(),
    };
  });
  const statusItems = statusTargets
    .filter((s) => s !== "resolved")
    .map((s) => ({
      key: `status-${s}`,
      label: STATUS_MENU_LABEL[s]?.label ?? `Mark as ${ticketStatusLabel(s)}`,
      title: STATUS_MENU_LABEL[s]?.title ?? `Set status to ${ticketStatusLabel(s)}`,
      pending: setStatusM.isPending && pendingStatus === s,
      run: () => {
        setPendingStatus(s);
        setStatusM.mutate(s);
      },
    }));
  const menuItems = [
    ...statusItems,
    ...(canEscalateSupplier
      ? [
          {
            key: "escalateSupplier",
            label: "Escalate to supplier",
            title:
              "Hand this ticket to your warehouse/supplier and wait for their update",
            pending: false,
            run: () => {
              setMenuOpen(false);
              setEscalateOpen(true);
            },
          },
        ]
      : []),
    ...(canBlockSender
      ? [
          {
            key: "blockSender",
            label: blockSenderM.isPending ? "Blocking…" : "Block sender",
            title:
              "Ignore future emails from this customer's address (manage the list under Settings → Blocked senders)",
            pending: blockSenderM.isPending,
            run: () => blockSenderM.mutate(),
          },
        ]
      : []),
  ];

  return (
    <div className="ml-auto flex shrink-0 items-center gap-1.5">
      {canResolve ? (
        <Button
          variant="success"
          onClick={() => resolveM.mutate()}
          disabled={resolveM.isPending}
          title="Resolve this ticket"
          className="pl-3.5"
        >
          <PendingSwapIcon pending={resolveM.isPending}>
            <Check aria-hidden />
          </PendingSwapIcon>
          Resolve
        </Button>
      ) : null}
      {canTakeOver ? (
        <IconActionButton
          onClick={() => takeoverM.mutate()}
          pending={takeoverM.isPending}
          title="Take over — handle this ticket manually"
        >
          <Hand aria-hidden />
        </IconActionButton>
      ) : null}
      {canResume ? (
        <>
          {showRetrySend ? (
            <IconActionButton
              onClick={() => retrySendM.mutate()}
              pending={retrySendM.isPending}
              title="Retry sending the failed reply"
            >
              <RefreshCw aria-hidden />
            </IconActionButton>
          ) : null}
          <IconActionButton
            onClick={() => resumeM.mutate()}
            pending={resumeM.isPending}
            title="Hand back to the agent"
          >
            <Bot aria-hidden />
          </IconActionButton>
        </>
      ) : null}

      {refundSlot}

      {retryItems.length > 0 ? (
        <HeaderMenu
          open={retryOpen}
          onOpenChange={setRetryOpen}
          label="Retry"
          trigger={<RotateCcw className="size-4" aria-hidden />}
          items={retryItems}
        />
      ) : null}

      {menuItems.length > 0 ? (
        <HeaderMenu
          open={menuOpen}
          onOpenChange={setMenuOpen}
          label="More actions"
          trigger={<MoreVertical className="size-4" aria-hidden />}
          items={menuItems}
        />
      ) : null}

      <EscalateSupplierDialog
        workspaceId={workspaceId}
        ticketId={ticketId}
        open={escalateOpen}
        onOpenChange={setEscalateOpen}
      />
    </div>
  );
}
