import { ExternalLink, Truck } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

import {
  TRACKING_STATUS_LABEL,
  daysBetween,
  trackingStatusVariant,
  trackingUrlFor,
  type ParsedTracking,
} from "@/lib/tracking-panel-data";

interface Props {
  readonly tracking: ParsedTracking;
  /** Order's ship-to country, shown as the destination leg. */
  readonly destinationCountry: string | null;
  /** Order placed-at — drives the "in transit N days" hint. */
  readonly orderPlacedAt: string | Date | null;
}

const dateTime = (iso: string): string => iso.slice(0, 16).replace("T", " ");
const dateOnly = (iso: string): string => iso.slice(0, 10);

const Row = ({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) => (
  <>
    <dt className="text-[0.6875rem] uppercase tracking-wider text-muted-foreground">
      {label}
    </dt>
    <dd className="text-sm">{children}</dd>
  </>
);

/**
 * 17track-style shipment card: the tracking number (with a deep link), the
 * coarse delivery status + days-in-transit, the carrier → destination legs, the
 * latest carrier checkpoint, and an ETA. Fed by `context.liveTrackingStatus`
 * (stamped when an agent ran `tracking.lookup`); degrades gracefully for the
 * `no_provider` arm. Sits under the Customer + Order cards.
 */
const MAX_CHECKPOINTS = 3;

export const TrackingPanel = ({
  tracking,
  destinationCountry,
  orderPlacedAt,
}: Props) => {
  const url = trackingUrlFor(tracking);
  // Prefer the carrier's own transit-days metric; fall back to days since the
  // order was placed. Hidden once delivered.
  const days =
    tracking.status === "delivered"
      ? null
      : (tracking.transitDays ?? daysBetween(orderPlacedAt, Date.now()));
  const destination = tracking.destinationCountry ?? destinationCountry;
  const origin = tracking.originCountry;
  // Full carrier timeline (newest-first); fall back to the single last scan.
  const checkpoints =
    tracking.checkpoints.length > 0
      ? tracking.checkpoints
      : tracking.lastScan
        ? [tracking.lastScan]
        : [];
  const shownCheckpoints = checkpoints.slice(0, MAX_CHECKPOINTS);
  const hiddenCount = checkpoints.length - shownCheckpoints.length;

  return (
    <Card>
      <CardHeader className="p-4 pb-3 2xl:p-6 2xl:pb-3">
        <CardTitle className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
          <Truck className="size-3.5" aria-hidden />
          Tracking
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 p-4 pt-0 2xl:p-6 2xl:pt-0">
        <div className="flex items-center justify-between gap-2">
          <code className="break-all font-mono text-sm">
            {tracking.trackingNumber ?? "—"}
          </code>
          {url ? (
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex shrink-0 items-center gap-1 text-xs text-primary hover:underline"
              title="Open on 17track"
            >
              Track <ExternalLink className="size-3" aria-hidden />
            </a>
          ) : null}
        </div>

        {tracking.status ? (
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={trackingStatusVariant(tracking.status)}>
              {TRACKING_STATUS_LABEL[tracking.status]}
            </Badge>
            {days !== null ? (
              <span
                className="text-xs text-muted-foreground"
                title="Days since the order was placed"
              >
                {days} {days === 1 ? "day" : "days"}
              </span>
            ) : null}
          </div>
        ) : null}

        {origin || destination ? (
          <div className="flex items-center gap-2 text-sm">
            <span>{origin ?? "Origin"}</span>
            <span className="text-muted-foreground" aria-hidden>
              →
            </span>
            <span>{destination ?? "Destination"}</span>
          </div>
        ) : null}

        <dl className="grid grid-cols-[max-content_1fr] items-center gap-x-3 gap-y-1.5">
          {tracking.carrier ? <Row label="Carrier">{tracking.carrier}</Row> : null}
          {tracking.estimatedDeliveryAt ? (
            <Row label="ETA">{dateOnly(tracking.estimatedDeliveryAt)}</Row>
          ) : null}
        </dl>

        {shownCheckpoints.length > 0 ? (
          <div className="space-y-2 border-t border-dashed border-border pt-2">
            <div className="text-[0.6875rem] uppercase tracking-wider text-muted-foreground">
              {checkpoints.length > 1 ? "Checkpoints" : "Latest update"}
            </div>
            <ol
              aria-label="Shipment checkpoint timeline"
              className={cn(
                "relative space-y-2.5",
                shownCheckpoints.length > 1 &&
                  "before:absolute before:bottom-1 before:left-1 before:top-1 before:w-0.5 before:-translate-x-1/2 before:bg-border",
              )}
            >
              {shownCheckpoints.map((scan, i) => (
                <li
                  key={`${scan.occurredAt}-${i}`}
                  className="relative pb-0.5 pl-4"
                >
                  <span
                    className={cn(
                      "absolute left-1 top-1 z-10 size-2 -translate-x-1/2 rounded-full",
                      i === 0 ? "bg-primary" : "bg-muted-foreground/40",
                    )}
                    aria-hidden
                  />
                  <div className="text-xs tabular-nums text-muted-foreground">
                    {dateTime(scan.occurredAt)}
                    {scan.location ? ` · ${scan.location}` : ""}
                  </div>
                  {scan.description ? (
                    <p className="text-sm">{scan.description}</p>
                  ) : null}
                </li>
              ))}
            </ol>
            {hiddenCount > 0 ? (
              <p className="pl-4 text-xs text-muted-foreground">
                +{hiddenCount} earlier{" "}
                {hiddenCount === 1 ? "update" : "updates"}
                {url ? (
                  <>
                    {" · "}
                    <a
                      href={url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-primary hover:underline"
                    >
                      full history
                    </a>
                  </>
                ) : null}
              </p>
            ) : null}
          </div>
        ) : null}

        {tracking.kind === "no_provider" ? (
          <p className="text-sm italic text-muted-foreground">
            {tracking.reason === "sync_pending"
              ? "Live tracking is still syncing with the provider — open it on 17track for the latest status."
              : "Live tracking isn't available for this carrier — open it on 17track for the latest status."}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
};
