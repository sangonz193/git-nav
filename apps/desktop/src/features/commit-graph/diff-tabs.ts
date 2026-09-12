import { invoke } from "@/lib/ipc"
import { panelId } from "@/lib/panel-id"
import { WORKTREE_REF } from "@/lib/repository-constants"
import type { DockviewApi } from "dockview-react"

import type {
  Commit,
  CommitSelection,
  RowWorktree,
  StashEntry,
} from "./commit-graph"
import { branchRangeTitle, refLabel, selectedRefs } from "../diff/diff-title"

type BranchSelection = { baseRef: string; headRef: string }

export function diffTabs({
  containerApi,
  name,
  onError,
  panel,
  repoPath,
}: {
  containerApi: DockviewApi
  name: string
  onError: (message: string) => void
  panel: string
  repoPath: string
}) {
  const repositoryPanelParams = { name, path: repoPath }

  async function openRefDiff(reference: string) {
    try {
      const selection = await invoke<BranchSelection>("select_branch_range", {
        repoPath,
        reference,
      })
      const referencePanel = containerApi.getPanel(panel)
      if (!referencePanel) {
        throw new Error("Could not open a diff tab.")
      }
      containerApi.addPanel({
        component: "diff",
        id: panelId("diff"),
        params: {
          ...repositoryPanelParams,
          baseRef: selection.baseRef,
          headRef: selection.headRef,
          mergeBase: true,
        },
        position: { direction: "within", referencePanel },
        tabComponent: "diff",
        title: branchRangeTitle(
          selectedRefs(selection.baseRef, selection.headRef, true),
        ),
      })
    } catch (message) {
      onError(String(message))
    }
  }

  function openCommitDiff(commit: Commit) {
    const baseRef = commit.parents[0]
    const referencePanel = containerApi.getPanel(panel)
    if (!baseRef || !referencePanel) {
      onError("Could not open a commit diff.")
      return
    }
    containerApi.addPanel({
      component: "diff",
      id: panelId("diff"),
      params: {
        ...repositoryPanelParams,
        baseRef,
        headRef: commit.hash,
        headLabel: commit.subject || "(no subject)",
      },
      position: { direction: "within", referencePanel },
      tabComponent: "diff",
      title: refLabel(commit.hash),
    })
  }

  // The diff is scoped to the dirty worktree, which is not always the one this panel was opened on.
  function openWorktreeDiff(worktree: RowWorktree) {
    const referencePanel = containerApi.getPanel(panel)
    if (!referencePanel) {
      onError("Could not open a working tree diff.")
      return
    }
    containerApi.addPanel({
      component: "diff",
      id: panelId("diff"),
      params: {
        ...repositoryPanelParams,
        path: worktree.path,
        baseRef: "HEAD",
        headRef: WORKTREE_REF,
      },
      position: { direction: "within", referencePanel },
      tabComponent: "diff",
      title: worktree.name,
    })
  }

  // A stash entry records the working tree against the commit it was made from, which is its first parent.
  function openStashDiff(entry: StashEntry) {
    const referencePanel = containerApi.getPanel(panel)
    if (!referencePanel) {
      onError("Could not open a stash diff.")
      return
    }
    containerApi.addPanel({
      component: "diff",
      id: panelId("diff"),
      params: {
        ...repositoryPanelParams,
        baseRef: `${entry.sha}^`,
        headRef: entry.sha,
        headLabel: entry.name,
      },
      position: { direction: "within", referencePanel },
      tabComponent: "diff",
      title: entry.name,
    })
  }

  function openRangeDiff({ base, tip }: CommitSelection) {
    const referencePanel = containerApi.getPanel(panel)
    if (!base || !referencePanel) {
      onError("Could not open a range diff.")
      return
    }
    containerApi.addPanel({
      component: "diff",
      id: panelId("diff"),
      params: {
        ...repositoryPanelParams,
        baseRef: base.hash,
        headRef: tip.hash,
      },
      position: { direction: "within", referencePanel },
      tabComponent: "diff",
      title: `${refLabel(base.hash)}..${refLabel(tip.hash)}`,
    })
  }

  return {
    openCommitDiff,
    openRangeDiff,
    openRefDiff,
    openStashDiff,
    openWorktreeDiff,
  }
}
