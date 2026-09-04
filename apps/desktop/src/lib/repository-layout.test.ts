import { describe, expect, test } from "bun:test"
import type { GroupviewPanelState } from "dockview-react"
import { readFileSync } from "node:fs"

import { closeRepositoryWindowAfterSaving, listenForRepositoryLayoutPageHide, repositoryLayoutRestoreController, repositoryLayoutSaveScheduler, REPOSITORY_LAYOUT_VERSION, restoreRepositoryLayout, unresolvablePanelIds, usableRepositoryLayout } from "./repository-layout"

const path = "/projects/git-nav"

function serializedPanel(id: string, contentComponent: "graph" | "diff", params: Record<string, unknown>): GroupviewPanelState {
  return { id, contentComponent, params }
}

function storedLayout(params: Record<string, unknown> = {}) {
  return {
    version: REPOSITORY_LAYOUT_VERSION,
    layout: {
      grid: { root: { type: "branch", data: [] }, height: 700, width: 900, orientation: "HORIZONTAL" },
      panels: {
        graph: serializedPanel("graph", "graph", { name: "git-nav", path, ...params }),
      },
    },
  }
}

describe("usableRepositoryLayout", () => {
  test("accepts a current layout for the same worktree", () => {
    expect(usableRepositoryLayout(storedLayout(), path)).not.toBeNull()
  })

  test("rejects the addPanel component key that dockview does not serialize", () => {
    const value = storedLayout()
    expect(usableRepositoryLayout({
      ...value,
      layout: { ...value.layout, panels: { graph: { id: "graph", component: "graph", params: { path } } } },
    }, path)).toBeNull()
  })

  test("rejects layouts from another version or worktree", () => {
    expect(usableRepositoryLayout({ ...storedLayout(), version: 2 }, path)).toBeNull()
    expect(usableRepositoryLayout(storedLayout({ path: "/moved/git-nav" }), path)).toBeNull()
  })

  test("rejects a grid root that Dockview cannot restore", () => {
    const value = storedLayout()
    expect(usableRepositoryLayout({
      ...value,
      layout: { ...value.layout, grid: { ...value.layout.grid, root: {} } },
    }, path)).toBeNull()
  })

  test("accepts a diff scoped to a sibling worktree", () => {
    const value = storedLayout()
    expect(usableRepositoryLayout({
      ...value,
      layout: {
        ...value.layout,
        panels: {
          ...value.layout.panels,
          diff: serializedPanel("diff", "diff", { baseRef: "HEAD", headRef: ":worktree", name: "git-nav", path: "/projects/git-nav-feature" }),
        },
      },
    }, path)).not.toBeNull()
  })

  test("identifies only panels with unresolvable persisted revisions", async () => {
    const value = storedLayout({ selectedCommitHashes: ["abc"] })
    const layout = usableRepositoryLayout({
      ...value,
      layout: {
        ...value.layout,
        panels: {
          ...value.layout.panels,
          diff: serializedPanel("diff", "diff", { baseRef: "main", headRef: "feature", mergeBase: true, name: "git-nav", path: "/projects/git-nav-feature" }),
        },
      },
    }, path)
    const revisions: [string, string][] = []
    expect(await unresolvablePanelIds(layout!, async (panelPath, revision) => {
      revisions.push([panelPath, revision])
      if (revision === "feature") {
        throw new Error("deleted")
      }
    })).toEqual(["diff"])
    expect(revisions).toEqual([
      ["/projects/git-nav-feature", "main"],
      ["/projects/git-nav-feature", "feature"],
    ])
  })

  test("keeps a graph panel when its persisted selection no longer resolves", async () => {
    const layout = usableRepositoryLayout(storedLayout({ selectedCommitHashes: ["deleted-a", "deleted-b"] }), path)
    let resolutions = 0

    expect(await unresolvablePanelIds(layout!, async () => {
      resolutions++
      throw new Error("deleted")
    })).toEqual([])
    expect(resolutions).toBe(0)
  })

  test("rejects an invalid persisted merge-base mode", () => {
    const value = storedLayout()
    expect(usableRepositoryLayout({
      ...value,
      layout: {
        ...value.layout,
        panels: {
          graph: serializedPanel("graph", "diff", { baseRef: "main", headRef: "feature", mergeBase: "yes", name: "git-nav", path }),
        },
      },
    }, path)).toBeNull()
  })

  test("validates all persisted preference fields", () => {
    expect(usableRepositoryLayout(storedLayout({ userPreferences: { columnWidths: { subject: 300 } } }), path)).not.toBeNull()
    expect(usableRepositoryLayout(storedLayout({ userPreferences: { columnWidths: { subject: -1 } } }), path)).toBeNull()
    expect(usableRepositoryLayout(storedLayout({ columnWidths: { subject: 300 } }), path)).toBeNull()

    const value = storedLayout()
    expect(usableRepositoryLayout({
      ...value,
      layout: {
        ...value.layout,
        panels: {
          diff: serializedPanel("diff", "diff", {
            baseLabel: "Base subject",
            baseRef: "a".repeat(40),
            headLabel: "Stash changes",
            headRef: "b".repeat(40),
            name: "git-nav",
            path,
            selectedFilePath: "src/index.ts",
            userPreferences: { fileTreeOpen: true, hideViewed: true, ignoreWhitespace: true, mode: "unified", wrap: true },
          }),
        },
      },
    }, path)).not.toBeNull()
    expect(usableRepositoryLayout({
      ...value,
      layout: {
        ...value.layout,
        panels: {
          diff: serializedPanel("diff", "diff", { baseRef: "main", headRef: "feature", name: "git-nav", path, userPreferences: { wrap: "yes" } }),
        },
      },
    }, path)).toBeNull()
    expect(usableRepositoryLayout({
      ...value,
      layout: {
        ...value.layout,
        panels: {
          diff: serializedPanel("diff", "diff", { baseRef: "main", headRef: "feature", mode: "split", name: "git-nav", path }),
        },
      },
    }, path)).toBeNull()
  })
})

