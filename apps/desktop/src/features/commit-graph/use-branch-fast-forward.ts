import { useMutation } from "@tanstack/react-query"
import { invoke } from "@/lib/ipc"
import { toast } from "@workspace/shadcn/components/sonner"
import { useEffect, useState } from "react"

import type { CompletedOperation } from "./commit-operations"
import type { CleanOptions } from "./commit-graph-view"

export type FastForwardCandidate = {
  branch: string
  worktree: string | null
  blocker: string | null
}
type BranchFastForward = {
  target: string
  moved: string[]
  failed: { branch: string; message: string }[]
  updates: CompletedOperation["updates"]
}

export function useBranchFastForward({
  cleanOptions,
  graphVersion,
  pullRequestVersion,
  onCompleted,
  onError,
  repoPath,
}: {
  cleanOptions: CleanOptions
  graphVersion: number
  pullRequestVersion: number
  onCompleted: (result: CompletedOperation) => void
  onError: (message: string | null) => void
  repoPath: string
}) {
  const [isConfirmationOpen, setIsConfirmationOpen] = useState(false)
  const [preview, setPreview] = useState<FastForwardCandidate[] | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const fastForwardMutation = useMutation({
    mutationFn: () =>
      invoke<BranchFastForward>("fast_forward_merged_branches", {
        repoPath,
        options: cleanOptions,
      }),
    onMutate: () => onError(null),
    onSuccess: (result) => {
      setIsConfirmationOpen(false)
      if (result.failed.length) {
        toast(
          `Could not fast-forward ${result.failed.map(({ branch }) => branch).join(", ")}`,
          {
            description: result.failed
              .map(({ branch, message }) => `${branch}: ${message}`)
              .join("\n"),
          },
        )
      }
      if (!result.moved.length) {
        if (!result.failed.length) {
          toast("No branches were moved because the candidate list changed.")
        }
        return
      }
      onCompleted({
        summary: `Fast-forwarded ${result.moved.length} branch${result.moved.length === 1 ? "" : "es"} to ${result.target}.`,
        updates: result.updates,
      })
    },
    onError: (message) => onError(String(message)),
  })
  const { isPending: isPreviewPending, mutate: previewCandidates } =
    useMutation({
      mutationFn: (options: CleanOptions) =>
        invoke<FastForwardCandidate[]>("preview_fast_forward_candidates", {
          repoPath,
          options,
        }),
      onMutate: () => setPreviewError(null),
      onSuccess: setPreview,
      onError: (message) => setPreviewError(String(message)),
    })
  // Cleanup candidates are excluded, so the set depends on the cleanup options in force.
  useEffect(() => {
    previewCandidates(cleanOptions)
  }, [cleanOptions, graphVersion, pullRequestVersion, previewCandidates])
  return {
    candidateCount:
      preview?.filter((candidate) => !candidate.blocker).length ?? 0,
    fastForward: () => fastForwardMutation.mutate(),
    isConfirmationOpen,
    isPending: fastForwardMutation.isPending,
    isPreviewPending,
    preview,
    previewError,
    setIsConfirmationOpen,
  }
}
