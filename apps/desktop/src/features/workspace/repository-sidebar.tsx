import {
  AppWindow,
  ChevronRight,
  CodeXml,
  Ellipsis,
  FolderOpen,
  GitBranch,
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
import {
  projectHome,
  type ProjectWorktree,
  type SidebarProject,
} from "./workspace"

type ProjectActions = {
  onOpenInNewWindow: (target: ProjectWorktree) => void
  onRemove: (project: string) => void
  onSelect: (target: ProjectWorktree) => void
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
  target,
}: Omit<ProjectActions, "onSelect"> & {
  components: MenuComponents
  project: SidebarProject
  target: ProjectWorktree
}) {
  return (
    <>
      <Item onSelect={() => openIn(target.worktree, "finder")}>
        <FolderOpen />
        Open in File Manager
      </Item>
      <Item onSelect={() => openIn(target.worktree, "vscode")}>
        <CodeXml />
        Open in VS Code
      </Item>
      <Item onSelect={() => openIn(target.worktree, "terminal")}>
        <Terminal />
        Open in Terminal
      </Item>
      <Separator />
      <Item onSelect={() => onOpenInNewWindow(target)}>
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
  expanded,
  onOpenInNewWindow,
  onRemove,
  onSelect,
  onToggle,
  project,
}: ProjectActions & {
  active: ProjectWorktree | null
  expanded: boolean
  onToggle: () => void
  project: SidebarProject
}) {
  const activeWorktree = active?.project === project.id ? active.worktree : null
  const shownWorktree =
    activeWorktree && activeWorktree !== project.path ?
      project.worktrees.find((worktree) => worktree.path === activeWorktree)
    : undefined
  const rowActive =
    activeWorktree !== null &&
    (!expanded ||
      !project.worktrees.some((worktree) => worktree.path === activeWorktree))
  const target = {
    project: project.id,
    worktree: activeWorktree ?? project.path,
  }
  const menu = { onOpenInNewWindow, onRemove, project, target }

  return (
    <li>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className={cn(
              "group flex h-8 items-center gap-0.5 rounded-md pr-1 pl-0.5 text-sm",
              rowActive ?
                "bg-sidebar-accent text-sidebar-accent-foreground"
              : "hover:bg-sidebar-accent/60",
            )}
          >
            <button
              aria-expanded={expanded}
              aria-label={`${expanded ? "Collapse" : "Expand"} ${project.name}`}
              className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              onClick={onToggle}
              type="button"
            >
              <ChevronRight
                className={cn(
                  "size-3.5 transition-transform",
                  expanded && "rotate-90",
                )}
              />
            </button>
            <button
              aria-current={rowActive ? "page" : undefined}
              className="flex min-w-0 flex-1 items-center gap-2 self-stretch rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => onSelect(projectHome(project))}
              title={project.path}
              type="button"
            >
              <span className="truncate font-medium">{project.name}</span>
              {!expanded && shownWorktree && (
                <span className="truncate text-xs text-muted-foreground">
                  {shownWorktree.label}
                </span>
              )}
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
      {expanded && (
        <ul aria-label={`${project.name} worktrees`}>
          {project.worktrees.map((worktree) => (
            <li key={worktree.path}>
              <button
                aria-current={
                  worktree.path === activeWorktree ? "page" : undefined
                }
                className={cn(
                  "flex h-8 w-full items-center gap-2 rounded-md pr-2 pl-8 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  worktree.path === activeWorktree ?
                    "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "hover:bg-sidebar-accent/60",
                )}
                onClick={() =>
                  onSelect({ project: project.id, worktree: worktree.path })
                }
                title={worktree.path}
                type="button"
              >
                <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{worktree.label}</span>
                {worktree.detail && (
                  <span className="truncate text-xs text-muted-foreground">
                    {worktree.detail}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
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
  active: ProjectWorktree | null
  onCollapse: () => void
  projects: SidebarProject[]
  projectsError: string | null
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [isPickerOpen, setIsPickerOpen] = useState(false)

  function chooseRepository() {
    if (isDesktop) {
      invoke<void>("choose_repository").catch(reportOpenError)
    } else {
      setIsPickerOpen(true)
    }
  }

  function toggle(project: string) {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(project)) next.delete(project)
      else next.add(project)
      return next
    })
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
            active={active}
            expanded={expanded.has(project.id)}
            key={project.id}
            onToggle={() => toggle(project.id)}
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
