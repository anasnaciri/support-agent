import { DEMO_DATA, SUPPORT_DEMO_STORY } from "./story.js";

const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const progress = (time, start, end) => clamp((time - start) / (end - start));
const smooth = (value) => value * value * (3 - 2 * value);
const mix = (from, to, amount) => from + (to - from) * amount;
const plates = [...document.querySelectorAll("[data-plate]")];
const frameFor = (plate) => plate.querySelector("iframe");
const camera = document.querySelector("[data-camera]");
const cursor = document.querySelector("[data-demo-cursor]");
const cursorClick = document.querySelector("[data-cursor-click]");
const composerBeam = document.querySelector("[data-composer-beam]");
const timeJump = document.querySelector("[data-shot='time-jump']");

const segments = [
  { start: 0, end: 6, plate: "customer-message" },
  { start: 6, end: 13, plate: "agent-investigation" },
  { start: 13, end: 18, plate: "merchant-approval" },
  { start: 18, end: 21, plate: "partner-inbox" },
  { start: 21, end: 28, plate: "fulfillment-resolution" },
  { start: 28, end: 35, plate: "customer-update" },
  { start: 35, end: 39, plate: "sent-update" },
  { start: 39, end: 45, plate: "delivered-delight" },
];

const cameraFrames = [
  { time: 0, x: 0, y: 0, scale: 1 },
  { time: 1.2, x: 120, y: 70, scale: 1.18 },
  { time: 5.6, x: 120, y: 70, scale: 1.18 },
  { time: 6.4, x: 0, y: 0, scale: 1 },
  { time: 9.2, x: -205, y: 0, scale: 1.16 },
  { time: 12.4, x: -205, y: 0, scale: 1.16 },
  { time: 13.2, x: 45, y: -95, scale: 1.12 },
  { time: 17.6, x: 45, y: -95, scale: 1.12 },
  { time: 18.3, x: 0, y: 0, scale: 1 },
  { time: 21.3, x: 0, y: 0, scale: 1 },
  { time: 23, x: -110, y: -80, scale: 1.12 },
  { time: 27.6, x: -110, y: -80, scale: 1.12 },
  { time: 28.4, x: 0, y: 0, scale: 1 },
  { time: 30, x: 25, y: -118, scale: 1.15 },
  { time: 35.2, x: 25, y: -118, scale: 1.15 },
  { time: 36, x: 0, y: 0, scale: 1 },
  { time: 45, x: 0, y: 0, scale: 1 },
];

const cursorFrames = [
  { time: 0, x: 1200, y: 500, opacity: 0 },
  { time: 14, x: 1050, y: 915, opacity: 0 },
  { time: 15.2, x: 1200, y: 925, opacity: 1 },
  { time: 16.2, x: 1200, y: 925, opacity: 1 },
  { time: 17.5, x: 1200, y: 925, opacity: 0 },
  { time: 18.1, x: 520, y: 290, opacity: 0 },
  { time: 19.2, x: 690, y: 330, opacity: 1 },
  { time: 20.1, x: 690, y: 330, opacity: 1 },
  { time: 21.5, x: 1395, y: 174, opacity: 1 },
  { time: 23, x: 960, y: 825, opacity: 1 },
  { time: 26.2, x: 1210, y: 970, opacity: 1 },
  { time: 27.5, x: 1210, y: 970, opacity: 0 },
  { time: 29, x: 1110, y: 930, opacity: 0 },
  { time: 33.8, x: 1230, y: 982, opacity: 1 },
  { time: 35, x: 1230, y: 982, opacity: 0 },
  { time: 45, x: 1230, y: 982, opacity: 0 },
];

const sample = (time, frames) => {
  if (time <= frames[0].time) return frames[0];
  const last = frames.at(-1);
  if (time >= last.time) return last;
  for (let index = 0; index < frames.length - 1; index += 1) {
    const from = frames[index];
    const to = frames[index + 1];
    if (time >= from.time && time <= to.time) {
      const amount = smooth(progress(time, from.time, to.time));
      return Object.fromEntries(Object.keys(from).map((key) => [
        key,
        key === "time" ? time : mix(from[key], to[key], amount),
      ]));
    }
  }
  return last;
};

