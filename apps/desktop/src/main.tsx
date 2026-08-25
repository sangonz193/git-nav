import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import "@workspace/shadcn/globals.css"
import "@git-diff-view/react/styles/diff-view.css"
import { App } from "./App.tsx"
import { ThemeProvider } from "@/components/theme-provider.tsx"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </StrictMode>
)
