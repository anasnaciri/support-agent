
import { useState } from "react";
import { Link } from "@/components/ui/link";
import { usePathname } from "@/lib/navigation";
import { Settings } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import guidezillaLogo from "@/guidezilla-logo-dark.svg";

import type {
  RbacPermissionId,
  WorkspaceSummary,
} from "@support-agent/dashboard-contracts";

import { cn } from "@/lib/utils";
import { hasAnySettingsAccess } from "@/lib/settings-nav-items";
import { PRIMARY_NAV } from "@/lib/primary-nav";
import { SignOutButton } from "./SignOutButton";
import { ThemeSwitch } from "./ThemeSwitch";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

interface NavItem {
  readonly href: string;
  readonly label: string;
  readonly icon: LucideIcon;
  /** Permission needed to see this item; absent → always shown. */
  readonly requires?: RbacPermissionId;
}

/**
 * Filter nav by the member's permissions. `null` permissions → fail-open (show
 * all): the api + page guards remain the real boundary, so a transient
 * permissions-load blip never strands a member with an empty rail.
 */
const visiblePrimaryNav = (
  permissions: ReadonlySet<RbacPermissionId> | null,
): ReadonlyArray<NavItem> =>
  permissions === null
    ? PRIMARY_NAV
    : PRIMARY_NAV.filter(
        (item) => !item.requires || permissions.has(item.requires),
      );

/**
 * Label beside a rail icon. On the hover rail it fades in as the rail
 * expands; in the mobile nav drawer (`expanded`) it's always visible — there
 * is no hover on touch. `truncate` (+ flex-1) collapses it to zero width when
 * the rail is narrow, so long text never spills past the rail into content.
 */
const railLabelClass = (expanded: boolean): string =>
  cn(
    "min-w-0 flex-1 truncate text-sm font-medium",
    expanded
      ? "opacity-100"
      : "opacity-0 transition-opacity duration-200 group-hover/rail:opacity-100",
  );

const isActive = (pathname: string, href: string): boolean => {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
};

const RailLink = ({
  item,
  active,
  expanded,
  onNavigate,
}: {
  readonly item: NavItem;
  readonly active: boolean;
  readonly expanded: boolean;
  readonly onNavigate?: (() => void) | undefined;
}) => {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      title={item.label}
      aria-label={item.label}
      aria-current={active ? "page" : undefined}
      onClick={onNavigate}
      className={cn(
        "flex h-10 w-full items-center gap-3 rounded-lg transition-colors",
        active
          ? "bg-white/10 text-sidebar-foreground"
          : "text-sidebar-foreground/55 hover:bg-white/5 hover:text-sidebar-foreground",
      )}
    >
      <span className="flex size-10 shrink-0 items-center justify-center">
        <Icon className="size-5" aria-hidden />
      </span>
      <span className={railLabelClass(expanded)}>{item.label}</span>
    </Link>
  );
};

interface RailNavContentProps {
  readonly email: string | null;
  /** Workspaces for the switcher; null → signed out / pre-onboarding. */
  readonly workspaces: ReadonlyArray<WorkspaceSummary> | null;
  readonly activeWorkspaceId: string | null;
  /** Member's effective permissions for nav gating; null → fail-open. */
  readonly permissions: ReadonlyArray<RbacPermissionId> | null;
  /** True in the mobile nav drawer: labels always on, popovers repositioned. */
  readonly expanded: boolean;
  /** Called when a nav link is clicked (the drawer closes itself). */
  readonly onNavigate?: (() => void) | undefined;
  readonly signOutOpen: boolean;
  readonly onSignOutOpenChange: (open: boolean) => void;
}

/**
 * The rail's inner column — logo, workspace switcher, primary nav, footer
 * (theme / settings / sign-out) — shared by the desktop hover-expand rail and
 * the mobile nav drawer. `expanded` picks the presentation: hover-revealed
 * labels and rightward popovers on the rail; always-visible labels and
 * in-panel popovers in the drawer.
 */
