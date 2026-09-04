import { getCurrentWindow } from "@tauri-apps/api/window"
import { useEffect, useState } from "react"

import { isDesktop } from "./ipc"
import {
  initialMacOSFullscreen,
  usesMacOSWindowChrome,
} from "./macos-window-chrome"

export function useMacOSWindowChrome() {
  const enabled =
    typeof navigator !== "undefined" &&
    usesMacOSWindowChrome(isDesktop, navigator.userAgent)
  const [fullscreen, setFullscreen] = useState(
    initialMacOSFullscreen(
      enabled,
      typeof window === "undefined"
        ? undefined
        : (window as Window & { __GIT_NAV_INITIAL_FULLSCREEN__?: boolean })
            .__GIT_NAV_INITIAL_FULLSCREEN__
    )
  )

  useEffect(() => {
    if (!enabled) return

    const currentWindow = getCurrentWindow()
    let disposed = false
    let request = 0
    let resizeTimeout: ReturnType<typeof globalThis.setTimeout> | undefined
    let unlisten: (() => void) | undefined

    const updateFullscreen = () => {
      const currentRequest = ++request
      void currentWindow
        .isFullscreen()
        .then((value) => {
          if (!disposed && currentRequest === request) setFullscreen(value)
        })
        .catch(() => undefined)
    }

    updateFullscreen()
    void currentWindow
      .onResized(() => {
        request += 1
        globalThis.clearTimeout(resizeTimeout)
        resizeTimeout = globalThis.setTimeout(() => {
          resizeTimeout = undefined
          updateFullscreen()
        }, 100)
      })
      .then((dispose) => {
        if (disposed) dispose()
        else unlisten = dispose
      })
      .catch(() => undefined)

    return () => {
      disposed = true
      globalThis.clearTimeout(resizeTimeout)
      unlisten?.()
    }
  }, [enabled])

  return enabled && !fullscreen
}
