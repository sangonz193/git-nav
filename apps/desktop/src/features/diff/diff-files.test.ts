import { afterAll, beforeAll, describe, expect, test } from "bun:test"

import { DiffModeEnum } from "@git-diff-view/react"
import { Window } from "happy-dom"
import {
  IMAGE_BODY_HEIGHT,
  estimatedBodyHeight,
  mirrorSplitScroll,
  preparedDiffFile,
  withListedEntries,
  withLoadedEntry,
  type DiffEntry,
} from "./diff-files"
import type { ChangedFile } from "./diff-panel-state"

const file = (overrides: Partial<ChangedFile> = {}): ChangedFile => ({
  status: "modified",
  oldPath: "src/index.ts",
  newPath: "src/index.ts",
  oldOid: "a".repeat(40),
  newOid: "b".repeat(40),
  additions: 1,
  deletions: 1,
  isBinary: false,
  splitRows: 2,
  unifiedRows: 2,
  hunkRows: 1,
  ...overrides,
})

describe("estimatedBodyHeight", () => {
  test("includes the SVG preview height when either side of a rename is SVG", () => {
    for (const mode of [DiffModeEnum.Split, DiffModeEnum.Unified]) {
      const textHeight = estimatedBodyHeight(file(), mode)
      for (const [oldPath, newPath] of [
        ["before.svg", "after.txt"],
        ["before.txt", "after.svg"],
      ]) {
        expect(
          estimatedBodyHeight(
            file({ status: "renamed", oldPath, newPath }),
            mode,
          ),
        ).toBe(textHeight + IMAGE_BODY_HEIGHT)
      }
    }
  })

  test("uses the fixed preview height for every binary image state", () => {
    expect(IMAGE_BODY_HEIGHT).toBe(386)
    expect(
      estimatedBodyHeight(
        file({ isBinary: true, newPath: "images/icon.png" }),
        DiffModeEnum.Split,
      ),
    ).toBe(IMAGE_BODY_HEIGHT)
    expect(
      estimatedBodyHeight(
        file({ isBinary: true, newPath: "images/photo.png" }),
        DiffModeEnum.Unified,
      ),
    ).toBe(IMAGE_BODY_HEIGHT)
    expect(
      estimatedBodyHeight(
        file({
          isBinary: true,
          oldPath: "images/before.png",
          newPath: "images/after.bin",
        }),
        DiffModeEnum.Split,
      ),
    ).toBe(IMAGE_BODY_HEIGHT)
  })
})

describe("mirrorSplitScroll", () => {
  const window = new Window()
  const globals = globalThis as { Element?: unknown }
  const previousElement = globals.Element
  beforeAll(() => {
    globals.Element = window.Element
  })
  afterAll(() => {
    globals.Element = previousElement
  })

  function splitView() {
    const view = window.document.createElement("div")
    const [left, right] = [0, 1].map(() => {
      const side = window.document.createElement("div")
      side.className = "diff-table-scroll-container"
      view.append(side)
      return side
    })
    let stopped = 0
    const scroll = (target: unknown) =>
      mirrorSplitScroll({
        target,
        stopPropagation: () => {
          stopped += 1
        },
      } as unknown as Event)
    return { left, right, scroll, stopped: () => stopped }
  }

  test("drops the echo of its own mirroring while the scrolled side moves on", () => {
    const { left, right, scroll } = splitView()
    left.scrollLeft = 100
    scroll(left)
    expect(right.scrollLeft).toBe(100)

    left.scrollLeft = 120
    scroll(right)
    expect(left.scrollLeft).toBe(120)

    scroll(left)
    expect(right.scrollLeft).toBe(120)
  })

  test("mirrors a scroll that starts on the other side once its echo has passed", () => {
    const { left, right, scroll } = splitView()
    left.scrollLeft = 40
    scroll(left)
    scroll(right)

    right.scrollLeft = 10
    scroll(right)
    expect(left.scrollLeft).toBe(10)
  })

  test("keeps the event from the diff view's own mirroring", () => {
    const { left, scroll, stopped } = splitView()
    scroll(left)
    scroll(window.document.createElement("div"))
    expect(stopped()).toBe(1)
  })
})

describe("preparedDiffFile", () => {
  test("has its rows built before the view first renders it", () => {
    const diffFile = preparedDiffFile(
      {
        oldFile: { fileName: "a.ts", content: "one\ntwo\n" },
        newFile: { fileName: "a.ts", content: "one\nthree\n" },
        hunks: [
          "--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n one\n-two\n+three\n",
        ],
      },
      "dark",
    )
    expect(diffFile.splitLineLength).toBeGreaterThan(0)
    expect(diffFile.unifiedLineLength).toBeGreaterThan(0)
  })
})

const diff = (content: string): DiffEntry => ({
  state: "loaded",
  data: {
    oldFile: { fileName: "a.ts", content: "" },
    newFile: { fileName: "a.ts", content },
    hunks: [content],
  },
})

const loader = () => () => Promise.reject(new Error("unused"))

describe("withLoadedEntry", () => {
  test("keeps what is shown when the list is read again and the diff reads the same", () => {
    const scope = {}
    const load = loader()
    const loaded = {
      scope,
      entries: { a: diff("one"), b: diff("two") },
      readers: { a: load, b: load },
    }
    expect(withLoadedEntry(loaded, scope, "a", diff("one"), load)).toBe(loaded)

    const changed = withLoadedEntry(loaded, scope, "a", diff("three"), load)
    expect(changed.entries.a).toEqual(diff("three"))
    expect(changed.entries.b).toBe(loaded.entries.b)
  })

  test("records a new reader without replacing a diff that reads the same", () => {
    const scope = {}
    const previous = loader()
    const next = loader()
    const loaded = {
      scope,
      entries: { a: diff("one"), b: diff("two") },
      readers: { a: previous, b: previous },
    }
    const reread = withLoadedEntry(loaded, scope, "a", diff("one"), next)
    expect(reread.entries).toBe(loaded.entries)
    expect(reread.readers).toEqual({ a: next, b: previous })
  })

  test("starts over for a different list", () => {
    const load = loader()
    const loaded = {
      scope: {},
      entries: { a: diff("one"), b: diff("two") },
      readers: { a: load, b: load },
    }
    const next = {}
    expect(withLoadedEntry(loaded, next, "a", diff("one"), load)).toEqual({
      scope: next,
      entries: { a: diff("one") },
      readers: { a: load },
    })
  })
})

describe("withListedEntries", () => {
  const load = loader()
  const loaded = {
    scope: {},
    entries: { a: diff("one"), b: diff("two") },
    readers: { a: load, b: load },
  }

  test("drops the diffs of files that left the list", () => {
    expect(withListedEntries(loaded, new Set(["b", "c"]))).toEqual({
      scope: loaded.scope,
      entries: { b: loaded.entries.b },
      readers: { b: load },
    })
  })

  test("keeps what is shown while every file is still listed", () => {
    expect(withListedEntries(loaded, new Set(["a", "b", "c"]))).toBe(loaded)
  })
})
