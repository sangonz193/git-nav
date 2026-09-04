import { isMacOS } from "../../lib/platform"

type ShortcutEvent = Pick<
  KeyboardEvent,
  "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey"
>

export type DesktopAppCommand =
  "show-launcher" | "choose-repository" | "zoom-in" | "zoom-out" | "actual-size"

export function usesNativeMenu(userAgent: string) {
  return isMacOS(userAgent)
}

export function desktopAppShortcut(
  event: ShortcutEvent,
  nativeMenu: boolean
): DesktopAppCommand | null {
  if (nativeMenu || !event.ctrlKey || event.altKey || event.metaKey) {
    return null
  }
  switch (event.key.toLowerCase()) {
    case "n":
      return event.shiftKey ? null : "show-launcher"
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
