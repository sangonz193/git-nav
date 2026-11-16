import { describe, expect, test } from "bun:test"

import { cleanupSections } from "./cleanup-sections"
import type { CleanupCandidate, CleanupReason } from "./use-branch-cleanup"

const candidate = (
  branch: string,
  reasons: CleanupReason[],
): CleanupCandidate => ({ branch, missingWorktrees: [], reasons })

describe("cleanupSections", () => {
  test("lists a branch matching several rules once, under the first section", () => {
    const sections = cleanupSections([
      candidate("both", ["squashMergedPullRequest", "mergedIntoDefaultBranch"]),
      candidate("merged", ["mergedIntoDefaultBranch"]),
      candidate("squashed", [
        "mergedIntoDefaultBranch",
        "squashedIntoDefaultBranch",
      ]),
    ])

    expect(
      sections.map(({ candidates, reason }) => [
        reason,
        candidates.map(({ branch }) => branch),
      ]),
    ).toEqual([
      ["squashMergedPullRequest", ["both"]],
      ["mergedIntoDefaultBranch", ["merged", "squashed"]],
    ])
  })
})
