import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query"
import { invoke } from "@/lib/ipc"
import { toast } from "@workspace/shadcn/components/sonner"
import { useState } from "react"

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
  worktreeState,
}: {
  cleanOptions: CleanOptions
  graphVersion: number
  pullRequestVersion: number
  onCompleted: (result: CompletedOperation) => void
  onError: (message: string | null) => void
  repoPath: string
  worktreeState: string | null
}) {
  const [isConfirmationOpen, setIsConfirmationOpen] = useState(false)
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
  // Cleanup candidates are excluded, so the set depends on the cleanup options in force.
  const previewQuery = useQuery({
    queryKey: [
      "fastForwardCandidates",
      repoPath,
      cleanOptions,
      graphVersion,
      pullRequestVersion,
      worktreeState,
    ],
    queryFn: () =>
      invoke<FastForwardCandidate[]>("preview_fast_forward_candidates", {
        repoPath,
        options: cleanOptions,
      }),
    enabled: worktreeState !== null,
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: false,
    retry: false,
  })
  const preview = previewQuery.data ?? null
  return {
    candidateCount:
      preview?.filter((candidate) => !candidate.blocker).length ?? 0,
    fastForward: () => fastForwardMutation.mutate(),
    isConfirmationOpen,
    isPending: fastForwardMutation.isPending,
    isPreviewPending: previewQuery.isFetching,
    preview,
    previewError: previewQuery.error && String(previewQuery.error),
    setIsConfirmationOpen,
  }
}
