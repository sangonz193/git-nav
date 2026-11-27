import { describe, expect, test } from "bun:test"

import {
  commitSelection,
  displayRefs,
  refSelection,
  type BranchSync,
  type Commit,
  type Selection,
} from "./commit-graph"
import {
  applicableOperations,
  initialValues,
  labelText,
  OPERATION_GROUPS,
  operationTitle,
  resolveFields,
  selectionLabel,
  type Operand,
  type OperationState,
  type RepositoryState,
} from "./commit-operations"

function commit(
  hash: string,
  parents: string[] = [],
  refs: string[] = [],
): Commit {
  return {
    hash,
    parents,
    author: "Ada",
    date: "2026-01-01T00:00:00Z",
    refs,
    subject: hash,
    lane: 0,
    parentLanes: [],
    laneCount: 1,
    incomingLanes: [],
    activeLanes: [],
  }
}

const history = [
  commit("a", ["b"], ["HEAD -> refs/heads/main", "refs/remotes/origin/main"]),
  commit("b", ["c"], ["refs/heads/topic"]),
  commit("c", ["d"], ["tag: refs/tags/v1.0.0"]),
  commit("d"),
]

const repository: RepositoryState = {
  currentBranch: "main",
  defaultBranch: "origin/main",
  headSha: "a",
  isDetached: false,
  isDirty: false,
  pendingOperation: null,
  remote: "origin",
  remotes: ["origin"],
}

function ref(labels: string[], sha: string, sync?: BranchSync) {
  const [entry] = displayRefs(labels, {
    branchSync: sync ? new Map([[sync.branch, sync]]) : undefined,
  })
  return refSelection(entry, sha)
}

function ids(source: Selection | null, target: Operand) {
  return applicableOperations(repository, source, target).map(
    ({ operation }) => operation.id,
  )
}

const IDLE: OperationState = { branch: null, mergeBase: null, prediction: null }

function planOf(state: RepositoryState, target: Operand, id: string) {
  const entry = applicableOperations(state, null, target).find(
    ({ operation }) => operation.id === id,
  )
  return entry ? entry.operation.plan(entry.request, {}, IDLE) : null
}

function entryFor(source: Selection | null, target: Operand, id: string) {
  return applicableOperations(repository, source, target).find(
    ({ operation }) => operation.id === id,
  )!
}

function labelOf(source: Selection | null, target: Operand, id: string) {
  const entry = applicableOperations(repository, source, target).find(
    ({ operation }) => operation.id === id,
  )
  return entry ? labelText(entry.operation.label(entry.request)) : null
}

function titleOf(source: Selection | null, target: Operand, id: string) {
  const entry = applicableOperations(repository, source, target).find(
    ({ operation }) => operation.id === id,
  )
  return entry ? operationTitle(entry.operation, entry.request) : null
}

function unavailableOf(source: Selection | null, target: Operand, id: string) {
  const unavailable = applicableOperations(repository, source, target).find(
    ({ operation }) => operation.id === id,
  )?.unavailable
  return unavailable ? labelText(unavailable) : unavailable
}

const topic = ref(["refs/heads/topic"], "b")
const tag = ref(["tag: refs/tags/v1.0.0"], "c")
const remote = ref(["refs/remotes/origin/release"], "b")
const orphanedRemote = ref(["refs/remotes/pr/110"], "b")
const range = commitSelection(history, 1, 2)!

