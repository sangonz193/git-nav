import { isMacOS } from "../../lib/platform"

type ShortcutEvent = Pick<
  KeyboardEvent,
  "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey"
>

export type DesktopAppCommand =
  "new-window" | "choose-repository" | "zoom-in" | "zoom-out" | "actual-size"

export function usesNativeMenu(userAgent: string) {
  return isMacOS(userAgent)
}

// Closing a tab needs the window that owns the tabs, so it stays out of the commands the app runs
// for itself. On macOS the native menu owns the key and sends the window an event instead.
export function closesTab(event: ShortcutEvent, nativeMenu: boolean) {
  if (
    nativeMenu ||
    !event.ctrlKey ||
    event.altKey ||
    event.metaKey ||
    event.shiftKey
  ) {
    return false
  }
  return event.key.toLowerCase() === "w"
}

export function reopensTab(event: ShortcutEvent, nativeMenu: boolean) {
  if (
    nativeMenu ||
    !event.ctrlKey ||
    event.altKey ||
    event.metaKey ||
    !event.shiftKey
  ) {
    return false
  }
  return event.key.toLowerCase() === "t"
}

export function desktopAppShortcut(
  event: ShortcutEvent,
  nativeMenu: boolean,
): DesktopAppCommand | null {
  if (nativeMenu || !event.ctrlKey || event.altKey || event.metaKey) {
    return null
  }
  switch (event.key.toLowerCase()) {
    case "n":
      return event.shiftKey ? null : "new-window"
    case "o":
      return event.shiftKey ? null : "choose-repository"
    case "+":
    case "=":
      return "zoom-in"
    case "-":
      return event.shiftKey ? null : "zoom-out"
    case "0":
      return event.shiftKey ? null : "actual-size"
    default:
      return null
  }
}

export function repositoryShortcutIndex(
  event: ShortcutEvent & Pick<KeyboardEvent, "code">,
  nativeMenu: boolean,
  count: number,
) {
  const modifier =
    nativeMenu ?
      event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey
  if (!modifier || event.altKey) {
    return null
  }
  const digit =
    /^[1-9]$/.test(event.key) ? Number(event.key)
    : /^Digit[1-9]$/.test(event.code) ? Number(event.code.slice(-1))
    : null
  if (digit === null) return null
  const index = digit === 9 ? count - 1 : digit - 1
  return index >= 0 && index < count ? index : null
}

export function togglesSidebar(event: ShortcutEvent, nativeMenu: boolean) {
  const modifier =
    nativeMenu ?
      event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey
  return (
    modifier &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === "b"
  )
}
