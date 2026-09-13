import { Shot } from "@/components/shot"

export function SquashMergedBranches() {
  return (
    <>
      <p>
        A squash merge can put all of a branch's changes on main while leaving
        the original branch out of <code>git branch --merged main</code>. That
        command checks commit ancestry. The squash creates a new commit, so the
        original branch tip is still outside main's history. To clean up that
        branch, check the changes that landed or a matching merged pull request.
      </p>
      <h2 id="why-merged-misses-squashes">
        Why Git still calls the branch unmerged
      </h2>
      <p>
        Suppose <code>feature</code> contains commits B and C, and main receives
        their combined changes as S. The files can contain the same work, but S
        has a different identity and does not make C an ancestor of main. This
        is why a successful squash merge and an apparently unmerged local branch
        can coexist.
      </p>
      <pre>
        <code>{`    B---C  feature
   /
  A----S   main

  git branch --merged main`}</code>
      </pre>
      <p>
        Git's{" "}
        <a href="https://git-scm.com/docs/git-branch">branch documentation</a>{" "}
        defines <code>--merged</code> in terms of reachable tips. The{" "}
        <a href="https://git-scm.com/docs/git-merge#Documentation/git-merge.txt---squash">
          squash option
        </a>{" "}
        prepares the combined changes without recording a merge parent. Branch
        names and commit subjects cannot establish that the work landed.
      </p>
      <h2 id="check-what-landed">Check what actually landed</h2>
      <p>
        Start by fetching from your remote so the comparison uses current
        remote-tracking references. For a branch called <code>feature</code>{" "}
        targeting <code>origin/main</code>, inspect its combined patch and the
        proposed squash commit:
      </p>
      <pre>
        <code>{`git fetch origin
git diff origin/main...feature
git show <squash-commit>`}</code>
      </pre>
      <p>
        Replace <code>&lt;squash-commit&gt;</code> with the hash from the merged
        pull request or main's history. The three-dot diff starts at the merge
        base, so it can still show the branch's original changes after a squash.
        A nonempty result is not proof that the changes are missing from main.
        Compare the patches and check whether any commits were added to the
        branch after it merged.
      </p>
      <h2 id="cleanup-in-git-nav">Preview the cleanup in Git Nav</h2>
      <p>
        Git Nav is a free Git client for macOS, Windows and Linux. Its{" "}
        <strong>Clean merged branches</strong> action opens a preview grouped by
        the evidence for deleting each local branch:
      </p>
      <ul>
        <li>
          <strong>Merged pull request:</strong> the recorded pull request head
          matches the local branch tip. This uses GitHub pull request data
          through the <code>gh</code> CLI.
        </li>
        <li>
          <strong>Merged into the default branch:</strong> the branch has no
          commits outside the default branch's ancestry.
        </li>
        <li>
          <strong>Squashed into the default branch:</strong> the branch's
          content matches a candidate commit on the default branch. This local
          check can work without a pull request.
        </li>
      </ul>
      <Shot
        sizes="(max-width: 1072px) calc(100vw - 48px), 1024px"
        alt="Git Nav's branch cleanup preview, with separate groups for merged pull requests, merged branches and content-matched squash merges"
        height={1400}
        src="/screenshots/cleanup.png"
        width={2880}
      />
      <ol>
        <li>
          Open the repository and choose <strong>Clean merged branches</strong>{" "}
          from the graph toolbar.
        </li>
        <li>
          Enable the cleanup reasons you want to use. Read the branch names in
          the preview before proceeding.
        </li>
        <li>
          Choose <strong>Clean branches</strong> to delete the candidates shown
          for those options.
        </li>
      </ol>
      <h2 id="what-a-content-match-means">What a content match establishes</h2>
      <p>
        Git Nav compares tree content or the changed paths and a stable patch
        ID. This is evidence that the patch landed, not a record of the merge.
        Conflict resolution can change a patch enough to prevent a match; a
        later revert can also make a historically merged change absent from
        today's files. Inspect the comparison when deciding whether you still
        need the branch.
      </p>
      <p>
        Cleanup protects main, master and the default branch. The ancestry and
        content-matching rules also leave out branches checked out in a
        worktree; Git refuses to delete a checked-out branch. Cleanup deletes
        local branch references. A remote branch has its own lifecycle on the
        remote server.
      </p>
      <p>
        For the comparison itself, see{" "}
        <a href="/guides/compare-git-branches">
          two-dot and three-dot Git diffs
        </a>
        . If a branch is still checked out elsewhere,{" "}
        <a href="/guides/git-worktrees">find its worktree first</a>.
      </p>
    </>
  )
}