describe("applicableOperations", () => {
  test("offers branch operations on a local branch", () => {
    expect(ids(null, topic)).toEqual([
      "checkout",
      "push",
      "mergeIntoCurrent",
      "createBranch",
      "createTag",
      "renameBranch",
      "resetCurrent",
      "deleteBranch",
    ])
  })

  test("does not offer to check out the branch that is already checked out", () => {
    expect(ids(null, ref(["HEAD -> refs/heads/main"], "a"))).not.toContain(
      "checkout",
    )
  })

  test("drops the operations a tag cannot take part in", () => {
    const offered = ids(null, tag)

    expect(offered).not.toContain("push")
    expect(offered).not.toContain("renameBranch")
    expect(offered).not.toContain("deleteBranch")
    expect(offered).toContain("deleteTag")
    expect(offered).toContain("pushTag")
  })

  test("offers a remote branch its own delete rather than the local one", () => {
    const offered = ids(null, remote)

    expect(offered).toContain("deleteRemoteRef")
    expect(offered).not.toContain("deleteOrphanedRemoteRef")
    expect(offered).not.toContain("deleteBranch")
    expect(offered).not.toContain("renameBranch")
  })

  test("offers to delete the local copy of a ref whose remote is missing", () => {
    const offered = ids(null, orphanedRemote)

    expect(offered).toContain("deleteOrphanedRemoteRef")
    expect(offered).not.toContain("deleteBranch")
    expect(offered).not.toContain("deleteRemoteRef")
  })

  test("rebases a selected range onto the clicked ref", () => {
    expect(labelOf(range, tag, "rebaseOnto")).toBe("Rebase onto here")
    expect(titleOf(range, tag, "rebaseOnto")).toBe(
      "Rebase topic (2 commits) onto v1.0.0",
    )
  })

  test("refuses to move a tag onto something else", () => {
    expect(ids(tag, topic)).not.toContain("rebaseOnto")
  })

  test("merges the selection into the clicked branch", () => {
    expect(
      labelOf(topic, ref(["refs/heads/main"], "a"), "mergeSelectedHere"),
    ).toBe("Merge here")
    expect(
      titleOf(topic, ref(["refs/heads/main"], "a"), "mergeSelectedHere"),
    ).toBe("Merge topic into main")
  })

  test("merges into the current branch whether or not something is selected", () => {
    expect(labelOf(null, topic, "mergeIntoCurrent")).toBe("Merge into main")
    expect(titleOf(null, topic, "mergeIntoCurrent")).toBe(
      "Merge topic into main",
    )
    expect(ids(tag, topic)).toEqual(
      expect.arrayContaining(["mergeSelectedHere", "mergeIntoCurrent"]),
    )
  })

  test("names the selection the selection group acts with", () => {
    expect(selectionLabel(topic)).toEqual({ kind: "branch", name: "topic" })
    expect(selectionLabel(range)).toEqual({
      before: "2 commits on ",
      kind: "branch",
      name: "topic",
    })
  })

  test("offers commit operations on a selected range", () => {
    const offered = ids(range, range)

    expect(offered).toContain("dropCommits")
    expect(entryFor(range, range, "dropCommits").operation.group).toBe("danger")
    expect(offered).toContain("cherryPick")
    expect(offered).toContain("revert")
    expect(offered).not.toContain("rebaseOnto")
  })

  test("only offers a stash its own operations", () => {
    const entry = {
      base: "b1",
      branch: "main",
      date: "2026-01-01T00:00:00Z",
      message: "work",
      name: "stash@{0}",
      sha: "s1",
    }

    expect(ids(null, { kind: "stash", entry })).toEqual([
      "stashApply",
      "stashPop",
      "stashDrop",
    ])
  })

  test("offers stashing only while the working tree is dirty", () => {
    expect(
      applicableOperations({ ...repository, isDirty: true }, null, {
        kind: "worktree",
      }).map(({ operation }) => operation.id),
    ).toEqual(["stashChanges"])
    expect(ids(null, { kind: "worktree" })).toEqual([])
  })
})

