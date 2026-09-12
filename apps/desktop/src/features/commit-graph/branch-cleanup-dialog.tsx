import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@workspace/shadcn/components/alert-dialog"
import { Button } from "@workspace/shadcn/components/button"

import type { CleanOptions, ViewConfigChange } from "./commit-graph-view"
import type { CleanupReason, useBranchCleanup } from "./use-branch-cleanup"

export function BranchCleanupDialog({
  cleanOptions,
  cleanup,
  updateConfig,
}: {
  cleanOptions: CleanOptions
  cleanup: ReturnType<typeof useBranchCleanup>
  updateConfig: (change: ViewConfigChange) => void
}) {
  const { preview, previewError } = cleanup
  return (
    <AlertDialog
      onOpenChange={cleanup.setIsConfirmationOpen}
      open={cleanup.isConfirmationOpen}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Clean merged branches?</AlertDialogTitle>
          <AlertDialogDescription>
            Selected local branches will be permanently deleted.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="grid gap-3 text-sm">
          <label className="flex items-start gap-2">
            <input
              checked={cleanOptions.deleteMergedPullRequestBranches}
              className="mt-0.5 size-4 accent-primary"
              onChange={(event) =>
                updateConfig({
                  cleanOptions: {
                    deleteMergedPullRequestBranches: event.target.checked,
                  },
                })
              }
              type="checkbox"
            />
            <span>
              Delete branches whose merged pull request head matches the local
              tip.
            </span>
          </label>
          <label className="flex items-start gap-2">
            <input
              checked={cleanOptions.deleteMergedBranches}
              className="mt-0.5 size-4 accent-primary"
              onChange={(event) =>
                updateConfig({
                  cleanOptions: {
                    deleteMergedBranches: event.target.checked,
                  },
                })
              }
              type="checkbox"
            />
            <span>
              Delete branches with no commits ahead of the default branch that
              are not checked out in any worktree.
            </span>
          </label>
          <label className="flex items-start gap-2">
            <input
              checked={cleanOptions.deleteSquashMergedBranches}
              className="mt-0.5 size-4 accent-primary"
              onChange={(event) =>
                updateConfig({
                  cleanOptions: {
                    deleteSquashMergedBranches: event.target.checked,
                  },
                })
              }
              type="checkbox"
            />
            <span>
              Delete branches whose changes already sit on the default branch as
              one squashed commit, matched by content rather than by a record of
              the merge.
            </span>
          </label>
        </div>
        <div className="max-h-52 overflow-y-auto rounded-lg border p-3 text-sm">
          {cleanup.isPreviewPending && (
            <p className="text-muted-foreground">Finding branches to clean…</p>
          )}
          {previewError && <p className="text-destructive">{previewError}</p>}
          {preview?.length === 0 && (
            <p className="text-muted-foreground">
              No branches match the selected cleanup options.
            </p>
          )}
          {preview && preview.length > 0 && (
            <div className="grid gap-3">
              {[
                ["Squash-merged pull requests", "squashMergedPullRequest"],
                ["Merged into the default branch", "mergedIntoDefaultBranch"],
                [
                  "Squashed into the default branch",
                  "squashedIntoDefaultBranch",
                ],
              ].map(([label, reason]) => {
                const candidates = preview.filter((candidate) =>
                  candidate.reasons.includes(reason as CleanupReason),
                )
                return candidates.length === 0 ?
                    null
                  : <section className="grid gap-1" key={reason}>
                      <h3 className="font-medium">{label}</h3>
                      <ul className="font-mono text-xs text-muted-foreground">
                        {candidates.map((candidate) => (
                          <li key={candidate.branch}>{candidate.branch}</li>
                        ))}
                      </ul>
                    </section>
              })}
            </div>
          )}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={cleanup.isPending}>
            Cancel
          </AlertDialogCancel>
          <Button
            disabled={
              cleanup.isPending ||
              !preview ||
              preview.length === 0 ||
              Boolean(previewError)
            }
            onClick={() => cleanup.clean()}
            type="button"
            variant="destructive"
          >
            {cleanup.isPending ? "Cleaning…" : "Clean branches"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
