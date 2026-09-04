import { isMacOS } from "./platform"

export type DockGroupGeometry = {
  id: string
  left: number
  location: "grid" | "floating" | "popout" | "edge"
  top: number
}

export function usesMacOSWindowChrome(desktop: boolean, userAgent: string) {
  return desktop && isMacOS(userAgent)
}

export function initialMacOSFullscreen(enabled: boolean, value: unknown) {
  return enabled && value === true
}

export function dockTitleBarGroups(
  root: { top: number },
  groups: DockGroupGeometry[]
) {
  const titleBarGroups = groups.filter(
    (group) => group.location === "grid" && Math.abs(group.top - root.top) <= 1
  )
  const trafficLightGroup = titleBarGroups.reduce<DockGroupGeometry | null>(
    (leftmost, group) =>
      !leftmost || group.left < leftmost.left ? group : leftmost,
    null
  )

  return {
    titleBarGroupIds: new Set(titleBarGroups.map((group) => group.id)),
    trafficLightGroupId: trafficLightGroup?.id ?? null,
  }
}
