import { getCurrentWindow } from "@tauri-apps/api/window"
import { useEffect } from "react"

import { closesTab, usesNativeMenu } from "../features/app-menu/app-menu-shortcuts"
import { isDesktop } from "./ipc"

export const CLOSE_TAB_EVENT = "close-tab"

export function useCloseTab(closeTab: () => void) {
  useEffect(() => {
    if (!isDesktop) return

    const nativeMenu = usesNativeMenu(navigator.userAgent)
    let disposed = false
    let unlisten: (() => void) | undefined

    void getCurrentWindow()
      .listen(CLOSE_TAB_EVENT, () => closeTab())
      .then((dispose) => {
        if (disposed) dispose()
        else unlisten = dispose
      })
      .catch(() => undefined)

    const onKeyDown = (event: KeyboardEvent) => {
      if (!closesTab(event, nativeMenu)) return
      event.preventDefault()
      closeTab()
    }
    window.addEventListener("keydown", onKeyDown)

    return () => {
      disposed = true
      unlisten?.()
      window.removeEventListener("keydown", onKeyDown)
    }
  }, [closeTab])
}
