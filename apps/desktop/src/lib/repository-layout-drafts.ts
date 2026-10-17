import { createContext } from "react"

export function repositoryLayoutDrafts() {
  const flushers = new Set<() => void>()
  const listeners = new Set<() => void>()
  return {
    register(flush: () => void) {
      flushers.add(flush)
      return () => {
        flushers.delete(flush)
      }
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    changed() {
      listeners.forEach((listener) => listener())
    },
    flush() {
      flushers.forEach((flush) => flush())
    },
  }
}

export const RepositoryLayoutDraftsContext = createContext<ReturnType<
  typeof repositoryLayoutDrafts
> | null>(null)
