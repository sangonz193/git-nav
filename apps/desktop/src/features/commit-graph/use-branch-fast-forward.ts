import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query"
import { showErrorToast } from "@/lib/error-toast"
import { invoke } from "@/lib/ipc"
import { toast } from "@workspace/shadcn/components/sonner"
import { useEffect, useRef, useState } from "react"

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
  repoPath,
  worktreeState,
}: {
  cleanOptions: CleanOptions
  graphVersion: number
  pullRequestVersion: number
  onCompleted: (result: CompletedOperation) => void
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
    onError: (message) =>
      showErrorToast("Could not fast-forward branches.", message),
  })
  // Repository changes stay out of the key so a busy repository cannot keep restarting the read.
  const repositoryState = `${graphVersion}\0${pullRequestVersion}\0${worktreeState}`
  const readState = useRef<string | null>(null)
  const previewQuery = useQuery({
    queryKey: ["fastForwardCandidates", repoPath, cleanOptions],
    queryFn: () => {
      readState.current = repositoryState
      return invoke<FastForwardCandidate[]>("preview_fast_forward_candidates", {
        repoPath,
        options: cleanOptions,
      })
    },
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: false,
    retry: false,
  })
  const { isFetching, refetch } = previewQuery
  useEffect(() => {
    if (!isFetching && readState.current !== repositoryState) {
      void refetch()
    }
  }, [isFetching, refetch, repositoryState])
  const preview = previewQuery.data ?? null
  return {
    candidateCount:
      preview?.filter((candidate) => !candidate.blocker).length ?? 0,
    fastForward: () => fastForwardMutation.mutate(),
    isConfirmationOpen,
    isPending: fastForwardMutation.isPending,
    isPreviewPending: isFetching,
    preview,
    previewError: previewQuery.error && String(previewQuery.error),
    setIsConfirmationOpen,
  }
}
