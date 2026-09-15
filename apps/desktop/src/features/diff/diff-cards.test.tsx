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