const typeText = (text, amount) => text.slice(0, Math.round(text.length * smooth(amount)));
const setNativeValue = (element, value) => {
  if (!element || element.value === value) return;
  const setter = Object.getOwnPropertyDescriptor(element.constructor.prototype, "value")?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
};

const editLiveFrames = (time) => {
  const partner = frameFor(document.querySelector("[data-plate='fulfillment-resolution']"))?.contentDocument;
  setNativeValue(partner?.querySelector("#note"), typeText("Item reshipped.", progress(time, 22, 24)));
  setNativeValue(partner?.querySelector("input[aria-label='New tracking number']"), typeText(DEMO_DATA.order.reshipmentTracking.number, progress(time, 24, 26)));

  const merchant = frameFor(document.querySelector("[data-plate='customer-update']"))?.contentDocument;
  setNativeValue(merchant?.querySelector("textarea"), typeText(DEMO_DATA.drafts.customerUpdate, progress(time, 29, 33.5)));
};

const clickAmount = (time) => Math.max(0, ...[15.8, 20, 26.7, 34.5].map((at) => 1 - clamp(Math.abs(time - at) / .32)));

export const renderAt = (rawTime) => {
  const time = clamp(Number(rawTime) || 0, 0, SUPPORT_DEMO_STORY.duration - .001);
  const segmentIndex = segments.findIndex(({ start, end }) => time >= start && time < end);
  const segment = segments[Math.max(0, segmentIndex)];
  const fade = segmentIndex > 0 ? smooth(progress(time, segment.start, segment.start + .42)) : 1;
  plates.forEach((plate) => {
    const current = plate.dataset.plate === segment.plate;
    const previous = segmentIndex > 0 && plate.dataset.plate === segments[segmentIndex - 1].plate;
    plate.style.opacity = String(current ? fade : previous ? 1 - fade : 0);
    plate.style.zIndex = String(current ? 2 : previous ? 1 : 0);
  });

  const cameraFrame = sample(time, cameraFrames);
  camera.style.transform = `translate3d(${cameraFrame.x}px, ${cameraFrame.y}px, 0) scale(${cameraFrame.scale})`;
  const cursorFrame = sample(time, cursorFrames);
  cursor.style.opacity = String(cursorFrame.opacity);
  cursor.style.transform = `translate3d(${cursorFrame.x}px, ${cursorFrame.y}px, 0) scale(${mix(1, .94, clickAmount(time))})`;
  const click = clickAmount(time);
  cursorClick.style.opacity = String(click);
  cursorClick.style.transform = `scale(${mix(.5, 1.6, 1 - click)})`;

  const beam = progress(time, 28.4, 29) * (1 - progress(time, 33.8, 34.4));
  composerBeam.style.opacity = String(smooth(beam));
  composerBeam.style.setProperty("--beam-x", `${(time * 70) % 220}%`);
  const jump = smooth(progress(time, 37, 37.6)) * (1 - smooth(progress(time, 38.4, 39)));
  timeJump.style.opacity = String(jump);
  editLiveFrames(time);
};

const prepareFrames = () => {
  const partner = frameFor(document.querySelector("[data-plate='fulfillment-resolution']"))?.contentDocument;
  partner?.querySelector("button[aria-label='Show order context']")?.click();
  requestAnimationFrame(() => requestAnimationFrame(() => {
    partner?.querySelector("button[aria-label='Change tracking number']")?.click();
    renderAt(timelineTime);
  }));
};

window.addEventListener("hf-seek", (event) => renderAt(event.detail?.time ?? 0));
window.__supportDemoSeek = renderAt;
let timelineTime = 0;
const timeline = {
  duration: () => SUPPORT_DEMO_STORY.duration,
  time: () => timelineTime,
  seek: (time) => { timelineTime = clamp(Number(time) || 0, 0, SUPPORT_DEMO_STORY.duration); renderAt(timelineTime); return timeline; },
  play: () => timeline,
  pause: () => timeline,
};
window.__timelines = window.__timelines || {};
window.__timelines["support-resolution-demo"] = timeline;
renderAt(0);
Promise.all(plates.map((plate) => new Promise((resolve) => {
  const frame = frameFor(plate);
  if (frame.contentDocument?.readyState === "complete") resolve();
  else frame.addEventListener("load", resolve, { once: true });
}))).then(() => {
  prepareFrames();
  renderAt(timelineTime);
});
