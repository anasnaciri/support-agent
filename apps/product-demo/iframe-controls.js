const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));

export const streamedText = (text, amount) =>
  text.slice(0, Math.round(text.length * clamp(amount)));

export const findCustomerComposer = (documentRoot) =>
  documentRoot?.querySelector("textarea[placeholder*='drafted reply']") ?? null;

export const setControlledValue = (element, value) => {
  if (!element || element.value === value) return;
  const setter = Object.getOwnPropertyDescriptor(
    element.constructor.prototype,
    "value",
  )?.set;
  setter?.call(element, value);
  const frameWindow = element.ownerDocument.defaultView;
  element.dispatchEvent(
    new frameWindow.InputEvent("input", {
      bubbles: true,
      composed: true,
      inputType: "insertText",
      data: value.at(-1) ?? null,
    }),
  );
};
