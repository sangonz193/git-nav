import { describe, expect, test } from "bun:test"

import { workingTreeDraft } from "../features/working-tree/working-tree-state"
import { repositoryLayoutDrafts } from "./repository-layout-drafts"
import {
  closeRepositoryWindowAfterSaving,
  repositoryLayoutSaveScheduler,
} from "./repository-layout"

function draftLayout() {
  const drafts = repositoryLayoutDrafts()
  const draft = workingTreeDraft("restored message")
  const parameters = {
    message: draft.getSnapshot(),
    amend: true,
    amendHeadSha: "original-head",
    amendBranch: "feature",
    amendHeadMessage: "original message",
  }
  let writes = 0
  drafts.register(() => {
    if (parameters.message === draft.getSnapshot()) return
    parameters.message = draft.getSnapshot()
    writes++
  })
  draft.subscribe(drafts.changed)
  return { drafts, draft, parameters, writes: () => writes }
}

describe("repository layout drafts", () => {
  test.each(["switch", "unmount", "pagehide", "close"] as const)(
    "flushes focused typing before a %s snapshot without waiting for blur or a timer",
    async (reason) => {
      const { drafts, draft, parameters, writes } = draftLayout()
      const saved: (typeof parameters)[] = []
      const scheduler = repositoryLayoutSaveScheduler(
        () => parameters,
        async (snapshot) => {
          saved.push(snapshot)
        },
        () => undefined,
        drafts.flush,
      )
      drafts.subscribe(scheduler.schedule)
      let formUpdates = 0
      draft.subscribe(() => {
        formUpdates++
      })
      draft.setMessage("f")
      draft.setMessage("focused")
      draft.setMessage("focused draft")
      expect(formUpdates).toBe(3)
      expect(writes()).toBe(0)
      expect(parameters.message).toBe("restored message")

      if (reason === "unmount") scheduler.dispose()
      if (reason === "pagehide") scheduler.flushOnPageHide()
      if (reason === "close") {
        await closeRepositoryWindowAfterSaving(
          { preventDefault() {} },
          scheduler.flush,
          async () => {
            expect(saved[0]?.message).toBe("focused draft")
          },
        )
      }
      await scheduler.flush()
      expect(writes()).toBe(1)
      expect(saved).toEqual([
        {
          message: "focused draft",
          amend: true,
          amendHeadSha: "original-head",
          amendBranch: "feature",
          amendHeadMessage: "original message",
        },
      ])
      scheduler.dispose()
    },
  )

  test("captures a later draft on unmount while the switch-time save is still pending", async () => {
    const { drafts, draft, parameters } = draftLayout()
    const saved: string[] = []
    let finishSave = () => {}
    const scheduler = repositoryLayoutSaveScheduler(
      () => parameters,
      async (snapshot) => {
        saved.push(snapshot.message)
        if (saved.length === 1) {
          await new Promise<void>((resolve) => {
            finishSave = resolve
          })
        }
      },
      () => undefined,
      drafts.flush,
    )
    drafts.subscribe(scheduler.schedule)
    draft.setMessage("before switch")
    void scheduler.flush()
    await Promise.resolve()
    draft.setMessage("during handoff")
    scheduler.dispose()
    parameters.message = "panels disposed"
    finishSave()
    await scheduler.flush()
    expect(saved).toEqual(["before switch", "during handoff"])
  })

  test("unregisters disposed panels and supports StrictMode setup again", () => {
    const drafts = repositoryLayoutDrafts()
    let flushes = 0
    let changes = 0
    const flush = () => {
      flushes++
    }
    const changed = () => {
      changes++
    }
    const unregister = drafts.register(flush)
    const unsubscribe = drafts.subscribe(changed)
    drafts.flush()
    drafts.changed()
    unregister()
    unsubscribe()
    drafts.flush()
    drafts.changed()
    expect(flushes).toBe(1)
    expect(changes).toBe(1)
    drafts.register(flush)
    drafts.subscribe(changed)
    drafts.flush()
    drafts.changed()
    expect(flushes).toBe(2)
    expect(changes).toBe(2)
  })

  test("flushes every panel draft in the repository", () => {
    const drafts = repositoryLayoutDrafts()
    const flushed: string[] = []
    drafts.register(() => {
      flushed.push("first")
    })
    drafts.register(() => {
      flushed.push("second")
    })
    drafts.flush()
    expect(flushed).toEqual(["first", "second"])
  })
})
