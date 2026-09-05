import { CopyCommand } from "@/components/copy-command"
import { DownloadCta } from "@/components/download-cta"
import { Shot } from "@/components/shot"
import { latestDownloads, RELEASES } from "@/lib/downloads"

const REPOSITORY = "https://github.com/sangonz193/git-nav"
const PACKAGE = "https://www.npmjs.com/package/git-nav"

const features = [
  {
    title: "Every worktree, beside the repository",
    body: "Opening a repository lists the worktrees checked out next to it and the branch each one holds. Open one in Git Nav, an editor, a terminal or the file manager.",
  },
  {
    title: "Pull request state on the branch",
    body: "A branch chip carries the pull request raised from it and whether it is open, merged or gone. It reads through the gh CLI, so it uses the GitHub login you already have.",
  },
  {
    title: "Reachable from your tablet",
    body: "git-nav serve --host 0.0.0.0 turns on sharing and prints a URL holding a token. The same repositories, read from another device on your network.",
  },
  {
    title: "Tabs that survive the day",
    body: "Graphs and diffs open in tabs you can split and drag. The layout is saved per repository, and a closed tab reopens from the keyboard.",
  },
  {
    title: "Search that reaches the whole graph",
    body: "Find a branch, tag or commit and land on it, including inside a collapsed run, which opens where it sits.",
  },
  {
    title: "Updates that find you",
    body: "The app looks for a new version in the background. An installed build updates itself from a signed release; an npm install tells you the command to run.",
  },
]

