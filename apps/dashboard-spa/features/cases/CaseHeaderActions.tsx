import { useEffect, useRef, useState, type ReactNode } from "react";
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
import { useCaseMutation } from "@/lib/use-case-mutation";
import { caseActionMenuItems } from "@/lib/case-actions-menu";
import { caseStatusLabel } from "@/lib/labels";
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
    title: "Move this case back to in progress",
  },
  waiting_for_customer: {
    label: "Mark waiting on customer",
    title: "Park this case waiting on the customer",
  },
  archived: {
    label: "Archive now",
    title:
      "Archive this case without waiting 30 days; it is deleted 12 months after archiving",
  },
  failed: { label: "Mark as failed", title: "Close this case as failed" },
};

interface Props {
  readonly workspaceId: string;
  readonly caseId: string;
  readonly canResolve: boolean;
  readonly canTakeOver: boolean;
  readonly canResume: boolean;
  readonly showRetrySend: boolean;
  /** Offer "Escalate to supplier" in the ⋮ menu (not already with a supplier, not terminal). */
  readonly canEscalateSupplier: boolean;
  /** Hand-settable status targets (matrix-validated by the api). */
  readonly statusTargets: ReadonlyArray<string>;
  /** The RefundDialog trigger, when the order is refundable; sits before the ⋮ menu. */
  readonly refundSlot?: ReactNode;
}

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
  >
    {pending ? <Loader2 className="animate-spin" aria-hidden /> : children}
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
        className="inline-flex size-9 items-center justify-center rounded-md border border-input bg-transparent text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
      >
        {trigger}
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-1 min-w-[12rem] overflow-hidden rounded-md border bg-popover py-1 text-popover-foreground shadow-md"
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

export function CaseHeaderActions({
  workspaceId,
  caseId,
  canResolve,
  canTakeOver,
  canResume,
  showRetrySend,
  canEscalateSupplier,
  statusTargets,
  refundSlot,
}: Props) {
  const ctx = { workspaceId };
  const [retryOpen, setRetryOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [escalateOpen, setEscalateOpen] = useState(false);
  const [pendingStatus, setPendingStatus] = useState<string | null>(null);

  const base = { workspaceId, caseId } as const;
  const resolveM = useCaseMutation({
    ...base,
    action: "resolve",
    mutationFn: () => api.resolveCase(ctx, caseId),
  });
  const takeoverM = useCaseMutation({
    ...base,
    action: "takeover",
    mutationFn: () => api.takeover(ctx, caseId),
  });
  const resumeM = useCaseMutation({
    ...base,
    action: "resume",
    mutationFn: () => api.resume(ctx, caseId),
  });
  const retrySendM = useCaseMutation({
    ...base,
    action: "retrySend",
    mutationFn: () => api.retrySend(ctx, caseId),
  });
  const retryM = useCaseMutation({
    ...base,
    action: "retry",
    mutationFn: () => api.retry(ctx, caseId),
    onDone: () => setRetryOpen(false),
  });
  const retryTriageM = useCaseMutation({
    ...base,
    action: "retry",
    mutationFn: () => api.retry(ctx, caseId, { fromTriage: true }),
    onDone: () => setRetryOpen(false),
  });
  const setStatusM = useCaseMutation({
    ...base,
    action: "setStatus",
    mutationFn: (status: string) => api.setStatus(ctx, caseId, status),
    onDone: () => {
      setPendingStatus(null);
      setMenuOpen(false);
    },
  });

  const retryItems = caseActionMenuItems({ canResume }).map((item) => {
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
      label: STATUS_MENU_LABEL[s]?.label ?? `Mark as ${caseStatusLabel(s)}`,
      title: STATUS_MENU_LABEL[s]?.title ?? `Set status to ${caseStatusLabel(s)}`,
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
              "Hand this case to your warehouse/supplier and wait for their update",
            pending: false,
            run: () => {
              setMenuOpen(false);
              setEscalateOpen(true);
            },
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
          title="Resolve this case"
        >
          {resolveM.isPending ? (
            <Loader2 className="animate-spin" aria-hidden />
          ) : (
            <Check aria-hidden />
          )}
          Resolve
        </Button>
      ) : null}
      {canTakeOver ? (
        <IconActionButton
          onClick={() => takeoverM.mutate()}
          pending={takeoverM.isPending}
          title="Take over — handle this case manually"
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
        caseId={caseId}
        open={escalateOpen}
        onOpenChange={setEscalateOpen}
      />
    </div>
  );
}
