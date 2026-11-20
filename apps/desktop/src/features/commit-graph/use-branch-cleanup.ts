import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query"
import { showErrorToast } from "@/lib/error-toast"
import { invoke } from "@/lib/ipc"
import { toast } from "@workspace/shadcn/components/sonner"
import { useEffect, useRef, useState } from "react"

import type { CleanOptions } from "./commit-graph-view"

type BranchCleanup = {
  candidates: string[]
  deleted: string[]
  failed: string[]
}
type CleanResult = { report: string } | { result: BranchCleanup }
export type CleanupCandidate = {
  branch: string
  missingWorktrees: string[]
  reasons: CleanupReason[]
}
export type CleanupReason =
  | "squashMergedPullRequest"
  | "mergedIntoDefaultBranch"
  | "squashedIntoDefaultBranch"

export function useBranchCleanup({
  cleanOptions,
  graphVersion,
  pullRequestVersion,
  refreshGraph,
  repoPath,
  worktreeState,
}: {
  cleanOptions: CleanOptions
  graphVersion: number
  pullRequestVersion: number
  refreshGraph: () => void
  repoPath: string
  worktreeState: string | null
}) {
  const [isConfirmationOpen, setIsConfirmationOpen] = useState(false)
  const cleanMutation = useMutation({
    mutationFn: async (): Promise<CleanResult> => {
      if (!Object.values(cleanOptions).some(Boolean)) {
        return { report: "Select at least one cleanup option." }
      }
      return {
        result: await invoke<BranchCleanup>("delete_squashed_branches", {
          repoPath,
          options: cleanOptions,
        }),
      }
    },
    onSuccess: (outcome) => {
      setIsConfirmationOpen(false)
      if ("report" in outcome) {
        toast(outcome.report)
        return
      }
      const { result } = outcome
      const details = [
        result.deleted.length ?
          `Deleted ${result.deleted.length} merged PR branch${result.deleted.length === 1 ? "" : "es"}.`
        : null,
        result.failed.length ?
          `Could not delete: ${result.failed.join(", ")}`
        : null,
        !result.deleted.length && !result.failed.length ?
          "No branches were deleted because the candidate list changed."
        : null,
      ].filter(Boolean)
      const [title, ...description] = details
      toast(title, { description: description.join("\n") })
      refreshGraph()
    },
    onError: (message) => showErrorToast("Could not delete branches.", message),
  })
  // Repository changes stay out of the key so a busy repository cannot keep restarting the read.
  const repositoryState = `${graphVersion}\0${pullRequestVersion}\0${worktreeState}`
  const readState = useRef<string | null>(null)
  const previewQuery = useQuery({
    queryKey: ["cleanupCandidates", repoPath, cleanOptions],
    queryFn: () => {
      readState.current = repositoryState
      return invoke<CleanupCandidate[]>("preview_cleanup_candidates", {
        repoPath,
        options: cleanOptions,
      })
    },
    enabled: worktreeState !== null,
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: false,
    retry: false,
  })
  const { isFetching, refetch } = previewQuery
  useEffect(() => {
    if (
      worktreeState !== null &&
      !isFetching &&
      readState.current !== repositoryState
    ) {
      void refetch()
    }
  }, [isFetching, refetch, repositoryState, worktreeState])
  const cleanPreview = previewQuery.data ?? null
  return {
    candidateCount: cleanPreview?.length ?? 0,
    clean: () => cleanMutation.mutate(),
    isConfirmationOpen,
    isPending: cleanMutation.isPending,
    isPreviewPending: isFetching,
    preview: cleanPreview,
    previewError: previewQuery.error && String(previewQuery.error),
    setIsConfirmationOpen,
  }
}
