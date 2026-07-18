const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const progress = (time, start, end) => clamp((time - start) / (end - start));
const smooth = (value) => value * value * (3 - 2 * value);
const mix = (from, to, amount) => from + (to - from) * amount;
const easing = {
  easeInOutCubic: (value) =>
    value < 0.5
      ? 4 * value * value * value
      : 1 - Math.pow(-2 * value + 2, 3) / 2,
  easeOutQuad: (value) => 1 - Math.pow(1 - value, 2),
  easeOutCubic: (value) => 1 - Math.pow(1 - value, 3),
  easeOutExpo: (value) => (value === 1 ? 1 : 1 - Math.pow(2, -10 * value)),
};

export const segments = [
  { start: 0, end: 4, plate: "customer-message" },
  { start: 4, end: 6, plate: "agent-investigation-empty" },
  { start: 6, end: 7.8, plate: "agent-investigation-customer" },
  { start: 7.8, end: 9.8, plate: "agent-investigation-order" },
  { start: 9.8, end: 13, plate: "agent-investigation" },
  { start: 13, end: 16, plate: "merchant-approval" },
  { start: 16, end: 18, plate: "reassurance-sent" },
  { start: 18, end: 21, plate: "partner-inbox" },
  { start: 21, end: 28, plate: "fulfillment-resolution" },
  { start: 28, end: 35, plate: "customer-update" },
  { start: 35, end: 39, plate: "sent-update" },
  { start: 39, end: 45, plate: "delivered-delight" },
];

export const cameraFrames = [
  { time: 0, x: 728, y: 593, scale: 1.5 },
  { time: 3.55, x: 728, y: 593, scale: 1.5 },
  { time: 4.15, x: 0, y: 0, scale: 1, ease: "easeOutCubic" },
  { time: 4.85, x: 0, y: 0, scale: 1 },
  { time: 5.65, x: -650, y: 120, scale: 1.18, ease: "easeOutQuad" },
  { time: 7.65, x: -650, y: 120, scale: 1.18 },
  { time: 8.35, x: -650, y: 10, scale: 1.18, ease: "easeOutQuad" },
  { time: 9.65, x: -650, y: 10, scale: 1.18 },
  { time: 10.35, x: -650, y: -125, scale: 1.18, ease: "easeOutQuad" },
  { time: 12.35, x: -650, y: -125, scale: 1.18 },
  { time: 13.05, x: 45, y: -95, scale: 1.12, ease: "easeOutCubic" },
  { time: 15.9, x: 45, y: -95, scale: 1.12 },
  { time: 16.25, x: 0, y: 0, scale: 1, ease: "easeOutExpo" },
  { time: 17.55, x: 0, y: 0, scale: 1 },
  { time: 18.1, x: 0, y: 0, scale: 1, ease: "easeOutExpo" },
  { time: 21.1, x: 0, y: 0, scale: 1 },
  { time: 21.55, x: -110, y: -80, scale: 1.12, ease: "easeOutCubic" },
  { time: 27.55, x: -110, y: -80, scale: 1.12 },
  { time: 28.15, x: 0, y: 0, scale: 1, ease: "easeOutCubic" },
  { time: 29.2, x: 25, y: -118, scale: 1.15, ease: "easeOutCubic" },
  { time: 35.1, x: 25, y: -118, scale: 1.15 },
  { time: 35.55, x: 0, y: 0, scale: 1, ease: "easeOutExpo" },
  { time: 45, x: 0, y: 0, scale: 1 },
];

export const visibleCursorCues = [
  {
    target: "approve-bundle",
    plate: "merchant-approval",
    start: 14.55,
    arrive: 15.15,
    click: 15.8,
    end: 17,
    fromOffset: { x: -150, y: 75 },
  },
  {
    target: "partner-ticket",
    plate: "partner-inbox",
    start: 18.85,
    arrive: 19.45,
    click: 20,
    end: 20.8,
    fromOffset: { x: 180, y: 110 },
  },
  {
    target: "partner-note",
    plate: "fulfillment-resolution",
    start: 21.55,
    arrive: 22.1,
    click: 22.3,
    end: 24.2,
    fromOffset: { x: 120, y: -70 },
  },
  {
    target: "partner-submit",
    plate: "fulfillment-resolution",
    start: 25.75,
    arrive: 26.35,
    click: 26.7,
    end: 27.55,
    fromOffset: { x: -150, y: 65 },
  },
  {
    target: "customer-send",
    plate: "customer-update",
    start: 33.35,
    arrive: 34,
    click: 34.5,
    end: 35,
    fromOffset: { x: -120, y: 55 },
  },
];

export const sampleFrames = (time, frames) => {
  if (time <= frames[0].time) return frames[0];
  const last = frames.at(-1);
  if (time >= last.time) return last;
  for (let index = 0; index < frames.length - 1; index += 1) {
    const from = frames[index];
    const to = frames[index + 1];
    if (time >= from.time && time <= to.time) {
      const rawAmount = progress(time, from.time, to.time);
      const amount = (easing[to.ease] ?? easing.easeInOutCubic)(rawAmount);
      return {
        time,
        x: mix(from.x, to.x, amount),
        y: mix(from.y, to.y, amount),
        scale: mix(from.scale, to.scale, amount),
      };
    }
  }
  return last;
};

export const cameraAt = (time) => sampleFrames(time, cameraFrames);

export const plateAt = (time) =>
  segments.find(({ start, end }) => time >= start && time < end)?.plate ??
  segments.at(-1).plate;

const deliveryStatuses = [
  {
    start: 9.8,
    end: 13,
    key: "undelivered",
    label: "Undelivered",
    detail: "Original shipment stalled",
  },
  {
    start: 35,
    end: 37,
    key: "in-transit",
    label: "In transit",
    detail: "Replacement is moving",
  },
  {
    start: 39,
    end: 43,
    key: "delivered",
    label: "Delivered",
    detail: "Package reached Maya",
  },
];

export const deliveryStatusAt = (time) =>
  deliveryStatuses.find(({ start, end }) => time >= start && time < end) ??
  null;

export const dashboardPointToScreen = (
  point,
  camera,
  viewport = { width: 1920, height: 1080 },
) => ({
  x:
    viewport.width / 2 +
    camera.scale * (point.x - viewport.width / 2) +
    camera.x,
  y:
    viewport.height / 2 +
    camera.scale * (point.y - viewport.height / 2) +
    camera.y,
});

export const openingMessageAnimationTime = (time) =>
  350 * progress(time, 0.7, 1.05);

export const openingMessageKeyframes = [
  { opacity: 0, transform: "translateY(14px)" },
  { opacity: 1, transform: "translateY(0)" },
];

export const openingMessageOptions = {
  duration: 350,
  easing: "cubic-bezier(0.2, 0, 0, 1)",
  fill: "both",
};

export const cueProgress = (time, cue) => ({
  movement: easing.easeOutExpo(progress(time, cue.start, cue.arrive)),
  opacity:
    smooth(progress(time, cue.start, cue.start + 0.25)) *
    (1 - smooth(progress(time, cue.end - 0.25, cue.end))),
  click: 1 - clamp(Math.abs(time - cue.click) / 0.32),
});
