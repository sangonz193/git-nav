import { Shot } from "@/components/shot"

export function CompareGitBranches() {
  return (
    <>
      <p>
        To compare the files at two Git branch tips, use{" "}
        <code>git diff main feature</code> or{" "}
        <code>git diff main..feature</code>. To review the changes on feature
        since its common ancestor with main, use{" "}
        <code>git diff main...feature</code>. Git Nav supports both comparisons
        between branches, tags, commits and revisions.
      </p>
      <h2 id="choose-the-comparison">Choose the question before the diff</h2>
      <div
        aria-label="Git comparison commands"
        className="table-scroll"
        role="region"
        tabIndex={0}
      >
        <table>
          <caption className="sr-only">
            Git branch comparison commands and when to use them
          </caption>
          <thead>
            <tr>
              <th scope="col">Question</th>
              <th scope="col">Command</th>
              <th scope="col">Compared endpoints</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>How do the branches' files differ now?</td>
              <td>
                <code>git diff main..feature</code>
              </td>
              <td>The tip of main and the tip of feature.</td>
            </tr>
            <tr>
              <td>What changed on feature since the branches diverged?</td>
              <td>
                <code>git diff main...feature</code>
              </td>
              <td>The merge base and the tip of feature.</td>
            </tr>
            <tr>
              <td>What changed between releases?</td>
              <td>
                <code>git diff v1.0.0 v1.1.0</code>
              </td>
              <td>The two tagged snapshots.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        A two-dot diff compares snapshots, so it also reflects work that exists
        only on main. A three-dot diff uses the merge base for the left side.
        Swapping the sides changes which branch's work the three-dot form shows.
        These meanings belong to <code>git diff</code>; the same dot notation
        has different semantics in <code>git log</code>.
      </p>
      <h2 id="a-diverged-branch">An example with a diverged branch</h2>
      <p>
        Suppose both branches started at A. Main then changed the README, while
        feature changed a function. Comparing the tips shows both differences:
        the function edit and the README difference. Comparing from the merge
        base to feature shows the function edit without treating main's newer
        README as a change made on feature.
      </p>
      <pre>
        <code>{`git diff main..feature
git diff main...feature`}</code>
      </pre>
      <p>
        Replace the example names with your own refs. To compare against the
        latest fetched default branch, fetch first and use{" "}
        <code>origin/main</code>. Git comparisons read the references you have
        locally.
      </p>
      <h2 id="compare-in-git-nav">Read the comparison in Git Nav</h2>
      <ol>
        <li>
          Open a diff tab and choose a branch, tag, commit or revision on each
          side.
        </li>
        <li>
          Select a direct comparison or a comparison from the merge base,
          depending on the question above.
        </li>
        <li>
          Use split or unified layout and the file tree to move through the
          patch. Hide whitespace changes when they distract from the edit you
          need to read.
        </li>
        <li>
          Mark a file as viewed after reading it, then filter to the files you
          have left.
        </li>
      </ol>
      <Shot
        sizes="(max-width: 1072px) calc(100vw - 48px), 1024px"
        alt="Git Nav comparing two release tags with a file tree, split diff and Viewed control"
        height={1560}
        src="/screenshots/diff.png"
        width={2880}
      />
      <p>
        Viewed state is tied to the patch you read. If a rebase or force push
        changes a file's patch, it becomes unread again. Images have before and
        after previews with dimensions, so a review can include visual changes
        alongside text.
      </p>
      <h2 id="branch-details">
        Check divergence without checking out the branch
      </h2>
      <p>
        Selecting a branch in the graph opens its details: the tip, upstream,
        pull request when available, and ahead and behind counts. Those counts
        measure commits. The diff answers the separate question of how file
        contents changed.
      </p>
      <p>
        After a squash merge, a branch can still have commits outside main even
        when its patch landed. Use the{" "}
        <a href="/guides/delete-squash-merged-branches">
          squash-merged branch guide
        </a>{" "}
        to understand that case before deleting it. To compare changes that you
        have not committed yet, use the{" "}
        <a href="/guides/stage-and-commit">working tree tab</a>.
      </p>
      <p>
        The <a href="https://git-scm.com/docs/git-diff">Git diff manual</a>{" "}
        documents the endpoint and merge-base forms.
      </p>
    </>
  )
}
