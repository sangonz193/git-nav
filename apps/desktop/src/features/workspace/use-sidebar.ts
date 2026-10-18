import { useCallback, useEffect, useState } from "react"

import { isDesktop } from "@/lib/ipc"
import { togglesSidebar, usesNativeMenu } from "../app-menu/app-menu-shortcuts"

const SIDEBAR_WIDTH_KEY = "git-nav.workspace.sidebar-width"
const SIDEBAR_COLLAPSED_KEY = "git-nav.workspace.sidebar-collapsed"
export const SIDEBAR_DEFAULT_WIDTH = 240
export const SIDEBAR_MIN_WIDTH = 180
export const SIDEBAR_MAX_WIDTH = 480
const KEYBOARD_STEP = 16

export function clampSidebarWidth(width: number) {
  return Math.min(Math.max(width, SIDEBAR_MIN_WIDTH), SIDEBAR_MAX_WIDTH)
}

export function sidebarKeyboardWidth(
  key: string,
  collapsed: boolean,
  width: number,
) {
  if (key === "ArrowRight") {
    return collapsed ? SIDEBAR_MIN_WIDTH : width + KEYBOARD_STEP
  }
  if (key === "ArrowLeft" && !collapsed) {
    return Math.max(width - KEYBOARD_STEP, SIDEBAR_MIN_WIDTH)
  }
  return null
}

function readStored(key: string) {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStored(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Storage can be blocked while the sidebar remains usable for this session.
  }
}

function storedWidth() {
  const stored = Number(readStored(SIDEBAR_WIDTH_KEY))
  return Number.isFinite(stored) && stored > 0 ?
      clampSidebarWidth(stored)
    : SIDEBAR_DEFAULT_WIDTH
}

export function useSidebar() {
  const [width, setWidth] = useState(storedWidth)
  const [collapsed, setCollapsed] = useState(
    () => readStored(SIDEBAR_COLLAPSED_KEY) === "true",
  )
  const toggle = useCallback(() => setCollapsed((current) => !current), [])
  const resize = useCallback((proposed: number) => {
    const folds = proposed < SIDEBAR_MIN_WIDTH / 2
    setCollapsed(folds)
    if (!folds) setWidth(clampSidebarWidth(proposed))
  }, [])

  useEffect(() => {
    writeStored(SIDEBAR_WIDTH_KEY, String(width))
  }, [width])

  useEffect(() => {
    writeStored(SIDEBAR_COLLAPSED_KEY, String(collapsed))
  }, [collapsed])

  useEffect(() => {
    if (!isDesktop) return
    const nativeMenu = usesNativeMenu(navigator.userAgent)
    const onKeyDown = (event: KeyboardEvent) => {
      if (!togglesSidebar(event, nativeMenu)) return
      event.preventDefault()
      toggle()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [toggle])

  return { collapsed, resize, toggle, width }
}
