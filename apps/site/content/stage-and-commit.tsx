import { Shot } from "@/components/shot"

export function StageAndCommit() {
  return (
    <>
      <p>
        Git commits the contents of the index, also called the staging area. Git
        Nav's working tree tab lets you review changes, stage or unstage files,
        write a message and commit. It uses the same index as your terminal and
        editor, so you can move between them while preparing a commit.
      </p>
      <h2 id="three-versions">The three versions of a tracked file</h2>
      <ul>
        <li>
          <strong>HEAD:</strong> the version in the current commit.
        </li>
        <li>
          <strong>Index:</strong> the version prepared for the next commit.
        </li>
        <li>
          <strong>Working tree:</strong> the file you are editing on disk.
        </li>
      </ul>
      <p>
        A staged diff compares HEAD to the index. An unstaged diff compares the
        index to the working tree. Editing a file again after staging it can
        leave the same path in both groups. The next commit takes the staged
        version, not the later edits still on disk.
      </p>
      <pre>
        <code>{`git status --short
git diff
git diff --cached`}</code>
      </pre>
      <p>
        These commands show the status, unstaged patch and staged patch for the
        current worktree. A new, untracked file appears in status; plain{" "}
        <code>git diff</code> does not display its contents until Git tracks it.
      </p>
      <h2 id="prepare-a-commit">Prepare a commit in Git Nav</h2>
      <ol>
        <li>
          Open a <strong>Working tree</strong> tab. Check which worktree is
          selected in the toolbar.
        </li>
        <li>
          Read the staged and unstaged file cards. Use a file's checkbox to
          stage or unstage it.
        </li>
        <li>
          Review the staged patch as the contents of the commit you are about to
          make.
        </li>
        <li>
          Write the commit message and choose <strong>Commit</strong>.
        </li>
      </ol>
      <Shot
        sizes="(max-width: 1072px) calc(100vw - 48px), 1024px"
        alt="Git Nav's working tree tab showing staged and unstaged files beside a commit message"
        height={1560}
        src="/screenshots/working-tree.png"
        width={2880}
      />
      <p>
        Staging affects the real index immediately. If you stage a file in Git
        Nav, <code>git diff --cached</code> in that worktree shows it. If you
        stage from a terminal, the working tree tab picks up the change.
      </p>
      <h2 id="partial-staging">Work with a partially staged file</h2>
      <p>
        A single file can contain changes for more than one commit. You can use
        Git's interactive staging to select individual hunks, then return to Git
        Nav to review the result:
      </p>
      <pre>
        <code>git add -p</code>
      </pre>
      <p>
        Git Nav displays the staged and unstaged portions separately. Its file
        checkboxes operate on files: staging the remaining changes includes that
        file's current contents in the index. Keep that distinction in mind when
        preserving a partial selection made in the terminal.
      </p>
      <h2 id="worktree-and-push">Commit in one worktree, publish when ready</h2>
      <p>
        Each linked worktree has its own staging area. Select the right worktree
        in the tab or choose <strong>Stage and commit</strong> from the
        corresponding branch menu. Your edits in a different worktree stay
        associated with that checkout. See{" "}
        <a href="/guides/git-worktrees">using Git worktrees with a Git GUI</a>{" "}
        for an example.
      </p>
      <p>
        A commit records the staged snapshot in the local repository. Pushing is
        a separate operation that updates a remote. Before publishing, you can{" "}
        <a href="/guides/compare-git-branches">
          compare your branch with its base
        </a>{" "}
        to read the complete change.
      </p>
      <p>
        The <a href="https://git-scm.com/docs/git-add">Git add manual</a>{" "}
        explains index updates and interactive staging. The{" "}
        <a href="https://git-scm.com/docs/git-diff">Git diff manual</a>{" "}
        describes staged and unstaged comparisons.
      </p>
    </>
  )
}
