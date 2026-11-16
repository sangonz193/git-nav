import type { CleanupCandidate, CleanupReason } from "./use-branch-cleanup"

const sections: { label: string; reason: CleanupReason }[] = [
  { label: "Squash-merged pull requests", reason: "squashMergedPullRequest" },
  {
    label: "Merged into the default branch",
    reason: "mergedIntoDefaultBranch",
  },
  {
    label: "Squashed into the default branch",
    reason: "squashedIntoDefaultBranch",
  },
]

// A branch can match several rules but is deleted once, so it is listed under the first one it matches.
export function cleanupSections(candidates: CleanupCandidate[]) {
  return sections
    .map(({ label, reason }) => ({
      label,
      reason,
      candidates: candidates.filter(
        (candidate) =>
          sections.find((section) => candidate.reasons.includes(section.reason))
            ?.reason === reason,
      ),
    }))
    .filter((section) => section.candidates.length > 0)
}
