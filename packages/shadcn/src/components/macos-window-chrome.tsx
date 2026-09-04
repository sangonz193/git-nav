import { createContext, useContext, type ReactNode } from "react"

const MacOSWindowChromeContext = createContext(false)

export function MacOSWindowChromeProvider({
  children,
  enabled,
}: {
  children: ReactNode
  enabled: boolean
}) {
  return (
    <MacOSWindowChromeContext.Provider value={enabled}>
      {children}
    </MacOSWindowChromeContext.Provider>
  )
}

export function MacOSWindowDragRegion() {
  const enabled = useContext(MacOSWindowChromeContext)

  if (!enabled) return null

  return (
    // Radix modal layers disable body pointer events, so this region must opt back in.
    <div
      aria-hidden="true"
      className="pointer-events-auto fixed inset-x-0 top-0 z-50 h-[var(--dv-tabs-and-actions-container-height)]"
      data-tauri-drag-region
    />
  )
}
