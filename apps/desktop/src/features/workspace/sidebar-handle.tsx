import { useRef } from "react"

import { cn } from "@workspace/shadcn/lib/utils"
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  sidebarKeyboardWidth,
} from "./use-sidebar"

export function SidebarHandle({
  collapsed,
  onResize,
  width,
}: {
  collapsed: boolean
  onResize: (width: number) => void
  width: number
}) {
  const drag = useRef<{ x: number; width: number } | null>(null)
  const shownWidth = collapsed ? 0 : width

  return (
    <div
      aria-label="Resize sidebar"
      aria-orientation="vertical"
      aria-valuemax={SIDEBAR_MAX_WIDTH}
      aria-valuemin={0}
      aria-valuenow={shownWidth}
      className={cn(
        "relative z-10 shrink-0 cursor-col-resize outline-none after:absolute after:inset-y-0 after:-left-1 after:w-2 focus-visible:bg-ring",
        collapsed ? "w-0" : "w-px bg-border",
      )}
      onDoubleClick={() => onResize(SIDEBAR_DEFAULT_WIDTH)}
      onKeyDown={(event) => {
        const nextWidth = sidebarKeyboardWidth(event.key, collapsed, width)
        if (nextWidth === null) return
        onResize(nextWidth)
        event.preventDefault()
      }}
      onLostPointerCapture={() => {
        drag.current = null
      }}
      onPointerDown={(event) => {
        event.preventDefault()
        event.currentTarget.setPointerCapture(event.pointerId)
        drag.current = { x: event.clientX, width: shownWidth }
      }}
      onPointerMove={(event) => {
        if (!drag.current) return
        onResize(drag.current.width + event.clientX - drag.current.x)
      }}
      role="separator"
      tabIndex={0}
    />
  )
}
