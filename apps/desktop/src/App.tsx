import "dockview-react/dist/styles/dockview.css"
import "./App.css"

import { Toaster } from "@workspace/shadcn/components/sonner"
import { useTheme } from "./components/theme-provider"
import { LauncherWindow } from "./features/launcher/launcher-window"
import { RepositoryWindow } from "./features/repository/repository-window"
import { UpdateCheck } from "./features/update-check"

function repositoryPath() {
  return new URLSearchParams(window.location.search).get("repository")
}

export function App() {
  const path = repositoryPath()
  const { theme } = useTheme()

  return (
    <>
      {path ? <RepositoryWindow path={path} /> : <LauncherWindow />}
      <Toaster theme={theme} />
      <UpdateCheck />
    </>
  )
}
