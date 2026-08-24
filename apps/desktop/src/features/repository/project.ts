export type Worktree = {
  path: string
  name: string
  branch: string
  head: string
  isMain: boolean
  isDetached: boolean
  isLocked: boolean
  isPrunable: boolean
  isOpen: boolean
}

export type Project = {
  id: string
  name: string
  path: string
  worktrees: Worktree[]
}
