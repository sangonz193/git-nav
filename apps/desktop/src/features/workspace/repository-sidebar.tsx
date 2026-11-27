import {
  AppWindow,
  CodeXml,
  Ellipsis,
  FolderOpen,
  PanelLeftClose,
  Plus,
  Terminal,
  X,
} from "lucide-react"
import { useState, type ComponentType, type ReactNode } from "react"

import { Button } from "@workspace/shadcn/components/button"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@workspace/shadcn/components/context-menu"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@workspace/shadcn/components/dropdown-menu"
import { toast } from "@workspace/shadcn/components/sonner"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/shadcn/components/tooltip"
import { cn } from "@workspace/shadcn/lib/utils"
import { invoke, isDesktop } from "@/lib/ipc"
import {
  openRepository,
  openWorktree,
  type WorktreeTarget,
} from "@/lib/navigation"
import { AppMenuButton } from "../app-menu/app-menu"
import { FolderPicker } from "../launcher/folder-picker"
import { SharingIndicator } from "../sharing/sharing-controls"
import type { Project } from "../repository/project"
import type { ActiveProject } from "./workspace"

type ProjectActions = {
  onOpenInNewWindow: (project: Project) => void
  onRemove: (project: string) => void
  onSelect: (project: Project) => void
}

type MenuComponents = {
  Item: ComponentType<{ children: ReactNode; onSelect: () => void }>
  Separator: ComponentType
}

const DROPDOWN_COMPONENTS = {
  Item: DropdownMenuItem,
  Separator: DropdownMenuSeparator,
}

const CONTEXT_COMPONENTS = {
  Item: ContextMenuItem,
  Separator: ContextMenuSeparator,
}

function reportOpenError(error: unknown) {
  toast.error("Could not open the repository", { description: String(error) })
}

function openIn(path: string, target: WorktreeTarget) {
  openWorktree(path, target).catch(reportOpenError)
}

function ProjectMenuItems({
  components: { Item, Separator },
  onOpenInNewWindow,
  onRemove,
  project,
}: Omit<ProjectActions, "onSelect"> & {
  components: MenuComponents
  project: Project
}) {
  return (
    <>
      <Item onSelect={() => openIn(project.path, "finder")}>
        <FolderOpen />
        Open in File Manager
      </Item>
      <Item onSelect={() => openIn(project.path, "vscode")}>
        <CodeXml />
        Open in VS Code
      </Item>
      <Item onSelect={() => openIn(project.path, "terminal")}>
        <Terminal />
        Open in Terminal
      </Item>
      <Separator />
      <Item onSelect={() => onOpenInNewWindow(project)}>
        <AppWindow />
        Open in New Window
      </Item>
      <Separator />
      <Item onSelect={() => onRemove(project.id)}>
        <X />
        Remove from Sidebar
      </Item>
    </>
  )
}

function ProjectItem({
  active,
  onOpenInNewWindow,
  onRemove,
  onSelect,
  project,
}: ProjectActions & {
  active: boolean
  project: Project
}) {
  const menu = { onOpenInNewWindow, onRemove, project }

  return (
    <li>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className={cn(
              "group flex h-8 items-center gap-0.5 rounded-md pr-1 pl-2 text-sm",
              active ?
                "bg-sidebar-accent text-sidebar-accent-foreground"
              : "hover:bg-sidebar-accent/60",
            )}
          >
            <button
              aria-current={active ? "page" : undefined}
              className="flex min-w-0 flex-1 items-center gap-2 self-stretch rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => onSelect(project)}
              title={project.path}
              type="button"
            >
              <span className="truncate font-medium">{project.name}</span>
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label={`${project.name} options`}
                className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 hover:bg-accent hover:text-accent-foreground focus-visible:opacity-100 data-[state=open]:bg-accent data-[state=open]:text-accent-foreground data-[state=open]:opacity-100"
              >
                <Ellipsis className="size-3.5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <ProjectMenuItems components={DROPDOWN_COMPONENTS} {...menu} />
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ProjectMenuItems components={CONTEXT_COMPONENTS} {...menu} />
        </ContextMenuContent>
      </ContextMenu>
    </li>
  )
}

export function RepositorySidebar({
  active,
  onCollapse,
  projects,
  projectsError,
  ...actions
}: ProjectActions & {
  active: ActiveProject | null
  onCollapse: () => void
  projects: Project[]
  projectsError: string | null
}) {
  const [isPickerOpen, setIsPickerOpen] = useState(false)

  function chooseRepository() {
    if (isDesktop) {
      invoke<void>("choose_repository").catch(reportOpenError)
    } else {
      setIsPickerOpen(true)
    }
  }

  return (
    <nav
      aria-label="Projects"
      className="flex h-full flex-col bg-sidebar text-sidebar-foreground"
    >
      <div className="flex h-9 shrink-0 items-center gap-0.5 pr-1.5 pl-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label="Hide sidebar"
              className="text-muted-foreground"
              onClick={onCollapse}
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <PanelLeftClose className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Hide sidebar</TooltipContent>
        </Tooltip>
        <span className="flex-1 truncate text-xs font-medium text-muted-foreground">
          Projects
        </span>
        <SharingIndicator />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label="Open repository"
              className="text-muted-foreground"
              onClick={chooseRepository}
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <Plus className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Open repository…</TooltipContent>
        </Tooltip>
        <AppMenuButton />
      </div>
      {projectsError && (
        <p className="px-3 py-2 text-xs text-destructive" role="alert">
          Could not load projects. {projectsError}
        </p>
      )}
      <ul className="flex-1 overflow-y-auto px-1.5 pb-2">
        {projects.map((project) => (
          <ProjectItem
            active={active?.project === project.id}
            key={project.id}
            project={project}
            {...actions}
          />
        ))}
      </ul>
      {!isDesktop && (
        <FolderPicker
          onCancel={() => setIsPickerOpen(false)}
          onChoose={(path) => {
            setIsPickerOpen(false)
            openRepository(path).catch(reportOpenError)
          }}
          open={isPickerOpen}
        />
      )}
    </nav>
  )
}
