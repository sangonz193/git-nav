import { describe, expect, test } from "bun:test"

import { closedTabHistory, reopenedPanel } from "./closed-tabs"

type FakeGroup = { id: string, panels: FakePanel[] }
type FakePanel = { id: string, group: FakeGroup, toJSON(): { id: string, contentComponent?: string, tabComponent?: string, title?: string, params?: Record<string, unknown> } }

function group(id: string, panelIds: string[]) {
  const value: FakeGroup = { id, panels: [] }
  value.panels = panelIds.map((panelId) => ({
    id: panelId,
    group: value,
    toJSON: () => ({ id: panelId, contentComponent: "diff", tabComponent: "diff", title: panelId, params: { path: "/repo" } }),
  }))
  return value
}

function close(history: ReturnType<typeof closedTabHistory>, panels: FakePanel[], panel: FakePanel, kind = "remove") {
  history.beginMutation(kind, panels)
  history.closePanel(panel)
  history.endMutation()
}

describe("closed tabs", () => {
  test("remembers where a closed tab was", () => {
    const first = group("group-1", ["a", "b", "c"])
    const history = closedTabHistory()
    close(history, first.panels, first.panels[1])

    expect(history.size).toBe(1)
    const tab = history.reopenPanel()
    expect(tab).toMatchObject({ id: "b", groupId: "group-1", index: 1 })
    expect(history.size).toBe(0)
    expect(history.reopenPanel()).toBeUndefined()
  })

  test("reopens the most recently closed tab first", () => {
    const first = group("group-1", ["a", "b"])
    const history = closedTabHistory()
    close(history, first.panels, first.panels[0])
    close(history, first.panels, first.panels[1])

    expect(history.reopenPanel()?.id).toBe("b")
    expect(history.reopenPanel()?.id).toBe("a")
  })

  test("ignores a removal that only moves a tab", () => {
    const first = group("group-1", ["a"])
    const history = closedTabHistory()
    close(history, first.panels, first.panels[0], "move")
    expect(history.size).toBe(0)

    history.closePanel(first.panels[0])
    expect(history.size).toBe(0)
  })

  test("forgets the oldest tab past the limit", () => {
    const first = group("group-1", ["a", "b", "c"])
    const history = closedTabHistory(2)
    for (const panel of first.panels) close(history, first.panels, panel)

    expect(history.size).toBe(2)
    expect(history.reopenPanel()?.id).toBe("c")
    expect(history.reopenPanel()?.id).toBe("b")
  })

  test("forgets tabs a restore dropped", () => {
    const first = group("group-1", ["a"])
    const history = closedTabHistory()
    close(history, first.panels, first.panels[0])
    history.clear()

    expect(history.size).toBe(0)
    expect(history.reopenPanel()).toBeUndefined()
  })

  test("reopens into the group a tab was closed from", () => {
    const first = group("group-1", ["a", "b"])
    const history = closedTabHistory()
    close(history, first.panels, first.panels[1])
    const tab = history.reopenPanel()!

    expect(reopenedPanel(tab, () => true)).toEqual({
      component: "diff",
      id: "b",
      params: { path: "/repo" },
      position: { direction: "within", index: 1, referenceGroup: "group-1" },
      tabComponent: "diff",
      title: "b",
    })
  })

  test("reopens without a position once the group is gone", () => {
    const first = group("group-1", ["a"])
    const history = closedTabHistory()
    close(history, first.panels, first.panels[0])
    const tab = history.reopenPanel()!

    expect(reopenedPanel(tab, () => false)).not.toHaveProperty("position")
  })

  test("skips a tab that named no component to render", () => {
    const first = group("group-1", ["a"])
    first.panels[0].toJSON = () => ({ id: "a" })
    const history = closedTabHistory()
    close(history, first.panels, first.panels[0])

    expect(reopenedPanel(history.reopenPanel()!, () => true)).toBeNull()
  })
})
