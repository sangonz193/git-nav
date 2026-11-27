export function worktreeGraphPanelId(
  graphs: { id: string; path: string }[],
  worktree: string,
  activePanelId: string | undefined,
) {
  const onWorktree = graphs.filter((graph) => graph.path === worktree)
  return (
    onWorktree.find((graph) => graph.id === activePanelId) ?? onWorktree[0]
  )?.id
}
