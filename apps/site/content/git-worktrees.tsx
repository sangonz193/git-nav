import { Shot } from "@/components/shot"

export function GitWorktrees() {
  return (
    <>
      <p>
        Git worktrees let you check out several branches from one repository
        into separate directories. Keep your feature and its uncommitted changes
        open while you review another branch or prepare a fix. Git Nav lists the
        repository's worktrees and shows which branch each holds, so you can
        move between them from a Git GUI.
      </p>
      <h2 id="worktree-vs-branch">
        A worktree is a checkout, not another branch
      </h2>
      <p>
        A branch names a commit. A worktree gives a checkout its own files, HEAD
        and staging area. Linked worktrees share the repository's objects and
        branch references, so you do not need a second clone to work on another
        branch. Staging a file in one worktree does not stage a file in another.
      </p>
      <p>
        For example, keep <code>feature</code> open in <code>project/</code> and
        put a new fix branch in <code>project-fix/</code>. The two directories
        can run different code while sharing the same repository history.
      </p>
      <h2 id="create-a-worktree">Create and inspect a worktree</h2>
      <p>
        From an existing repository with a <code>main</code> branch, create a
        new <code>fix</code> branch and check it out in a neighboring directory:
      </p>
      <pre>
        <code>{`git worktree add -b fix ../project-fix main
git worktree list
git nav ../project-fix`}</code>
      </pre>
      <p>
        Use a branch name and directory that do not already exist. To check out
        an existing branch instead, use{" "}
        <code>git worktree add ../project-review review-branch</code>. Git
        normally prevents the same branch from being checked out in two
        worktrees at once.
      </p>
      <p>
        The <code>git nav</code> command comes with the{" "}
        <a href="/download#npm">npm installation of Git Nav</a>. You can also
        open the worktree directory from the desktop app.
      </p>
      <h2 id="navigate-in-git-nav">
        Find the branch and its worktree in Git Nav
      </h2>
      <p>
        Open the repository in Git Nav to see its worktrees beside it. The
        commit graph also carries worktree markers on the corresponding
        references. Open a worktree in Git Nav, an editor, a terminal or the
        file manager from its menu.
      </p>
      <Shot
        sizes="(max-width: 1072px) calc(100vw - 48px), 1024px"
        alt="Git Nav's collapsible commit graph, keeping branch, tag and checkout references visible"
        height={1280}
        src="/screenshots/graph-collapsed.png"
        width={2880}
      />
      <p>
        When collapse is enabled, referenced commits keep their rows and the
        runs between them fold up. This makes it easier to locate the branches
        you are working on without scanning every intervening commit. Expand a
        run in place whenever you need its history.
      </p>
      <h2 id="stage-in-the-right-worktree">
        Stage changes in the right worktree
      </h2>
      <p>
        Choose <strong>Stage and commit</strong> from a checked-out branch's
        menu, or open a <strong>Working tree</strong> tab and select the
        worktree in its toolbar. The tab reads that worktree's staged and
        unstaged changes. The index it edits is the same one Git commands use
        when run in that directory.
      </p>
      <p>
        Check the toolbar's worktree before staging or committing. Each worktree
        has its own index, even though branch and tag updates are shared. The{" "}
        <a href="/guides/stage-and-commit">staging guide</a> explains how
        partially staged files appear.
      </p>
      <h2 id="finish-a-worktree">Finish with a worktree</h2>
      <p>
        Once you have committed or otherwise preserved the work you need, remove
        the linked checkout with Git:
      </p>
      <pre>
        <code>git worktree remove ../project-fix</code>
      </pre>
      <p>
        Git normally refuses removal when a worktree contains uncommitted
        changes. Removing the worktree leaves its branch in the repository.
        After the branch is merged, it can be considered separately for{" "}
        <a href="/guides/delete-squash-merged-branches">branch cleanup</a>.
      </p>
      <p>
        See the{" "}
        <a href="https://git-scm.com/docs/git-worktree">Git worktree manual</a>{" "}
        for the command's options and per-worktree behavior.
      </p>
    </>
  )
}