describe("unavailable", () => {
  test("says there is nothing to push or fast-forward when a branch matches its upstream", () => {
    const synced = ref(["refs/heads/feature"], "b", {
      branch: "feature",
      upstream: "origin/feature",
      ahead: 0,
      behind: 0,
      isGone: false,
    })

    expect(unavailableOf(null, synced, "push")).toBe("Nothing to push")
    expect(unavailableOf(null, synced, "pull")).toBe("Nothing to fast-forward")
  })

  test("says a fast-forward has nowhere to go once both sides have moved", () => {
    const diverged = ref(["refs/heads/feature"], "b", {
      branch: "feature",
      upstream: "origin/feature",
      ahead: 2,
      behind: 3,
      isGone: false,
    })

    expect(unavailableOf(null, diverged, "pull")).toBe(
      "Diverged from origin/feature",
    )
    expect(unavailableOf(null, diverged, "push")).toBe(null)
  })

  test("leaves a push and a fast-forward open when only one side has moved", () => {
    const ahead = ref(["refs/heads/feature"], "b", {
      branch: "feature",
      upstream: "origin/feature",
      ahead: 2,
      behind: 0,
      isGone: false,
    })
    const behind = ref(["refs/heads/feature"], "b", {
      branch: "feature",
      upstream: "origin/feature",
      ahead: 0,
      behind: 3,
      isGone: false,
    })

    expect(unavailableOf(null, ahead, "push")).toBe(null)
    expect(labelOf(null, ahead, "push")).toBe(
      "Push 2 commits to origin/feature",
    )
    expect(unavailableOf(null, behind, "pull")).toBe(null)
  })

  test("names the worktree that holds a branch instead of offering to check it out", () => {
    const worktree = {
      branch: "feature",
      changedFiles: 0,
      head: "b",
      isCurrent: false,
      name: "feature-tree",
      path: "/tmp/feature-tree",
      pendingOperation: null,
      untrackedFiles: 0,
    }
    const [entry] = displayRefs(["refs/heads/feature"], {
      worktrees: [worktree],
    })

    expect(unavailableOf(null, refSelection(entry, "b"), "checkout")).toBe(
      "Checked out in feature-tree",
    )
    expect(unavailableOf(null, topic, "checkout")).toBe(null)
  })
})

describe("blocks", () => {
  function blocksFor(
    source: Selection | null,
    target: Operand,
    id: string,
    values: Record<string, string> = {},
  ) {
    const entry = applicableOperations(repository, source, target).find(
      ({ operation }) => operation.id === id,
    )!
    return entry.operation
      .blocks(
        entry.request,
        { branch: null, mergeBase: null, prediction: null },
        values,
      )
      .map((block) => block.reason)
  }

  test("blocks pushing a branch the remote already has", () => {
    const synced = ref(["refs/heads/feature"], "b", {
      branch: "feature",
      upstream: "origin/feature",
      ahead: 0,
      behind: 0,
      isGone: false,
    })

    expect(blocksFor(null, synced, "push")).toEqual([
      "origin/feature already has these commits",
    ])
  })

  test("blocks a fast-forward that would need a merge", () => {
    const diverged = ref(["refs/heads/feature"], "b", {
      branch: "feature",
      upstream: "origin/feature",
      ahead: 2,
      behind: 3,
      isGone: false,
    })

    expect(blocksFor(null, diverged, "pull")).toEqual([
      "feature and origin/feature have both moved, which needs a merge or a rebase",
    ])
  })

  test("blocks rebasing a range onto a ref inside it", () => {
    expect(blocksFor(range, topic, "rebaseOnto")).toContain(
      "the target is inside the selection",
    )
  })
})

describe("menu order", () => {
  test("runs from what a click navigates to through what it destroys", () => {
    const groups = applicableOperations(repository, null, topic).map(
      ({ operation }) => OPERATION_GROUPS.indexOf(operation.group),
    )

    expect(groups).toEqual([...groups].sort((left, right) => left - right))
  })

  test("keeps every operation in a group a menu knows how to place", () => {
    const offered = applicableOperations(repository, range, topic)

    expect(
      offered.every(({ operation }) =>
        OPERATION_GROUPS.includes(operation.group),
      ),
    ).toBe(true)
  })
})

describe("deleting a remote branch", () => {
  const forked: RepositoryState = {
    ...repository,
    remotes: ["origin", "upstream"],
  }
  const remoteRef = (label: string) =>
    refSelection(displayRefs([label], { remotes: forked.remotes })[0], "b")

  test("deletes an orphaned tracking ref by its short name", () => {
    expect(
      planOf(repository, orphanedRemote, "deleteOrphanedRemoteRef"),
    ).toEqual({
      argv: ["git", "branch", "--delete", "--remotes", "--", "pr/110"],
      command: "delete_branch",
      args: { branch: "pr/110", remoteTracking: true },
    })
  })

  test("pushes the delete to the remote the ref lives on", () => {
    // The repository's primary remote is origin, so naming it here would delete the wrong branch elsewhere.
    expect(
      planOf(forked, remoteRef("refs/remotes/upstream/v1"), "deleteRemoteRef"),
    ).toEqual({
      argv: ["git", "push", "upstream", "--delete", "refs/heads/v1"],
      command: "push_ref",
      args: {
        reference: "refs/heads/v1",
        options: {
          remote: "upstream",
          force: false,
          setUpstream: false,
          delete: true,
        },
      },
    })
  })

  test("keeps a slash in the branch it deletes", () => {
    expect(
      planOf(
        forked,
        remoteRef("refs/remotes/origin/feat/graph"),
        "deleteRemoteRef",
      )?.argv,
    ).toEqual(["git", "push", "origin", "--delete", "refs/heads/feat/graph"])
  })

  test("never sees a remote HEAD, which is not shown as a ref in the first place", () => {
    expect(
      displayRefs(["refs/remotes/upstream/HEAD"], { remotes: forked.remotes }),
    ).toEqual([])
  })
})

