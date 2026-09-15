import { describe, expect, test } from "bun:test"
import { DiffModeEnum } from "@git-diff-view/react"
import { renderToStaticMarkup } from "react-dom/server"

import { FileDiffCard } from "./diff-cards"
import type { ChangedFile } from "./diff-panel-state"

describe("FileDiffCard load errors", () => {
  test.each([
    { path: "image.png", isBinary: false, additions: 1, preview: false },
    { path: "image.png", isBinary: true, additions: 0, preview: true },
    { path: "image.svg", isBinary: false, additions: 1, preview: true },
    { path: "image.svg", isBinary: false, additions: 1201, preview: false },
  ])(
    "matches preview geometry for $path (binary: $isBinary, additions: $additions)",
    ({ path, isBinary, additions, preview }) => {
      const file = {
        status: "modified",
        oldPath: path,
        newPath: path,
        oldOid: "a".repeat(40),
        newOid: "b".repeat(40),
        additions,
        deletions: 1,
        isBinary,
        splitRows: 2,
        unifiedRows: 2,
        hunkRows: 1,
      } satisfies ChangedFile
      const markup = renderToStaticMarkup(
        <FileDiffCard
          allExpanded={false}
          collapsed={false}
          entry={{ state: "error", message: "Unable to read diff" }}
          expanded={false}
          file={file}
          mode={DiffModeEnum.Split}
          onExpand={() => {}}
          onToggleAllExpanded={() => {}}
          onToggleCollapsed={() => {}}
          theme="light"
          wrap={false}
        />,
      )

      expect(markup).toContain("Unable to read diff")
      expect(markup.includes('class="diff-binary-preview"')).toBe(preview)
    },
  )
})

describe("FileDiffCard loading images", () => {
  test.each([
    { oldPath: "image.png", newPath: "image.png", isBinary: true, sides: 2 },
    { oldPath: null, newPath: "image.png", isBinary: true, sides: 1 },
    { oldPath: "blob.bin", newPath: "blob.bin", isBinary: true, sides: 0 },
    { oldPath: "image.svg", newPath: "image.svg", isBinary: false, sides: 0 },
  ])(
    "paints the frame for $oldPath → $newPath while the diff loads",
    ({ oldPath, newPath, isBinary, sides }) => {
      const file = {
        status: oldPath ? "modified" : "added",
        oldPath,
        newPath,
        oldOid: oldPath && "a".repeat(40),
        newOid: "b".repeat(40),
        additions: 0,
        deletions: 0,
        isBinary,
        splitRows: 0,
        unifiedRows: 0,
        hunkRows: 0,
      } satisfies ChangedFile
      const markup = renderToStaticMarkup(
        <FileDiffCard
          allExpanded={false}
          collapsed={false}
          entry={undefined}
          expanded={false}
          file={file}
          mode={DiffModeEnum.Split}
          onExpand={() => {}}
          onToggleAllExpanded={() => {}}
          onToggleCollapsed={() => {}}
          theme="light"
          wrap={false}
        />,
      )

      expect(markup.split('class="diff-binary-image"').length - 1).toBe(sides)
    },
  )
})