export default async function Home() {
  const platforms = await latestDownloads()

  return (
    <div className="mx-auto max-w-[1440px] px-6">
      <header className="flex items-center justify-between py-6">
        <span className="flex items-center gap-2.5 font-medium">
          {" "}
          <img alt="" className="size-7 rounded-md" src="/icon.svg" />
          Git Nav
        </span>
        <nav className="flex items-center gap-6 text-sm text-muted-foreground">
          <a className="transition-colors hover:text-foreground" href={PACKAGE}>
            npm
          </a>
          <a
            className="transition-colors hover:text-foreground"
            href={REPOSITORY}
          >
            GitHub
          </a>
        </nav>
      </header>

      <main>
        <section className="flex flex-col items-center pt-16 pb-14 text-center sm:pt-24">
          <h1 className="max-w-4xl text-4xl font-semibold tracking-tight text-balance sm:text-6xl">
            A Git client that hides the commits nobody points at.
          </h1>
          <p className="mt-6 max-w-2xl text-lg text-pretty text-muted-foreground">
            Everything something points at keeps its row: branches, tags,
            worktrees, stashes and pull request state. Beside the graph, a diff
            between any two references and seventeen operations that predict
            their conflicts before they run.
          </p>

          <div className="mt-10 flex max-w-xl flex-col items-center space-y-5">
            <DownloadCta platforms={platforms} />
            <p className="text-sm text-pretty text-muted-foreground">
              Or install it from npm with{" "}
              <code className="font-mono text-foreground">
                npm install --global git-nav
              </code>
              .
            </p>
          </div>
        </section>

        <Shot
          alt="Git Nav showing Git's own repository, with runs of unreferenced commits collapsed into single rows"
          caption="Two thousand commits of Git's own history, in the ten rows something points at. Every run opens where it sits."
          height={1280}
          priority
          src="/screenshots/graph-collapsed.png"
          width={2880}
        />

        <section className="pt-24">
          <h2 className="max-w-2xl text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
            Collapse the commits nothing points at
          </h2>
          <p className="mt-5 max-w-2xl text-pretty text-muted-foreground">
            A branch, a remote branch, a tag, a worktree, a stash or your
            current checkout earns a commit its own row. Everything between them
            folds into one run that opens in place. Turn it off and the whole
            history is back, at the scroll position you left.
          </p>
          <div className="mt-10 grid gap-8 lg:grid-cols-2">
            <Shot
              alt="Git's own history with every commit listed, one topic branch per lane"
              caption="Every commit, in order."
              height={1280}
              src="/screenshots/collapse-before.png"
              width={1520}
            />
            <Shot
              alt="The same history with every unreferenced commit collapsed into a run"
              caption="Only what something points at."
              height={1280}
              src="/screenshots/collapse-after.png"
              width={1520}
            />
          </div>
        </section>

        <section className="pt-24">
          <h2 className="max-w-2xl text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
            Diff any two references
          </h2>
          <p className="mt-5 max-w-2xl text-pretty text-muted-foreground">
            Pick a branch, tag, commit or revision on each side and read the
            difference between them, either directly or from the point the two
            sides forked. The files you have read stay marked, keyed to the
            patch you read them at, so a rebase or a force push brings back only
            what actually changed.
          </p>
          <ul className="mt-6 grid max-w-2xl gap-2 text-sm text-muted-foreground sm:grid-cols-2">
            <li>Split or unified, per tab</li>
            <li>Read a comparison without its whitespace</li>
            <li>Fold a file away from its header</li>
            <li>Filter down to what you have not read</li>
          </ul>
          <div className="mt-10">
            <Shot
              alt="A diff between two tags, with a file tree and a split view"
              height={1600}
              src="/screenshots/diff.png"
              width={2880}
            />
          </div>
        </section>

        <section className="pt-24">
          <h2 className="max-w-2xl text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
            Operations that say what they will do
          </h2>
          <p className="mt-5 max-w-2xl text-pretty text-muted-foreground">
            Seventeen operations, from checkout and merge to rebase,
            cherry-pick, revert, reset and push, read off the two things you
            picked and offer only what applies to them. Each one predicts its
            conflicts before it runs and reports every reference it moved, with
            one button to put them back.
          </p>
          <div className="mt-10">
            <Shot
              alt="The commit menu, listing the operations available for the selected commit"
              height={1400}
              src="/screenshots/commit-menu.png"
              width={2880}
            />
          </div>
        </section>

        <section className="pt-24">
          <h2 className="max-w-2xl text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
            Delete the branches a squash merge left behind
          </h2>
          <p className="mt-5 max-w-2xl text-pretty text-muted-foreground">
            <code className="font-mono">git branch --merged</code> never lists
            them. A squash merge rewrites the branch into one commit and leaves
            no ancestry to follow, so the branch reads as unmerged forever. Git
            Nav matches by content instead, and previews what it would delete
            grouped by reason: a merged pull request whose head matches your
            local tip, a branch with no commits ahead of the default branch, and
            a branch whose changes already sit on the default branch as one
            squashed commit.
          </p>
          <div className="mt-10">
            <Shot
              alt="The branch cleanup dialog, listing the branches that match each signal"
              height={1400}
              src="/screenshots/cleanup.png"
              width={2880}
            />
          </div>
        </section>

        <section className="pt-24">
          <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            And the rest of it
          </h2>
          <div className="mt-10 grid gap-x-10 gap-y-8 sm:grid-cols-2">
            {features.map((feature) => (
              <div key={feature.title}>
                <h3 className="font-medium">{feature.title}</h3>
                <p className="mt-2 text-sm text-pretty text-muted-foreground">
                  {feature.body}
                </p>
              </div>
            ))}
          </div>
        </section>

        <section className="pt-24" id="install">
          <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            Install it
          </h2>
          <div className="mt-10 grid gap-10 sm:grid-cols-2">
            <div>
              <h3 className="font-medium">As an installer</h3>
              <p className="mt-2 text-sm text-pretty text-muted-foreground">
                A .dmg for macOS, a .exe for Windows, and .AppImage, .deb and
                .rpm for Linux, on both x64 and arm64. Once installed, the app
                updates itself from signed releases.
              </p>
              <div className="mt-4">
                <DownloadCta platforms={platforms} />
              </div>
              <p className="mt-4 text-sm text-pretty text-muted-foreground">
                The macOS build is signed and notarized, so it opens straight
                away. Windows is not signed yet, and SmartScreen warns on the
                first launch: choose More info, then Run anyway.
              </p>
            </div>
            <div>
              <h3 className="font-medium">From npm</h3>
              <p className="mt-2 text-sm text-pretty text-muted-foreground">
                Installs the launcher and the binary for your platform, puts{" "}
                <code className="font-mono">git nav</code> on your path, and on
                Windows arrives without the mark a download carries, so
                SmartScreen stays out of the way.
              </p>
              <div className="mt-4 space-y-3">
                <CopyCommand command="npm install --global git-nav" />
                <CopyCommand command="git nav ." />
              </div>
            </div>
          </div>
        </section>

        <section className="pt-24">
          <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            Read it from another device
          </h2>
          <p className="mt-5 max-w-2xl text-pretty text-muted-foreground">
            Sharing serves the same app over HTTP and prints a URL holding a
            token, which the browser keeps as a cookie. Branch deletion and
            rebasing are reachable over the network, so leave authentication on
            unless the port is already protected.
          </p>
          <div className="mt-6 max-w-xl">
            <CopyCommand command="git-nav serve --host 0.0.0.0" />
          </div>
        </section>
      </main>

      <footer className="mt-28 flex flex-wrap items-center justify-between gap-4 border-t border-border py-8 text-sm text-muted-foreground">
        <span>MIT licensed. Built by Santiago González.</span>
        <nav className="flex items-center gap-6">
          <a className="transition-colors hover:text-foreground" href={PACKAGE}>
            npm
          </a>
          <a
            className="transition-colors hover:text-foreground"
            href={REPOSITORY}
          >
            GitHub
          </a>
          <a
            className="transition-colors hover:text-foreground"
            href={RELEASES}
          >
            Releases
          </a>
        </nav>
      </footer>
    </div>
  )
}
