import "dockview-react/dist/styles/dockview.css"
import "./App.css"

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

  return (
    // A tooltip opens on hover after a beat, and again without one while the pointer stays among neighbours.
    <TooltipProvider delayDuration={400}>
      <AppKeyboardShortcuts />
      {path ? <RepositoryWindow path={path} /> : <LauncherWindow />}
      <Toaster theme={theme} />
      <UpdateCheck />
    </TooltipProvider>
  )
}
