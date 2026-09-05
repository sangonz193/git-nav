import { useEffect } from "react"

import { checkForUpdate } from "./updates"

export function UpdateCheck() {
  useEffect(() => {
    void checkForUpdate()
  }, [])

  return null
}
