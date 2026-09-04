import "dockview-react/dist/styles/dockview.css"
import "./App.css"

import { useEffect } from "react"

import { Toaster } from "@workspace/shadcn/components/sonner"
import { TooltipProvider } from "@workspace/shadcn/components/tooltip"
import { MacOSWindowChromeProvider } from "@workspace/shadcn/components/macos-window-chrome"
import { useTheme } from "./components/theme-provider"
import { AppKeyboardShortcuts } from "./features/app-menu/app-menu"
import { LauncherWindow } from "./features/launcher/launcher-window"
import { RepositoryWindow } from "./features/repository/repository-window"
import { UpdateCheck } from "./features/update-check"
import { useMacOSWindowChrome } from "./lib/use-macos-window-chrome"

function repositoryPath() {
  return new URLSearchParams(window.location.search).get("repository")
}

export function App() {
  const path = repositoryPath()
  const theme = useTheme()
  const macOSWindowChrome = useMacOSWindowChrome()

  // Effects run between the commit and the paint, so the splash leaves in the same frame the window it
  // stood in for arrives.
  useEffect(() => {
    document.getElementById("splash")?.remove()
  }, [])

  return (
    <MacOSWindowChromeProvider enabled={macOSWindowChrome}>
      {/* A tooltip opens on hover after a beat, and again without one while the pointer stays among neighbours. */}
      <TooltipProvider delayDuration={400}>
        <AppKeyboardShortcuts />
        {path ? (
          <RepositoryWindow macOSWindowChrome={macOSWindowChrome} path={path} />
        ) : (
          <LauncherWindow macOSWindowChrome={macOSWindowChrome} />
        )}
        <Toaster theme={theme} />
        <UpdateCheck />
      </TooltipProvider>
    </MacOSWindowChromeProvider>
  )
}
