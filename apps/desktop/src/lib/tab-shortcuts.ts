import { getCurrentWindow } from "@tauri-apps/api/window"
import { useEffect } from "react"

import { closesTab, reopensTab, usesNativeMenu } from "../features/app-menu/app-menu-shortcuts"
import { isDesktop } from "./ipc"

export const CLOSE_TAB_EVENT = "close-tab"
export const REOPEN_TAB_EVENT = "reopen-tab"

export function useTabShortcuts({ closeTab, reopenTab }: { closeTab: () => void, reopenTab?: () => void }) {
  useEffect(() => {
    if (!isDesktop) return

    const nativeMenu = usesNativeMenu(navigator.userAgent)
    const currentWindow = getCurrentWindow()
    const unlisteners: (() => void)[] = []
    let disposed = false

    const listenFor = (event: string, handler: (() => void) | undefined) => {
      if (!handler) return
      void currentWindow
        .listen(event, () => handler())
        .then((dispose) => {
          if (disposed) dispose()
          else unlisteners.push(dispose)
        })
        .catch(() => undefined)
    }
    listenFor(CLOSE_TAB_EVENT, closeTab)
    listenFor(REOPEN_TAB_EVENT, reopenTab)

    const onKeyDown = (event: KeyboardEvent) => {
      const handler = closesTab(event, nativeMenu)
        ? closeTab
        : reopensTab(event, nativeMenu)
          ? reopenTab
          : undefined
      if (!handler) return
      event.preventDefault()
      handler()
    }
    window.addEventListener("keydown", onKeyDown)

    return () => {
      disposed = true
      for (const unlisten of unlisteners) unlisten()
      window.removeEventListener("keydown", onKeyDown)
    }
  }, [closeTab, reopenTab])
}
