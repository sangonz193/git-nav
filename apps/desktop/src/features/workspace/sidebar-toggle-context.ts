import { createContext } from "react"

export const SidebarToggleContext = createContext<{
  collapsed: boolean
  toggle: () => void
} | null>(null)
