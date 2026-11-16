import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query"
import { invoke } from "@/lib/ipc"
import { toast } from "@workspace/shadcn/components/sonner"
import { useState } from "react"

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
  onError,
  pullRequestVersion,
  refreshGraph,
  repoPath,
  worktreeState,
}: {
  cleanOptions: CleanOptions
  graphVersion: number
  onError: (message: string | null) => void
  pullRequestVersion: number
  refreshGraph: () => void
  repoPath: string
  worktreeState: string
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
    onMutate: () => onError(null),
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
    onError: (message) => onError(String(message)),
  })
  // The badge counts what the dialog would delete, so the candidates are read for the options in force and
  // re-read when the repository changes rather than on a timer of their own.
  const previewQuery = useQuery({
    queryKey: [
      "cleanupCandidates",
      repoPath,
      cleanOptions,
      graphVersion,
      pullRequestVersion,
      worktreeState,
    ],
    queryFn: () =>
      invoke<CleanupCandidate[]>("preview_cleanup_candidates", {
        repoPath,
        options: cleanOptions,
      }),
    // The count stands until a newer one replaces it, so a refresh does not blank the badge on its way through.
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: false,
    retry: false,
  })
  const cleanPreview = previewQuery.data ?? null
  return {
    candidateCount: cleanPreview?.length ?? 0,
    clean: () => cleanMutation.mutate(),
    isConfirmationOpen,
    isPending: cleanMutation.isPending,
    isPreviewPending: previewQuery.isFetching,
    preview: cleanPreview,
    previewError: previewQuery.error && String(previewQuery.error),
    setIsConfirmationOpen,
  }
}
