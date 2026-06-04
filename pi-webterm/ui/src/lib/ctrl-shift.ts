export function getCtrlShiftLetterControlChar(
  event: Pick<
    KeyboardEvent,
    | "ctrlKey"
    | "shiftKey"
    | "altKey"
    | "metaKey"
    | "code"
    | "key"
    | "keyCode"
    | "which"
  >,
): string | null {
  if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey) {
    return null;
  }

  const codeMatch = event.code?.match(/^Key([A-Z])$/);
  const keyCode = event.keyCode || event.which || 0;
  const keyCodeLetter =
    keyCode >= 65 && keyCode <= 90 ? String.fromCharCode(keyCode) : null;

  const letter =
    codeMatch?.[1] ??
    keyCodeLetter ??
    (typeof event.key === "string" && event.key.length === 1
      ? event.key.toUpperCase()
      : null);

  if (!letter || letter < "A" || letter > "Z") {
    return null;
  }

  return String.fromCharCode(letter.charCodeAt(0) - 64);
}