function event<T>() {
  const listeners = new Set<(value: T) => void>()
  return {
    event(listener: (value: T) => void) {
      listeners.add(listener)
      return { dispose: () => listeners.delete(listener) }
    },
    fire(value: T) {
      listeners.forEach((listener) => listener(value))
    },
  }
}

describe("repositoryLayoutSaveScheduler", () => {
  test("flushes a pending save on dispose", async () => {
    let saves = 0
    const scheduler = repositoryLayoutSaveScheduler(async () => { saves++ }, () => undefined)

    scheduler.schedule()
    scheduler.dispose()
    scheduler.dispose()
    await scheduler.flush()

    expect(saves).toBe(1)
  })

  test("lets a window close await the pending save", async () => {
    let finishSave = () => undefined
    let saved = false
    const scheduler = repositoryLayoutSaveScheduler(
      () => new Promise<void>((resolve) => {
        finishSave = () => {
          saved = true
          resolve()
        }
      }),
      () => undefined,
    )

    scheduler.schedule()
    const closing = scheduler.flush()
    await Promise.resolve()
    expect(saved).toBe(false)

    finishSave()
    await closing
    expect(saved).toBe(true)
  })

  test("handles a failed save", async () => {
    const errors: unknown[] = []
    const scheduler = repositoryLayoutSaveScheduler(async () => { throw new Error("disk full") }, (error) => errors.push(error))

    scheduler.schedule()
    scheduler.dispose()
    await scheduler.flush()

    expect(errors).toHaveLength(1)
    expect(String(errors[0])).toContain("disk full")
  })

  test("does not flush a disposed dockview after it stops being current", async () => {
    let current = true
    let saves = 0
    const scheduler = repositoryLayoutSaveScheduler(async () => { saves++ }, () => undefined, () => current)

    scheduler.schedule()
    scheduler.dispose()
    current = false
    await scheduler.flush()

    expect(saves).toBe(0)
  })

  test("starts a keepalive save synchronously on pagehide", async () => {
    const keepalive: (boolean | undefined)[] = []
    const scheduler = repositoryLayoutSaveScheduler(async (value) => { keepalive.push(value) }, () => undefined)
    const target = new EventTarget()
    const unlisten = listenForRepositoryLayoutPageHide(target, scheduler.flushOnPageHide)

    scheduler.schedule()
    target.dispatchEvent(new Event("pagehide"))
    expect(keepalive).toEqual([true])
    await scheduler.flush()

    unlisten()
    scheduler.schedule()
    target.dispatchEvent(new Event("pagehide"))
    expect(keepalive).toEqual([true])
    scheduler.dispose()
    await scheduler.flush()
  })

  test("reissues an in-flight save with keepalive on pagehide", async () => {
    let finishSave = () => {}
    const keepalive: (boolean | undefined)[] = []
    const scheduler = repositoryLayoutSaveScheduler(
      (value) => {
        keepalive.push(value)
        return value
          ? Promise.resolve()
          : new Promise<void>((resolve) => { finishSave = resolve })
      },
      () => undefined,
    )

    scheduler.schedule()
    void scheduler.flush()
    await Promise.resolve()
    expect(keepalive).toEqual([undefined])

    scheduler.flushOnPageHide()
    expect(keepalive).toEqual([undefined, true])

    finishSave()
    await scheduler.flush()
  })

  test("saves parameter updates through Dockview's layout change event", async () => {
    const layoutChanges = event<void>()
    let saves = 0
    const scheduler = repositoryLayoutSaveScheduler(async () => { saves++ }, () => undefined)
    const restore = repositoryLayoutRestoreController(scheduler.schedule)
    const subscription = layoutChanges.event(restore.changed)
    const panel = { api: { updateParameters: () => layoutChanges.fire() } }

    restore.restored(() => undefined)
    await scheduler.flush()
    panel.api.updateParameters()
    scheduler.dispose()
    await scheduler.flush()

    expect(saves).toBe(2)
    subscription.dispose()
  })
})

