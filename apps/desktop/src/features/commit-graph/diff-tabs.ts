import { showErrorToast } from "@/lib/error-toast"
import { invoke } from "@/lib/ipc"
import { panelId } from "@/lib/panel-id"
import { EMPTY_TREE_REF, WORKTREE_REF } from "@/lib/repository-constants"
import type { DockviewApi } from "dockview-react"

import {
  refRevision,
  type Commit,
  type CommitSelection,
  type DisplayRef,
  type RowWorktree,
  type StashEntry,
} from "./commit-graph"
import { branchRangeTitle, refLabel, selectedRefs } from "../diff/diff-title"
import { rangeBaseHash } from "./selection-diff"

type BranchSelection = { baseRef: string; headRef: string }

export function diffTabs({
  containerApi,
  name,
  panel,
  repoPath,
}: {
  containerApi: DockviewApi
  name: string
  panel: string
  repoPath: string
}) {
  const repositoryPanelParams = { name, path: repoPath }

  async function openRefDiff(ref: DisplayRef) {
    try {
      const selection = await invoke<BranchSelection>("select_branch_range", {
        repoPath,
        reference: refRevision(ref),
      })
      const referencePanel = containerApi.getPanel(panel)
      if (!referencePanel) {
        throw new Error("The graph tab is no longer open.")
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
      showErrorToast("Could not open a diff tab.", message)
    }
  }

  function openCommitDiff(commit: Commit, selectedFilePath?: string) {
    const baseRef = commit.parents[0] ?? EMPTY_TREE_REF
    const referencePanel = containerApi.getPanel(panel)
    if (!referencePanel) {
      showErrorToast("Could not open a commit diff.")
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
        selectedFilePath,
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
      showErrorToast("Could not open a working tree diff.")
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

  function openWorktreeGraph(worktree: RowWorktree) {
    const referencePanel = containerApi.getPanel(panel)
    if (!referencePanel) {
      showErrorToast("Could not open a graph tab.")
      return
    }
    containerApi.addPanel({
      component: "graph",
      id: panelId("graph"),
      params: { name: worktree.name, path: worktree.path },
      position: { direction: "within", referencePanel },
      tabComponent: "graph",
      title: "Graph",
    })
  }

  // The tab is scoped to the worktree the chip stands for, whichever one this panel was opened on.
  function openWorkingTree(worktree: RowWorktree) {
    const referencePanel = containerApi.getPanel(panel)
    if (!referencePanel) {
      showErrorToast("Could not open a working tree tab.")
      return
    }
    containerApi.addPanel({
      component: "working-tree",
      id: panelId("working-tree"),
      params: { ...repositoryPanelParams, path: worktree.path },
      position: { direction: "within", referencePanel },
      tabComponent: "working-tree",
      title: worktree.name,
    })
  }

  // A stash entry records the working tree against the commit it was made from, which is its first parent.
  function openStashDiff(entry: StashEntry) {
    const referencePanel = containerApi.getPanel(panel)
    if (!referencePanel) {
      showErrorToast("Could not open a stash diff.")
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

  function openRangeDiff(
    selection: CommitSelection,
    selectedFilePath?: string,
  ) {
    const baseRef = rangeBaseHash(selection)
    const referencePanel = containerApi.getPanel(panel)
    if (!baseRef || !referencePanel) {
      showErrorToast("Could not open a range diff.")
      return
    }
    containerApi.addPanel({
      component: "diff",
      id: panelId("diff"),
      params: {
        ...repositoryPanelParams,
        baseRef,
        headRef: selection.tip.hash,
        selectedFilePath,
      },
      position: { direction: "within", referencePanel },
      tabComponent: "diff",
      title: `${refLabel(baseRef)}..${refLabel(selection.tip.hash)}`,
    })
  }

  return {
    openCommitDiff,
    openRangeDiff,
    openRefDiff,
    openStashDiff,
    openWorktreeGraph,
    openWorkingTree,
    openWorktreeDiff,
  }
}
