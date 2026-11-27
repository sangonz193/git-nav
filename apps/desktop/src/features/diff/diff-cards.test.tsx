import { describe, expect, test } from "bun:test"
import { DiffModeEnum } from "@git-diff-view/react"
import { renderToStaticMarkup } from "react-dom/server"

import { TooltipProvider } from "@workspace/shadcn/components/tooltip"
import { FileDiffCard } from "./diff-cards"
import type { DiffEntry } from "./diff-files"
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
          expanded
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

describe("FileDiffCard large diffs", () => {
  test("shows the notice over a retained diff until the file is expanded", () => {
    const file = {
      status: "modified",
      oldPath: "big.ts",
      newPath: "big.ts",
      oldOid: "a".repeat(40),
      newOid: "b".repeat(40),
      additions: 1200,
      deletions: 1,
      isBinary: false,
      splitRows: 2,
      unifiedRows: 2,
      hunkRows: 1,
    } satisfies ChangedFile
    const entry = {
      state: "loaded",
      data: {
        oldFile: { fileName: "big.ts", content: "one\n" },
        newFile: { fileName: "big.ts", content: "two\n" },
        hunks: ["--- a/big.ts\n+++ b/big.ts\n@@ -1 +1 @@\n-one\n+two\n"],
      },
    } satisfies DiffEntry
    const render = (expanded: boolean) =>
      renderToStaticMarkup(
        <TooltipProvider>
          <FileDiffCard
            allExpanded={false}
            collapsed={false}
            entry={entry}
            expanded={expanded}
            file={file}
            mode={DiffModeEnum.Split}
            onExpand={() => {}}
            onToggleAllExpanded={() => {}}
            onToggleCollapsed={() => {}}
            theme="light"
            wrap={false}
          />
        </TooltipProvider>,
      )

    expect(render(false)).toContain("Show diff")
    expect(render(false)).not.toContain("Expand all lines")
    expect(render(true)).not.toContain("Show diff")
    expect(render(true)).toContain("Expand all lines")
  })

  test.each([
    { state: "error", message: "Unable to read diff" },
    { state: "binary", oldBinary: null, newBinary: null },
  ] satisfies DiffEntry[])(
    "offers to show a file that grew large under a retained $state entry",
    (entry) => {
      const file = {
        status: "modified",
        oldPath: "big.ts",
        newPath: "big.ts",
        oldOid: "a".repeat(40),
        newOid: "b".repeat(40),
        additions: 1201,
        deletions: 0,
        isBinary: false,
        splitRows: 2,
        unifiedRows: 2,
        hunkRows: 1,
      } satisfies ChangedFile
      const markup = renderToStaticMarkup(
        <FileDiffCard
          allExpanded={false}
          collapsed={false}
          entry={entry}
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

      expect(markup).toContain("Show diff")
      expect(markup).not.toContain("Unable to read diff")
      expect(markup).not.toContain("Binary file changed")
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
