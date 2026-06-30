import { ExternalLink, Truck } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import {
  TRACKING_STATUS_LABEL,
  daysBetween,
  trackingStatusVariant,
  trackingUrlFor,
  type ParsedTracking,
} from "./tracking-panel-data";

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
    <dt className="text-[11px] uppercase tracking-wider text-muted-foreground">
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
export const TrackingPanel = ({
  tracking,
  destinationCountry,
  orderPlacedAt,
}: Props) => {
  const url = trackingUrlFor(tracking);
  const days =
    tracking.status && tracking.status !== "delivered"
      ? daysBetween(orderPlacedAt, Date.now())
      : null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
          <Truck className="size-3.5" aria-hidden />
          Tracking
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 pt-0">
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

        <dl className="grid grid-cols-[max-content_1fr] items-center gap-x-3 gap-y-1.5">
          {tracking.carrier ? <Row label="Carrier">{tracking.carrier}</Row> : null}
          {destinationCountry ? (
            <Row label="Destination">{destinationCountry}</Row>
          ) : null}
          {tracking.estimatedDeliveryAt ? (
            <Row label="ETA">{dateOnly(tracking.estimatedDeliveryAt)}</Row>
          ) : null}
        </dl>

        {tracking.lastScan ? (
          <div className="space-y-0.5 border-t border-dashed border-border pt-2">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
              Latest update
            </div>
            <div className="text-sm tabular-nums">
              {dateTime(tracking.lastScan.occurredAt)}
              {tracking.lastScan.location ? (
                <span className="text-muted-foreground">
                  {" · "}
                  {tracking.lastScan.location}
                </span>
              ) : null}
            </div>
            {tracking.lastScan.description ? (
              <p className="text-sm text-muted-foreground">
                {tracking.lastScan.description}
              </p>
            ) : null}
          </div>
        ) : null}

        {tracking.kind === "no_provider" ? (
          <p className="text-sm italic text-muted-foreground">
            Live tracking isn&apos;t available for this carrier — open it on
            17track for the latest status.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
};