describe("creating a local branch from a remote ref", () => {
  test.each([
    ["origin/release", true],
    ["pr/110", false],
  ] as const)("checks out a local branch from %s", (name, track) => {
    const target = ref([`refs/remotes/${name}`], "b")
    const { operation, request } = entryFor(null, target, "checkout")
    const reference = `refs/remotes/${name}`

    expect(operation.plan(request, { name: "topic" }, IDLE)).toEqual({
      argv: [
        "git",
        "switch",
        "-c",
        "topic",
        ...(track ? ["--track"] : []),
        reference,
      ],
      command: "checkout_ref",
      args: {
        reference,
        options: { create: "topic", track, detach: false, stash: false },
      },
    })
  })

  test.each([
    ["origin/release", true, true],
    ["origin/release", true, false],
    ["pr/110", false, true],
    ["pr/110", false, false],
  ] as const)(
    "creates a branch from %s with tracking %s and checkout %s",
    (name, track, checkout) => {
      const target = ref([`refs/remotes/${name}`], "b")
      const { operation, request } = entryFor(null, target, "createBranch")
      const startPoint = `refs/remotes/${name}`
      const trackArgs = track ? ["--track"] : []

      expect(
        operation.plan(
          request,
          { name: "topic", checkout: String(checkout) },
          IDLE,
        ),
      ).toEqual({
        argv:
          checkout ?
            ["git", "switch", "-c", "topic", ...trackArgs, startPoint]
          : ["git", "branch", ...trackArgs, "topic", startPoint],
        command: "create_branch",
        args: { name: "topic", startPoint, options: { checkout, track } },
      })
    },
  )
})

test("plans operations against the remote ref when a local branch shares its name", () => {
  const name = "origin/main"
  const revision = `refs/remotes/${name}`
  const local = ref([`refs/heads/${name}`], "a")
  const target = ref([revision], "b")
  const state = { ...repository, currentBranch: name }
  const merge = applicableOperations(state, null, target).find(
    ({ operation }) => operation.id === "mergeIntoCurrent",
  )!

  expect(merge.operation.plan(merge.request, {}, IDLE)).toMatchObject({
    argv: ["git", "merge", "--no-edit", revision],
    args: { source: revision, into: name },
  })
  expect(merge.operation.blocks(merge.request, IDLE, {})).toEqual([])
  expect(operationTitle(merge.operation, merge.request)).toBe(
    `Merge ${name} into ${name}`,
  )

  const mergeHere = entryFor(target, local, "mergeSelectedHere")
  expect(mergeHere.operation.plan(mergeHere.request, {}, IDLE)).toMatchObject({
    argv: ["git", "merge", "--no-edit", revision],
    args: { source: revision, into: name },
  })
  expect(mergeHere.operation.blocks(mergeHere.request, IDLE, {})).toEqual([])

  const rebase = entryFor(local, target, "rebaseOnto")
  expect(
    rebase.operation.plan(rebase.request, {}, { ...IDLE, mergeBase: "c" }),
  ).toMatchObject({
    argv: ["git", "rebase", "--onto", revision, "c", name],
    args: { onto: revision },
  })

  const reset = entryFor(null, target, "resetCurrent")
  expect(
    reset.operation.plan(reset.request, { mode: "soft" }, IDLE),
  ).toMatchObject({
    argv: ["git", "reset", "--soft", revision],
    args: { target: revision },
  })

  const tag = entryFor(null, target, "createTag")
  expect(
    tag.operation.plan(tag.request, { name: "v2", message: "" }, IDLE),
  ).toMatchObject({
    argv: ["git", "tag", "v2", revision],
    args: { target: revision },
  })
})

