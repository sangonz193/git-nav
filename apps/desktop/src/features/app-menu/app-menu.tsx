import {
  Download,
  Ellipsis,
  SquareTerminal,
  FolderOpen,
  Maximize,
  RefreshCw,
  RotateCcw,
  Rows3,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react"
import { useEffect, useState, type ReactNode } from "react"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@workspace/shadcn/components/dropdown-menu"
import { toast } from "@workspace/shadcn/components/sonner"
import { invoke, isDesktop } from "@/lib/ipc"
import { openRepository } from "@/lib/navigation"
import { FolderPicker } from "../launcher/folder-picker"
import type { Project } from "../repository/project"
import {
  checkForUpdateNow,
  installAvailableUpdate,
  useAppVersion,
  useAvailableUpdate,
} from "../updates"
import {
  desktopAppShortcut,
  usesNativeMenu,
  type DesktopAppCommand,
} from "./app-menu-shortcuts"

type CommandLineLink = {
  path: string | null
  state: "elsewhere" | "installed" | "missing" | "unsupported"
}

type AppMenuButtonProps = {
  loadRecentProjects?: () => Promise<Project[]>
  onCloseTab?: () => void
  onReopenTab?: () => void
  onRecentProjectsChange?: (projects: Project[]) => void
}

function runDesktopCommand(command: DesktopAppCommand) {
  switch (command) {
    case "show-launcher":
      return invoke<void>("show_launcher")
    case "choose-repository":
      return invoke<void>("choose_repository")
    case "zoom-in":
      return invoke<void>("zoom", { direction: "in" })
    case "zoom-out":
      return invoke<void>("zoom", { direction: "out" })
    case "actual-size":
      return invoke<void>("zoom", { direction: "actual-size" })
  }
}

export function AppKeyboardShortcuts() {
  useEffect(() => {
    if (!isDesktop) {
      return
    }
    const nativeMenu = usesNativeMenu(navigator.userAgent)
    function onKeyDown(event: KeyboardEvent) {
      const command = desktopAppShortcut(event, nativeMenu)
      if (!command) {
        return
      }
      event.preventDefault()
      runDesktopCommand(command).catch((error) => {
        toast.error("Could not run the command.", {
          description: String(error),
        })
      })
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])
  return null
}

function Shortcut({ children }: { children: ReactNode }) {
  return (
    <span className="ml-auto pl-6 text-xs tracking-widest text-muted-foreground">
      {children}
    </span>
  )
}

export function AppMenuButton({
  loadRecentProjects,
  onCloseTab,
  onReopenTab,
  onRecentProjectsChange,
}: AppMenuButtonProps) {
  const [projects, setProjects] = useState<Project[]>([])
  const [isPickerOpen, setIsPickerOpen] = useState(false)
  const availableUpdate = useAvailableUpdate()
  const version = useAppVersion()
  const [commandLine, setCommandLine] = useState<CommandLineLink | null>(null)
  const shortcutPrefix =
    isDesktop && usesNativeMenu(navigator.userAgent) ? "⌘" : "Ctrl+"
  const shiftShortcutPrefix = shortcutPrefix === "⌘" ? "⇧⌘" : "Ctrl+Shift+"

  async function refreshProjects() {
    try {
      const projects = await (loadRecentProjects?.() ??
        invoke<Project[]>("recent_projects"))
      setProjects(projects)
      if (!loadRecentProjects) onRecentProjectsChange?.(projects)
    } catch (error) {
      toast.error("Could not load recent repositories.", {
        description: String(error),
      })
    }
  }

  function reportCommandError(error: unknown) {
    toast.error("Could not run the command.", { description: String(error) })
  }

  function chooseRepository() {
    if (isDesktop) {
      runDesktopCommand("choose-repository").catch(reportCommandError)
    } else {
      setIsPickerOpen(true)
    }
  }

  function openRecent(path: string) {
    openRepository(path).catch(reportCommandError)
  }

  async function installCommandLineTool() {
    try {
      const link = await invoke<CommandLineLink>("install_command_line_link")
      setCommandLine(link)
      toast("Command line tool installed", {
        description: `Run git nav . from ${link.path ?? "your shell"}.`,
      })
    } catch (error) {
      toast("Could not install the command line tool", {
        description: String(error),
      })
    }
  }

  function clearRecentProjects() {
    invoke<void>("clear_recent_projects")
      .then(() => {
        setProjects([])
        onRecentProjectsChange?.([])
      })
      .catch(reportCommandError)
  }

  return (
    <>
      <DropdownMenu
        onOpenChange={(open) => {
          if (!open) return
          void refreshProjects()
          if (isDesktop) {
            invoke<CommandLineLink>("command_line_link")
              .then(setCommandLine)
              .catch(() => setCommandLine(null))
          }
        }}
      >
        <DropdownMenuTrigger
          aria-label={
            availableUpdate
              ? `Application menu, update to ${availableUpdate} available`
              : "Application menu"
          }
          className="relative flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground data-[state=open]:bg-accent data-[state=open]:text-accent-foreground"
        >
          <Ellipsis className="size-4" />
          {availableUpdate && (
            <span className="absolute top-1 right-1 size-1.5 rounded-full bg-primary" />
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {isDesktop && (
            <DropdownMenuItem
              onSelect={() =>
                runDesktopCommand("show-launcher").catch(reportCommandError)
              }
            >
              <Rows3 />
              New Window
              <Shortcut>{shortcutPrefix}N</Shortcut>
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={chooseRepository}>
            <FolderOpen />
            Open…
            {isDesktop && <Shortcut>{shortcutPrefix}O</Shortcut>}
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Rows3 />
              Open Recent
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {projects.length === 0 && (
                <DropdownMenuItem disabled>No Recent Projects</DropdownMenuItem>
              )}
              {projects.map((project) => (
                <DropdownMenuItem
                  key={project.id}
                  onSelect={() => openRecent(project.path)}
                >
                  <span className="max-w-72 truncate">{project.name}</span>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={projects.length === 0}
                onSelect={clearRecentProjects}
              >
                Clear Menu
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          {(onCloseTab || onReopenTab) && (
            <>
              <DropdownMenuSeparator />
              {onCloseTab && (
                <DropdownMenuItem onSelect={onCloseTab}>
                  <X />
                  Close Tab
                  {isDesktop && <Shortcut>{shortcutPrefix}W</Shortcut>}
                </DropdownMenuItem>
              )}
              {onReopenTab && (
                <DropdownMenuItem onSelect={onReopenTab}>
                  <RotateCcw />
                  Reopen Closed Tab
                  {isDesktop && <Shortcut>{shiftShortcutPrefix}T</Shortcut>}
                </DropdownMenuItem>
              )}
            </>
          )}
          {isDesktop && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() =>
                  runDesktopCommand("zoom-in").catch(reportCommandError)
                }
              >
                <ZoomIn />
                Zoom In
                <Shortcut>{shortcutPrefix}=</Shortcut>
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() =>
                  runDesktopCommand("zoom-out").catch(reportCommandError)
                }
              >
                <ZoomOut />
                Zoom Out
                <Shortcut>{shortcutPrefix}-</Shortcut>
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() =>
                  runDesktopCommand("actual-size").catch(reportCommandError)
                }
              >
                <Maximize />
                Actual Size
                <Shortcut>{shortcutPrefix}0</Shortcut>
              </DropdownMenuItem>
            </>
          )}
          {isDesktop && (
            <>
              <DropdownMenuSeparator />
              {availableUpdate && (
                <DropdownMenuItem
                  onSelect={() => void installAvailableUpdate()}
                >
                  <Download />
                  Install Update {availableUpdate}
                </DropdownMenuItem>
              )}
              {commandLine && commandLine.state !== "unsupported" && (
                <DropdownMenuItem
                  disabled={commandLine.state === "installed"}
                  onSelect={() => void installCommandLineTool()}
                >
                  <SquareTerminal />
                  {commandLine.state === "installed"
                    ? "Command Line Tool Installed"
                    : "Install Command Line Tool"}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onSelect={() => void checkForUpdateNow()}>
                <RefreshCw />
                Check for Updates…
              </DropdownMenuItem>
              <DropdownMenuItem disabled>
                {version ? `Version ${version}` : "Git Nav"}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {!isDesktop && (
        <FolderPicker
          onCancel={() => setIsPickerOpen(false)}
          onChoose={(path) => {
            setIsPickerOpen(false)
            openRecent(path)
          }}
          open={isPickerOpen}
        />
      )}
    </>
  )
}
