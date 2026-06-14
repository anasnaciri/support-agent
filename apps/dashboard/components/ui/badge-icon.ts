import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Info,
  type LucideIcon,
} from "lucide-react";

/**
 * The leading status glyph for each Badge variant. The semantic variants —
 * and their brighter cousins — share a glyph: error → circle-alert, success →
 * circle-check, warning → triangle-alert, info → info. Neutral variants
 * (default / secondary / outline / muted) are intentionally absent: their
 * color and label already carry the meaning, so they stay icon-free.
 *
 * Kept out of `badge.tsx` (which pulls in `@/lib/utils`) so the mapping is
 * unit-testable on its own without the path alias.
 */
const VARIANT_ICONS: Readonly<Record<string, LucideIcon>> = {
  destructive: AlertCircle,
  destructiveBright: AlertCircle,
  success: CheckCircle2,
  successBright: CheckCircle2,
  warning: AlertTriangle,
  warningBright: AlertTriangle,
  info: Info,
  infoBright: Info,
};

/** The default leading icon for a badge variant, or null for neutral ones. */
export const badgeIcon = (
  variant: string | null | undefined,
): LucideIcon | null => (variant ? (VARIANT_ICONS[variant] ?? null) : null);