test.each([
  ["refs/heads/v1", "b"],
  ["refs/tags/v1", "c"],
])(
  "uses %s for revisions when a branch and tag share the same name",
  (revision, sha) => {
    const target = ref([revision], sha)

    const merge = entryFor(null, target, "mergeIntoCurrent")
    expect(merge.operation.plan(merge.request, {}, IDLE)).toMatchObject({
      argv: ["git", "merge", "--no-edit", revision],
      args: { source: revision, into: "main" },
    })
    expect(
      merge.operation.needs?.(merge.request, { mode: "fastForwardOnly" }),
    ).toMatchObject({
      mergeBase: ["refs/heads/main", revision],
      prediction: { into: "refs/heads/main", source: revision },
    })

    const rebase = entryFor(topic, target, "rebaseOnto")
    expect(
      rebase.operation.plan(rebase.request, {}, { ...IDLE, mergeBase: "d" }),
    ).toMatchObject({
      argv: ["git", "rebase", "--onto", revision, "d", "topic"],
      args: { onto: revision, upstream: "d", branch: "topic" },
    })
    expect(rebase.operation.needs?.(rebase.request, {})).toMatchObject({
      mergeBase: ["refs/heads/topic", revision],
    })

    const reset = entryFor(null, target, "resetCurrent")
    expect(
      reset.operation.plan(reset.request, { mode: "soft" }, IDLE),
    ).toMatchObject({
      argv: ["git", "reset", "--soft", revision],
      args: { target: revision },
    })

    const tag = entryFor(null, target, "createTag")
    expect(
      tag.operation.plan(tag.request, { name: "v2", message: "" }, IDLE),
    ).toMatchObject({
      argv: ["git", "tag", "v2", revision],
      args: { target: revision },
    })

    const branch = entryFor(null, target, "createBranch")
    expect(
      branch.operation.plan(branch.request, { name: "next" }, IDLE),
    ).toMatchObject({
      argv: ["git", "branch", "next", revision],
      args: { startPoint: revision },
    })

    const checkout = entryFor(null, target, "checkout")
    expect(checkout.operation.plan(checkout.request, {}, IDLE).argv).toEqual(
      target.kind === "branch" ?
        ["git", "switch", "v1"]
      : ["git", "switch", "--detach", revision],
    )
  },
)

test("publishes the branch by full ref when a tag shares its name", () => {
  const target = ref(["refs/heads/v1", "refs/tags/v1"], "b")
  const { operation, request } = entryFor(null, target, "push")

  expect(operation.plan(request, {}, IDLE)).toEqual({
    argv: ["git", "push", "--set-upstream", "origin", "refs/heads/v1"],
    command: "push_ref",
    args: {
      reference: "refs/heads/v1",
      options: {
        remote: "origin",
        force: false,
        setUpstream: true,
        delete: false,
      },
    },
  })
})

test("can merge a tag whose name matches the checked-out branch", () => {
  const target = ref(["refs/tags/main"], "b")
  const merge = entryFor(null, target, "mergeIntoCurrent")

  expect(merge.operation.blocks(merge.request, IDLE, {})).toEqual([])
  expect(merge.operation.plan(merge.request, {}, IDLE).args).toMatchObject({
    source: "refs/tags/main",
    into: "main",
  })
})

test("warns before deleting an ahead branch named like its upstream", () => {
  const target = ref(
    ["refs/heads/origin/main", "refs/remotes/origin/main"],
    "b",
    {
      branch: "origin/main",
      upstream: "origin/main",
      ahead: 1,
      behind: 0,
      isGone: false,
    },
  )
  const { operation, request } = entryFor(null, target, "deleteBranch")

  expect(target.ref.remote).toBe("origin")
  expect(operation.warnings(request, IDLE, {})).toEqual([
    { message: "origin/main has 1 commit that origin/main does not have." },
  ])
})

