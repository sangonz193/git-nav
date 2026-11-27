import { describe, expect, test } from "bun:test"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderToStaticMarkup } from "react-dom/server"

import { TooltipProvider } from "@workspace/shadcn/components/tooltip"
import type { Project } from "../repository/project"
import { RepositorySidebar } from "./repository-sidebar"

function worktree(path: string, branch: string, isMain: boolean) {
  return {
    path,
    name: path.split("/").at(-1)!,
    branch,
    head: "",
    isMain,
    isDetached: false,
    isLocked: false,
    isPrunable: false,
    isOpen: false,
  }
}

const projects: Project[] = [
  {
    id: "/code/app/.git",
    name: "app",
    path: "/code/app",
    worktrees: [
      worktree("/code/app", "main", true),
      worktree("/code/app-fix", "fix-branch", false),
    ],
  },
  {
    id: "/code/other/.git",
    name: "other",
    path: "/code/other",
    worktrees: [worktree("/code/other", "trunk", true)],
  },
]

describe("repository sidebar", () => {
  test("lists projects without their worktrees and marks the one shown", () => {
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <TooltipProvider>
          <RepositorySidebar
            active={{ project: "/code/other/.git" }}
            onCollapse={() => {}}
            onOpenInNewWindow={() => {}}
            onRemove={() => {}}
            onSelect={() => {}}
            projects={projects}
            projectsError={null}
          />
        </TooltipProvider>
      </QueryClientProvider>,
    )

    expect(markup).not.toContain("fix-branch")
    expect(markup).not.toContain("/code/app-fix")
    expect(markup).not.toContain("Expand app")
    expect(markup.match(/aria-current="page"/g)).toHaveLength(1)
    expect(markup).toMatch(/aria-current="page"[^>]*title="\/code\/other"/)
  })
})
