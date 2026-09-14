import { describe, expect, test } from "bun:test"

import { DiffModeEnum } from "@git-diff-view/react"
import { IMAGE_BODY_HEIGHT, estimatedBodyHeight } from "./diff-files"
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