describe("outcome prediction", () => {
  test("asks for the commit message a squash merge needs before it can be run", () => {
    const { operation, request } = entryFor(null, topic, "mergeIntoCurrent")
    const squashing = resolveFields(operation, request, { mode: "squash" })

    expect(
      resolveFields(operation, request, {}).fields.map((field) => field.key),
    ).toEqual(["mode"])
    expect(squashing.fields.map((field) => field.key)).toEqual([
      "mode",
      "message",
    ])
    expect(squashing.values).toEqual({ mode: "squash", message: "" })
    expect(
      operation
        .blocks(request, IDLE, squashing.values)
        .map((block) => block.reason),
    ).toContain("write the commit message")
    expect(
      operation.blocks(request, IDLE, {
        ...squashing.values,
        message: "one commit",
      }),
    ).toEqual([])
  })

  test("commits the squash rather than leaving it staged", () => {
    const { operation, request } = entryFor(null, topic, "mergeIntoCurrent")
    const plan = operation.plan(
      request,
      { mode: "squash", message: " one commit " },
      IDLE,
    )

    expect(plan.argv).toEqual([
      "git",
      "merge",
      "--squash",
      "refs/heads/topic",
      "&&",
      "git",
      "commit",
      "--message",
      "one commit",
    ])
    expect(plan.args.options).toEqual({ mode: "squash", message: "one commit" })
  })

  test("keeps a message typed for a squash out of a merge that is no longer squashing", () => {
    const { operation, request } = entryFor(null, topic, "mergeIntoCurrent")
    const typed = { mode: "squash", message: "one commit" }

    expect(resolveFields(operation, request, typed).values).toEqual(typed)
    expect(
      resolveFields(operation, request, { ...typed, mode: "default" }).values,
    ).toEqual({ mode: "default" })
    expect(
      operation.plan(
        request,
        resolveFields(operation, request, { ...typed, mode: "default" }).values,
        IDLE,
      ).args.options,
    ).toEqual({ mode: "default", message: null })
  })

  test("warns that a fast-forward only merge has no fast-forward to make", () => {
    const { operation, request } = entryFor(null, topic, "mergeIntoCurrent")
    const state = {
      ...IDLE,
      branch: {
        exists: true,
        isCurrentWorktree: true,
        isDirty: false,
        pendingOperation: null,
        sha: "a",
        worktreePath: "/repo",
      },
      mergeBase: "b",
    }
    const messages = operation
      .warnings(request, state, { mode: "fastForwardOnly" })
      .map((warning) => warning.message)

    expect(messages).toEqual([
      "main has commits topic does not, so there is no fast-forward to make and Git refuses this merge.",
    ])
    expect(
      operation.warnings(
        request,
        { ...state, mergeBase: "a" },
        { mode: "fastForwardOnly" },
      ),
    ).toEqual([])
  })

  test("says where a predicted conflict leaves the repository", () => {
    const { operation, request } = entryFor(range, tag, "rebaseOnto")
    const prediction = {
      commit: "b0b0b0b0",
      files: ["shared.txt"],
      outcome: "conflicts" as const,
      subject: "work",
    }
    const warnings = operation.warnings(request, { ...IDLE, prediction }, {})

    expect(warnings[0].files).toEqual(["shared.txt"])
    expect(warnings[1].message).toBe(
      "The rebase is undone when that happens, so topic stays where it is.",
    )
  })

  test("predicts the operations that replay commits onto something else", () => {
    const needsOf = (source: Selection | null, target: Operand, id: string) => {
      const { operation, request } = entryFor(source, target, id)
      return operation.needs?.(request, initialValues(operation, request))
        ?.prediction?.kind
    }

    expect(needsOf(range, range, "cherryPick")).toBe("rebase")
    expect(needsOf(range, range, "revert")).toBe("revert")
    expect(needsOf(range, range, "dropCommits")).toBe("rebase")
    expect(needsOf(null, topic, "mergeIntoCurrent")).toBe("merge")
  })

  test("makes every offered operation answer where it lands", () => {
    const targets: [Selection | null, Operand][] = [
      [null, topic],
      [null, tag],
      [null, remote],
      [range, range],
      [range, tag],
      [
        null,
        {
          kind: "stash",
          entry: {
            base: "b1",
            branch: "main",
            date: "2026-01-01T00:00:00Z",
            message: "work",
            name: "stash@{0}",
            sha: "s1",
          },
        },
      ],
    ]

    for (const [source, target] of targets) {
      for (const { operation, request } of applicableOperations(
        { ...repository, isDirty: true },
        source,
        target,
      )) {
        expect(() =>
          operation.warnings(request, IDLE, initialValues(operation, request)),
        ).not.toThrow()
      }
    }
  })
})
