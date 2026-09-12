export type TabCloseScope = "others" | "left" | "right" | "all"

export function tabsToClose<T extends { id: string }>(
  panels: readonly T[],
  panelId: string,
  scope: TabCloseScope,
) {
  const index = panels.findIndex((panel) => panel.id === panelId)
  switch (scope) {
    case "others":
      return panels.filter((panel) => panel.id !== panelId)
    case "left":
      return panels.slice(0, Math.max(index, 0))
    case "right":
      return index < 0 ? [] : panels.slice(index + 1)
    case "all":
      return [...panels]
  }
}
