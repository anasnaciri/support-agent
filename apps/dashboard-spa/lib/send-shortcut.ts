export interface SendShortcutEvent {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  preventDefault(): void;
}

export interface SendShortcutOptions {
  readonly isMacOS: boolean;
  readonly disabled: boolean;
  readonly send: () => void;
}

export const isMacOS = (platform: string, userAgent: string): boolean =>
  /^Mac/.test(platform) || /Macintosh|Mac OS X/.test(userAgent);

export const handleCurrentPlatformSendShortcut = (
  event: SendShortcutEvent,
  disabled: boolean,
  send: () => void,
): boolean =>
  handleSendShortcut(event, {
    isMacOS: isMacOS(navigator.platform, navigator.userAgent),
    disabled,
    send,
  });

export const handleSendShortcut = (
  event: SendShortcutEvent,
  options: SendShortcutOptions,
): boolean => {
  const correctModifier = options.isMacOS
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
  if (
    options.disabled ||
    event.key !== "Enter" ||
    !correctModifier ||
    event.altKey ||
    event.shiftKey
  ) {
    return false;
  }

  event.preventDefault();
  options.send();
  return true;
};
