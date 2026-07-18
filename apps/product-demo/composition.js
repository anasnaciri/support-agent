import { DEMO_DATA, SUPPORT_DEMO_STORY } from "./story.js";
import {
  cameraAt,
  cueProgress,
  dashboardPointToScreen,
  openingMessageAnimationTime,
  openingMessageKeyframes,
  openingMessageOptions,
  segments,
  visibleCursorCues,
} from "./choreography.js";

const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const progress = (time, start, end) => clamp((time - start) / (end - start));
const smooth = (value) => value * value * (3 - 2 * value);
const mix = (from, to, amount) => from + (to - from) * amount;
const plates = [...document.querySelectorAll("[data-plate]")];
const frameFor = (plate) => plate.querySelector("iframe");
const camera = document.querySelector("[data-camera]");
const cursor = document.querySelector("[data-cursor-shell]");
const cursorClick = document.querySelector("[data-cursor-click]");
const composerBeam = document.querySelector("[data-composer-beam]");
const timeJump = document.querySelector("[data-shot='time-jump']");
let openingMessageAnimation = null;
let openingMessageBubble = null;

const typeText = (text, amount) =>
  text.slice(0, Math.round(text.length * smooth(amount)));
const setNativeValue = (element, value) => {
  if (!element || element.value === value) return;
  const setter = Object.getOwnPropertyDescriptor(
    element.constructor.prototype,
    "value",
  )?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
};

const plateFor = (name) => document.querySelector(`[data-plate='${name}']`);
const findByText = (documentRoot, selector, text) =>
  [...(documentRoot?.querySelectorAll(selector) ?? [])].find(
    (element) => element.textContent?.trim() === text,
  );
const targetElementFor = (cue) => {
  const documentRoot = frameFor(plateFor(cue.plate))?.contentDocument;
  if (!documentRoot) return null;
  if (cue.target === "approve-bundle") {
    return findByText(documentRoot, "button", "Approve all");
  }
  if (cue.target === "partner-ticket") {
    return documentRoot.querySelector(
      "a[href*='/fulfillment-operator/tickets/demo-escalation']",
    );
  }
  if (cue.target === "partner-note") return documentRoot.querySelector("#note");
  if (cue.target === "partner-submit") {
    return findByText(documentRoot, "button", "Submit update");
  }
  if (cue.target === "customer-send") {
    return documentRoot.querySelector("button[aria-label='Approve and send']");
  }
  return null;
};