export function RailNavContent({
  email,
  workspaces,
  activeWorkspaceId,
  permissions,
  expanded,
  onNavigate,
  signOutOpen,
  onSignOutOpenChange,
}: RailNavContentProps) {
  const pathname = usePathname() ?? "/";

  const permSet = permissions === null ? null : new Set(permissions);
  const primaryNav = visiblePrimaryNav(permSet);
  // Show the Settings cog only when the member has a gated settings item (or
  // we couldn't load permissions → fail-open).
  const showSettings = permSet === null || hasAnySettingsAccess(permSet);

  const activeWorkspace =
    workspaces && activeWorkspaceId
      ? (workspaces.find((w) => w.id === activeWorkspaceId) ?? workspaces[0])
      : null;

  return (
    <>
      <Link
        href="/"
        title="Guidezilla"
        aria-label="Guidezilla home"
        onClick={onNavigate}
        className="flex h-10 w-full items-center gap-3 rounded-lg"
      >
        {/* Tile uses the logo's own blue (#0345FC) so the contained
            landscape art blends seamlessly — white croc on a blue tile,
            which reads on the always-dark rail in light and dark themes. */}
        <span className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-[#0345FC]">
          <img
            src={guidezillaLogo}
            alt=""
            aria-hidden
            className="size-10 object-contain"
          />
        </span>
        <span
          className={cn(
            railLabelClass(expanded),
            "font-[family-name:var(--font-climate-crisis)] text-lg tracking-wide",
          )}
        >
          Guidezilla
        </span>
      </Link>

      {workspaces && workspaces.length > 0 && activeWorkspace ? (
        <div className="mt-3 flex w-full items-center gap-3">
          <WorkspaceSwitcher menuPlacement={expanded ? "below" : "right"} />
          <span className={railLabelClass(expanded)}>
            {activeWorkspace.name}
          </span>
        </div>
      ) : null}

      <nav className="mt-6 flex flex-1 flex-col gap-1">
        {primaryNav.map((item) => (
          <RailLink
            key={item.href}
            item={item}
            active={isActive(pathname, item.href)}
            expanded={expanded}
            onNavigate={onNavigate}
          />
        ))}
      </nav>

      <div className="flex flex-col gap-1">
        <ThemeSwitch expanded={expanded} />
        {showSettings ? (
          <RailLink
            item={{ href: "/settings", label: "Settings", icon: Settings }}
            active={isActive(pathname, "/settings")}
            expanded={expanded}
            onNavigate={onNavigate}
          />
        ) : null}
        <SignOutButton
          email={email}
          labelClassName={railLabelClass(expanded)}
          open={signOutOpen}
          onOpenChange={onSignOutOpenChange}
          placement={expanded ? "above" : "right"}
        />
      </div>
    </>
  );
}

interface Props {
  readonly email: string | null;
  /** Workspaces for the switcher; null → signed out / pre-onboarding. */
  readonly workspaces: ReadonlyArray<WorkspaceSummary> | null;
  readonly activeWorkspaceId: string | null;
  /** Member's effective permissions for nav gating; null → fail-open. */
  readonly permissions: ReadonlyArray<RbacPermissionId> | null;
}

export function IconRail({
  email,
  workspaces,
  activeWorkspaceId,
  permissions,
}: Props) {
  // Owned here (not in SignOutButton) so the rail can clear the confirmation
  // when the pointer leaves — it hides together with the collapsing rail.
  const [signOutOpen, setSignOutOpen] = useState(false);

  return (
    // The 64px spacer holds the column in the layout flow; the rail itself is
    // absolutely positioned so that expanding on hover overlays the content
    // rather than reflowing the whole app.
    <div className="relative w-16 shrink-0">
      <aside
        onMouseLeave={() => setSignOutOpen(false)}
        className="group/rail absolute inset-y-0 left-0 z-40 flex w-16 flex-col items-stretch bg-sidebar px-3 py-4 text-sidebar-foreground transition-[width,box-shadow] duration-200 ease-in-out hover:w-60 hover:shadow-[6px_0_28px_-12px_rgba(0,0,0,0.55)]"
      >
        <RailNavContent
          email={email}
          workspaces={workspaces}
          activeWorkspaceId={activeWorkspaceId}
          permissions={permissions}
          expanded={false}
          signOutOpen={signOutOpen}
          onSignOutOpenChange={setSignOutOpen}
        />
      </aside>
    </div>
  );
}
