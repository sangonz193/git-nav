import "dockview-react/dist/styles/dockview.css"
import "./App.css"

import { LauncherWindow } from "./features/launcher/launcher-window"
import { RepositoryWindow } from "./features/repository/repository-window"

function repositoryPath() {
  return new URLSearchParams(window.location.search).get("repository")
}

export function App() {
  const path = repositoryPath()

  return path ? <RepositoryWindow path={path} /> : <LauncherWindow />
}
