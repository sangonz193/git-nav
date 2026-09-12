import { GitCompareArrows } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"

import type { SearchMenuItem } from "@/components/search-menu"
import type { Commit, StashEntry } from "./commit-graph"
import { searchGraph } from "./commit-graph-view"
import { CHIP_ICONS } from "./commit-operations"

const SEARCH_DEBOUNCE = 120

export function useGraphSearch({
  commits,
  remotes,
  stashesByBase,
}: {
  commits: Commit[]
  remotes: string[] | undefined
  stashesByBase: Map<string, StashEntry[]>
}) {
  const [isSearchOpen, setIsSearchOpen] = useState(false)
  const [searchInput, setSearchInput] = useState("")
  const [searchQuery, setSearchQuery] = useState("")
  const [searchHitIndex, setSearchHitIndex] = useState(0)
  const searchField = useRef<HTMLInputElement>(null)
  const searchHits = useMemo(
    () =>
      isSearchOpen ?
        searchGraph(commits, searchQuery, { remotes, stashesByBase })
      : [],
    [commits, isSearchOpen, remotes, searchQuery, stashesByBase],
  )
  const searchMenuItems = useMemo(
    () =>
      searchHits.map((hit): SearchMenuItem => ({
        detail: hit.detail,
        icon: hit.kind === "commit" ? GitCompareArrows : CHIP_ICONS[hit.kind],
        key: `${hit.kind}-${hit.commitIndex}-${hit.label}`,
        label: hit.label,
      })),
    [searchHits],
  )

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setSearchQuery(searchInput)
      setSearchHitIndex(0)
    }, SEARCH_DEBOUNCE)
    return () => window.clearTimeout(timeout)
  }, [searchInput])

  function openSearch() {
    setIsSearchOpen(true)
    requestAnimationFrame(() => searchField.current?.select())
  }

  return {
    field: searchField,
    hitIndex: searchHitIndex,
    hits: searchHits,
    input: searchInput,
    isOpen: isSearchOpen,
    menuItems: searchMenuItems,
    open: openSearch,
    setHitIndex: setSearchHitIndex,
    setInput: setSearchInput,
    setIsOpen: setIsSearchOpen,
  }
}
