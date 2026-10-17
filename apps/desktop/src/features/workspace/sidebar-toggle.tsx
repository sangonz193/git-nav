import { PanelLeftOpen } from "lucide-react"
import { useContext } from "react"

import { Button } from "@workspace/shadcn/components/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/shadcn/components/tooltip"
import { cn } from "@workspace/shadcn/lib/utils"
import { AppMenuButton } from "../app-menu/app-menu"
import { SharingIndicator } from "../sharing/sharing-controls"
import { SidebarToggleContext } from "./sidebar-toggle-context"

export function ShowSidebarControls({ className }: { className?: string }) {
  const sidebar = useContext(SidebarToggleContext)
  if (!sidebar?.collapsed) return null
  return (
    <div className={cn("flex items-center gap-0.5", className)}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            aria-label="Show sidebar"
            className="text-muted-foreground"
            onClick={sidebar.toggle}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <PanelLeftOpen className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Show sidebar</TooltipContent>
      </Tooltip>
      <SharingIndicator />
      <AppMenuButton />
    </div>
  )
}
