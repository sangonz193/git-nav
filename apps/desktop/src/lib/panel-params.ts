export type RepositoryPanelParams = {
  name: string
  path: string
}

export type DiffPanelUserPreferences = {
  fileTreeOpen?: boolean
  hideViewed?: boolean
  ignoreWhitespace?: boolean
  mode?: "split" | "unified"
  wrap?: boolean
}

export type DiffPanelParams = RepositoryPanelParams & {
  baseRef: string
  baseLabel?: string
  headRef: string
  headLabel?: string
  mergeBase?: boolean
  selectedFilePath?: string | null
  userPreferences?: DiffPanelUserPreferences
}

export type GraphPanelUserPreferences = {
  columnWidths?: Record<string, number>
}

export type GraphPanelParams = RepositoryPanelParams & {
  selectedCommitHashes?: string[]
  userPreferences?: GraphPanelUserPreferences
}
