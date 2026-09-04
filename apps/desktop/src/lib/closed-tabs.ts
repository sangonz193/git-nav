import type { GroupviewPanelState } from "dockview-react"

type PanelPosition = { groupId: string, index: number }
type ClosedTab = PanelPosition & { id: string, state: GroupviewPanelState }
type ClosedPanel = { id: string, group: { id: string, panels: readonly { id: string }[] }, toJSON(): GroupviewPanelState }

const CLOSED_TAB_LIMIT = 10

// Dockview removes a panel to move it as much as to close it, and the mutation the removal sits under is
// what tells the two apart: a drag brackets its removal in a move, so a position is only taken while a
// remove is the outermost mutation.
export function closedTabHistory(limit = CLOSED_TAB_LIMIT) {
  let positions: Map<string, PanelPosition> | undefined
  const closed: ClosedTab[] = []
  return {
    beginMutation(kind: string, panels: readonly ClosedPanel[]) {
      positions = kind === "remove"
        ? new Map(panels.map((panel) => [panel.id, { groupId: panel.group.id, index: panel.group.panels.findIndex((sibling) => sibling.id === panel.id) }]))
        : undefined
    },
    endMutation() {
      positions = undefined
    },
    closePanel(panel: ClosedPanel) {
      const position = positions?.get(panel.id)
      if (!position) {
        return
      }
      closed.push({ ...position, id: panel.id, state: panel.toJSON() })
      if (closed.length > limit) {
        closed.shift()
      }
    },
    reopenPanel() {
      return closed.pop()
    },
    clear() {
      closed.length = 0
    },
    get size() {
      return closed.length
    },
  }
}

// The group a tab was closed from is gone once it held nothing else, and a tab that outlives its group
// opens wherever the next one would have.
export function reopenedPanel(tab: ClosedTab, hasGroup: (groupId: string) => boolean) {
  const { contentComponent, params, tabComponent, title } = tab.state
  if (!contentComponent) {
    return null
  }
  return {
    component: contentComponent,
    id: tab.id,
    params,
    tabComponent,
    title,
    ...(hasGroup(tab.groupId) ? { position: { direction: "within" as const, index: tab.index, referenceGroup: tab.groupId } } : {}),
  }
}
