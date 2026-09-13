import type { ResolvingMetadata } from "next"
import { GuideLinks } from "@/components/guide-links"
import { pageMetadata } from "@/lib/site"

export function generateMetadata(_: unknown, parent: ResolvingMetadata) {
  return pageMetadata(
    {
      title: "Git guides: branches, worktrees, diffs and commits",
      description:
        "Practical Git guides with terminal examples and Git Nav screenshots. Clean up squash-merged branches, use worktrees, compare changes and prepare commits.",
      path: "/guides",
    },
    parent,
  )
}

export default function Guides() {
  return (
    <main className="mx-auto max-w-5xl pt-12 sm:pt-20" id="main-content">
      <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
        Git guides for the work between commits
      </h1>
      <p className="mt-6 max-w-2xl text-lg text-pretty text-muted-foreground">
        Understand what Git is comparing, what is staged, and which branches are
        finished. Each guide explains the Git behavior and shows how to work
        with it in Git Nav, a free Git GUI for macOS, Windows and Linux.
      </p>
      <section className="mt-12" aria-labelledby="workflow-guides">
        <h2 className="mb-6 text-2xl font-semibold" id="workflow-guides">
          Choose a workflow
        </h2>
        <GuideLinks />
      </section>
      <p className="mt-10 text-muted-foreground">
        New to Git Nav?{" "}
        <a className="text-foreground underline underline-offset-4" href="/">
          See the app
        </a>{" "}
        or{" "}
        <a
          className="text-foreground underline underline-offset-4"
          href="/download"
        >
          download it for your platform
        </a>
        .
      </p>
    </main>
  )
}
