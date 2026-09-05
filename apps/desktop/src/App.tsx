import "dockview-react/dist/styles/dockview.css"
import "./App.css"

import { useEffect } from "react"

import { Toaster } from "@workspace/shadcn/components/sonner"
import { TooltipProvider } from "@workspace/shadcn/components/tooltip"
import { useTheme } from "./components/theme-provider"
import { AppKeyboardShortcuts } from "./features/app-menu/app-menu"
import { LauncherWindow } from "./features/launcher/launcher-window"
import { RepositoryWindow } from "./features/repository/repository-window"
import { UpdateCheck } from "./features/update-check"

function repositoryPath() {
  return new URLSearchParams(window.location.search).get("repository")
}

export function App() {
  const path = repositoryPath()
  const theme = useTheme()

  // Effects run between the commit and the paint, so the splash leaves in the same frame the window it
  // stood in for arrives.
  useEffect(() => {
    document.getElementById("splash")?.remove()
  }, [])

  return (
    <TooltipProvider delayDuration={400}>
      <AppKeyboardShortcuts />
      {path ? <RepositoryWindow path={path} /> : <LauncherWindow />}
      <Toaster theme={theme} />
      <UpdateCheck />
    </TooltipProvider>
  )
}