const cursorStateAt = (time, cameraFrame) => {
  const cue = visibleCursorCues.find(
    (candidate) => time >= candidate.start && time <= candidate.end,
  );
  if (!cue) return { x: 0, y: 0, opacity: 0, click: 0 };
  const target = targetElementFor(cue);
  if (!target) return { x: 0, y: 0, opacity: 0, click: 0 };
  const rect = target.getBoundingClientRect();
  const targetPoint = dashboardPointToScreen(
    { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
    cameraFrame,
  );
  const state = cueProgress(time, cue);
  return {
    x: mix(targetPoint.x + cue.fromOffset.x, targetPoint.x, state.movement),
    y: mix(targetPoint.y + cue.fromOffset.y, targetPoint.y, state.movement),
    opacity: state.opacity,
    click: state.click,
  };
};

const applyOpeningMessageRise = (time) => {
  const documentRoot = frameFor(plateFor("customer-message"))?.contentDocument;
  const message = [...(documentRoot?.querySelectorAll("p") ?? [])].find(
    (paragraph) => paragraph.textContent?.trim() === DEMO_DATA.customer.message,
  );
  const bubble = message?.closest(".flex.w-full.flex-col.gap-1");
  if (!bubble) return;
  if (openingMessageBubble !== bubble) {
    openingMessageAnimation?.cancel();
    openingMessageBubble = bubble;
    openingMessageAnimation = bubble.animate(
      openingMessageKeyframes,
      openingMessageOptions,
    );
    openingMessageAnimation.pause();
  }
  openingMessageAnimation.currentTime = openingMessageAnimationTime(time);
};

const editLiveFrames = (time) => {
  const partner = frameFor(
    document.querySelector("[data-plate='fulfillment-resolution']"),
  )?.contentDocument;
  setNativeValue(
    partner?.querySelector("#note"),
    typeText("Item reshipped.", progress(time, 22, 24)),
  );
  setNativeValue(
    partner?.querySelector("input[aria-label='New tracking number']"),
    typeText(DEMO_DATA.order.reshipmentTracking.number, progress(time, 24, 26)),
  );

  const merchant = frameFor(
    document.querySelector("[data-plate='customer-update']"),
  )?.contentDocument;
  setNativeValue(
    merchant?.querySelector("textarea"),
    typeText(DEMO_DATA.drafts.customerUpdate, progress(time, 29, 33.5)),
  );
};

export const renderAt = (rawTime) => {
  const time = clamp(
    Number(rawTime) || 0,
    0,
    SUPPORT_DEMO_STORY.duration - 0.001,
  );
  const segmentIndex = segments.findIndex(
    ({ start, end }) => time >= start && time < end,
  );
  const segment = segments[Math.max(0, segmentIndex)];
  const fade =
    segmentIndex > 0
      ? smooth(progress(time, segment.start, segment.start + 0.42))
      : 1;
  plates.forEach((plate) => {
    const current = plate.dataset.plate === segment.plate;
    const previous =
      segmentIndex > 0 &&
      plate.dataset.plate === segments[segmentIndex - 1].plate;
    plate.style.opacity = String(current ? fade : previous ? 1 - fade : 0);
    plate.style.zIndex = String(current ? 2 : previous ? 1 : 0);
  });

  const cameraFrame = cameraAt(time);
  camera.style.transform = `translate3d(${cameraFrame.x}px, ${cameraFrame.y}px, 0) scale(${cameraFrame.scale})`;
  const cursorFrame = cursorStateAt(time, cameraFrame);
  cursor.style.opacity = String(cursorFrame.opacity);
  cursor.style.transform = `translate3d(${cursorFrame.x - 2}px, ${cursorFrame.y - 2}px, 0) scale(${mix(1, 0.94, cursorFrame.click)})`;
  const click = cursorFrame.click;
  cursorClick.style.opacity = String(click);
  cursorClick.style.transform = `scale(${mix(0.5, 1.6, 1 - click)})`;

  const beam = progress(time, 28.4, 29) * (1 - progress(time, 33.8, 34.4));
  composerBeam.style.opacity = String(smooth(beam));
  composerBeam.style.setProperty("--beam-x", `${(time * 70) % 220}%`);
  const jump =
    smooth(progress(time, 37, 37.6)) * (1 - smooth(progress(time, 38.4, 39)));
  timeJump.style.opacity = String(jump);
  applyOpeningMessageRise(time);
  editLiveFrames(time);
};

const prepareFrames = () => {
  const partner = frameFor(
    document.querySelector("[data-plate='fulfillment-resolution']"),
  )?.contentDocument;
  partner?.querySelector("button[aria-label='Show order context']")?.click();
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      partner
        ?.querySelector("button[aria-label='Change tracking number']")
        ?.click();
      renderAt(timelineTime);
    }),
  );
};

window.addEventListener("hf-seek", (event) =>
  renderAt(event.detail?.time ?? 0),
);
window.__supportDemoSeek = renderAt;
let timelineTime = 0;
const timeline = {
  duration: () => SUPPORT_DEMO_STORY.duration,
  time: () => timelineTime,
  seek: (time) => {
    timelineTime = clamp(Number(time) || 0, 0, SUPPORT_DEMO_STORY.duration);
    renderAt(timelineTime);
    return timeline;
  },
  play: () => timeline,
  pause: () => timeline,
};
window.__timelines = window.__timelines || {};
window.__timelines["support-resolution-demo"] = timeline;
renderAt(0);
Promise.all(
  plates.map(
    (plate) =>
      new Promise((resolve) => {
        const frame = frameFor(plate);
        if (frame.contentDocument?.readyState === "complete") resolve();
        else frame.addEventListener("load", resolve, { once: true });
      }),
  ),
).then(() => {
  prepareFrames();
  renderAt(timelineTime);
});
