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

import type { useBranchFastForward } from "./use-branch-fast-forward"

export function BranchFastForwardDialog({
  fastForward,
}: {
  fastForward: ReturnType<typeof useBranchFastForward>
}) {
  const { preview, previewError } = fastForward
  const ready = preview?.filter((candidate) => !candidate.blocker) ?? []
  const skipped = preview?.filter((candidate) => candidate.blocker) ?? []
  return (
    <AlertDialog
      onOpenChange={fastForward.setIsConfirmationOpen}
      open={fastForward.isConfirmationOpen}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Fast-forward branches?</AlertDialogTitle>
          <AlertDialogDescription>
            Local branches with no commits ahead of the default branch move to
            its tip. Branches the cleanup options would delete are left alone,
            as are worktrees with uncommitted changes or an operation in
            progress.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="max-h-52 overflow-y-auto rounded-lg border p-3 text-sm">
          {fastForward.isPreviewPending && (
            <p className="text-muted-foreground">
              Finding branches to fast-forward…
            </p>
          )}
          {previewError && <p className="text-destructive">{previewError}</p>}
          {preview?.length === 0 && (
            <p className="text-muted-foreground">
              Every local branch is either up to date, ahead, or a cleanup
              candidate.
            </p>
          )}
          {preview && preview.length > 0 && (
            <div className="grid gap-3">
              {ready.length > 0 && (
                <section className="grid gap-1">
                  <h3 className="font-medium">Will move</h3>
                  <ul className="font-mono text-xs text-muted-foreground">
                    {ready.map((candidate) => (
                      <li key={candidate.branch}>
                        {candidate.branch}
                        {candidate.worktree && (
                          <span className="font-sans"> (checked out)</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {skipped.length > 0 && (
                <section className="grid gap-1">
                  <h3 className="font-medium">Skipped</h3>
                  <ul className="font-mono text-xs text-muted-foreground">
                    {skipped.map((candidate) => (
                      <li key={candidate.branch}>
                        {candidate.branch}
                        <span className="font-sans">
                          {" "}
                          ({candidate.blocker})
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </div>
          )}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={fastForward.isPending}>
            Cancel
          </AlertDialogCancel>
          <Button
            disabled={
              fastForward.isPending ||
              ready.length === 0 ||
              Boolean(previewError)
            }
            onClick={() => fastForward.fastForward()}
            type="button"
          >
            {fastForward.isPending ? "Fast-forwarding…" : "Fast-forward"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
