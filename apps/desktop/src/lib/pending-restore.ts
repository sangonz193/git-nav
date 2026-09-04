export function createUserWinningRestore(active: boolean) {
  let pending = active

  return {
    get pending() {
      return pending
    },
    cancel() {
      const cancelled = pending
      pending = false
      return cancelled
    },
    restore(apply: () => void) {
      if (!pending) {
        return false
      }
      pending = false
      apply()
      return true
    },
    userAction(apply: () => void) {
      pending = false
      apply()
    },
  }
}
