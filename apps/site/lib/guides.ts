export const guides = [
  {
    slug: "delete-squash-merged-branches",
    title: "Delete squash-merged Git branches",
    description:
      "Why git branch --merged misses squash merges, how to check what landed, and how Git Nav previews local branches for cleanup.",
    summary:
      "Find the branches a squash merge left behind, with a reason for every cleanup candidate.",
    updated: "2026-09-12",
    image: "/screenshots/cleanup.png",
  },
  {
    slug: "git-worktrees",
    title: "Use Git worktrees with a Git GUI",
    description:
      "Work on multiple Git branches in separate directories. Create a worktree, find it in Git Nav, and keep each worktree's staged changes separate.",
    summary:
      "Keep a feature open while you review or fix another branch in its own directory.",
    updated: "2026-09-12",
    image: "/screenshots/graph-collapsed.png",
  },
  {
    slug: "compare-git-branches",
    title: "Compare Git branches: two dots vs. three dots",
    description:
      "Choose between comparing branch tips and comparing from the merge base. Read Git diffs between branches, tags or commits in Git Nav.",
    summary:
      "Choose the comparison that answers your question, then keep track of the files you have read.",
    updated: "2026-09-12",
    image: "/screenshots/diff.png",
  },
  {
    slug: "stage-and-commit",
    title: "Stage and commit changes in a Git GUI",
    description:
      "Understand staged and unstaged changes, review a partially staged file, and commit through Git Nav using the same Git index as your terminal.",
    summary:
      "Review what will go into a commit while keeping the GUI and terminal in sync.",
    updated: "2026-09-12",
    image: "/screenshots/working-tree.png",
  },
] as const
