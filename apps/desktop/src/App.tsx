import "dockview-react/dist/styles/dockview.css"
import "./App.css"

import { Toaster } from "@workspace/shadcn/components/sonner"
import { TooltipProvider } from "@workspace/shadcn/components/tooltip"
import { useTheme } from "./components/theme-provider"
import { AppKeyboardShortcuts } from "./features/app-menu/app-menu"
import { UpdateCheck } from "./features/update-check"
import { WorkspaceWindow } from "./features/workspace/workspace-window"

export function App() {
  const theme = useTheme()

  return (
    <TooltipProvider delayDuration={400}>
      <AppKeyboardShortcuts />
      <WorkspaceWindow />
      <Toaster theme={theme} />
      <UpdateCheck />
    </TooltipProvider>
  )
}