describe("repository window close", () => {
  test("flushes a pending save before destroying the window", async () => {
    let finishSave = () => {}
    let prevented = false
    let destroyed = false
    const closing = closeRepositoryWindowAfterSaving(
      { preventDefault: () => { prevented = true } },
      () => new Promise<void>((resolve) => { finishSave = resolve }),
      async () => { destroyed = true },
    )

    await Promise.resolve()
    expect(prevented).toBe(true)
    expect(destroyed).toBe(false)

    finishSave()
    await closing
    expect(destroyed).toBe(true)
  })

  test("destroys the window when saving does not finish", async () => {
    let destroyed = false

    await closeRepositoryWindowAfterSaving(
      { preventDefault: () => undefined },
      () => new Promise<void>(() => undefined),
      async () => { destroyed = true },
      0,
    )

    expect(destroyed).toBe(true)
  })

  test("grants destroy permission to every window that can register the close handler", () => {
    const capability = JSON.parse(readFileSync(new URL("../../src-tauri/capabilities/default.json", import.meta.url), "utf8"))

    expect(capability.windows).toContain("main")
    expect(capability.windows).toContain("repository-*")
    expect(capability.permissions).toContain("core:window:allow-destroy")
  })
})

describe("repositoryLayoutRestoreController", () => {
  test("lets an early user action cancel restore while this and later changes keep saving", () => {
    let saves = 0
    const state = { layout: "user" }
    const restore = repositoryLayoutRestoreController(() => saves++)

    expect(restore.userAction()).toBe(true)
    restore.changed()

    expect(restore.restored(() => { state.layout = "stored" })).toBe(false)
    restore.changed()
    expect(state.layout).toBe("user")
    expect(saves).toBe(2)
  })

  test("never saves a fallback or later changes after a failed read", () => {
    let saves = 0
    let layout = ""
    const restore = repositoryLayoutRestoreController(() => saves++)

    expect(restore.failed(() => { layout = "fallback" })).toBe(true)
    restore.changed()

    expect(layout).toBe("fallback")
    expect(saves).toBe(0)
  })

  test("falls back without saving when applying a stored layout fails", () => {
    let saves = 0
    let fallback = false
    const restore = repositoryLayoutRestoreController(() => saves++)

    expect(() => restore.restored(() => { throw new Error("invalid layout") })).toThrow("invalid layout")
    expect(restore.failed(() => { fallback = true })).toBe(true)
    restore.changed()

    expect(fallback).toBe(true)
    expect(saves).toBe(0)
  })
})

function restorableContainer(ids: string[], activeId?: string) {
  let active = activeId
  const restoredPanels = ids.map((id) => ({
    id,
    api: { setActive: () => { active = id } },
  }))
  const panels: typeof restoredPanels = []
  return {
    panels,
    get activePanel() {
      return panels.find((panel) => panel.id === active)
    },
    fromJSON() {
      panels.push(...restoredPanels)
    },
    getPanel(id: string) {
      return panels.find((panel) => panel.id === id)
    },
    removePanel(panel: (typeof panels)[number]) {
      panels.splice(panels.indexOf(panel), 1)
      if (active === panel.id) {
        active = undefined
      }
    },
  }
}

describe("restoreRepositoryLayout", () => {
  test("keeps resolvable panels and activates a remaining panel after pruning", () => {
    const value = storedLayout()
    const container = restorableContainer(["graph", "diff", "other"], "diff")

    expect(restoreRepositoryLayout(container, usableRepositoryLayout(value, path)!, ["diff"])).toBe(true)
    expect(container.panels.map((panel) => panel.id)).toEqual(["graph", "other"])
    expect(container.activePanel?.id).toBe("graph")
  })

  test("reports when every restored panel was pruned", () => {
    const value = storedLayout()
    const container = restorableContainer(["graph", "diff"], "graph")

    expect(restoreRepositoryLayout(container, usableRepositoryLayout(value, path)!, ["graph", "diff"])).toBe(false)
    expect(container.panels).toEqual([])
  })
})
