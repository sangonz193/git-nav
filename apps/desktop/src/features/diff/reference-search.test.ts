import { describe, expect, test } from "bun:test"

import type { Commit, StashEntry } from "../commit-graph/commit-graph"
import { isDefaultBranch } from "./diff-title"
import {
  isRevisionExpression,
  searchReferences,
  type Reference,
  type ReferenceSources,
} from "./reference-search"

function commit(hash: string, subject: string, refs: string[] = []): Commit {
  return {
    hash,
    parents: [],
    author: "Ada",
    date: "2026-01-01T00:00:00Z",
    refs,
    subject,
    lane: 0,
    parentLanes: [],
    laneCount: 1,
    incomingLanes: [],
    activeLanes: [true],
  }
}

function reference(
  name: string,
  kind: Reference["kind"],
  sha: string,
  revision: string,
): Reference {
  return {
    date: "2026-01-01T00:00:00Z",
    kind,
    name,
    revision,
    sha,
    subject: `subject of ${name}`,
  }
}

const WORKTREE = {
  headDetail: "main",
  name: "git-nav",
  path: "/projects/git-nav",
}

function sources(overrides: Partial<ReferenceSources> = {}): ReferenceSources {
  return {
    allowWorktree: true,
    commits: [],
    currentWorktree: WORKTREE,
    references: [],
    revision: null,
    stashes: [],
    worktrees: [WORKTREE],
    ...overrides,
  }
}

describe("isRevisionExpression", () => {
  test("accepts what git could resolve but a name could not", () => {
    expect(
      ["HEAD~1", "main^2", "origin/main@{1}", "deadbeef"].map(
        isRevisionExpression,
      ),
    ).toEqual([true, true, true, true])
  })

  test("rejects a half-typed name", () => {
    expect(
      ["mai", "feature/log", ":worktree", ""].map(isRevisionExpression),
    ).toEqual([false, false, false, false])
  })
})

describe("searchReferences", () => {
  test("uses the same remote revision from the repository and graph for a comparison", () => {
    const revision = "refs/remotes/origin/topic"
    const [repositoryHit] = searchReferences(
      "origin/topic",
      sources({
        references: [reference("origin/topic", "remote", "aaa", revision)],
      }),
    )
    const [graphHit] = searchReferences(
      "origin/topic",
      sources({ commits: [commit("aaa", "topic", [revision])] }),
    )

    expect(repositoryHit.reference).toBe(revision)
    expect(graphHit.reference).toBe(revision)
  })

  test("recognizes the default remote branch from its picker revision", () => {
    const defaultBranch = "refs/remotes/origin/main"
    const [hit] = searchReferences(
      "origin/main",
      sources({
        references: [reference("origin/main", "remote", "aaa", defaultBranch)],
      }),
    )

    expect(hit.label).toBe("origin/main")
    expect(isDefaultBranch(hit.branch!, defaultBranch, ["origin"])).toBe(true)
  })

  test("finds a branch the graph window does not reach", () => {
    const hits = searchReferences(
      "ancient",
      sources({
        commits: [commit("aaa", "recent work")],
        references: [
          reference(
            "ancient/branch",
            "branch",
            "old-sha",
            "refs/heads/ancient/branch",
          ),
        ],
      }),
    )

    expect(hits.map((hit) => [hit.kind, hit.reference])).toEqual([
      ["branch", "refs/heads/ancient/branch"],
    ])
  })

  test("ranks refs above the commits carrying them and lists each ref once", () => {
    const hits = searchReferences(
      "release",
      sources({
        commits: [
          commit("aaa", "start the release", ["refs/heads/release"]),
          commit("bbb", "release notes"),
        ],
        references: [
          reference("release", "branch", "aaa", "refs/heads/release"),
        ],
      }),
    )

    expect(hits.map((hit) => [hit.kind, hit.reference])).toEqual([
      ["branch", "refs/heads/release"],
      ["commit", "aaa"],
      ["commit", "bbb"],
    ])
  })

  test.each([
    ["v1", "tag", "refs/tags/v1"],
    ["origin/main", "remote", "refs/remotes/origin/main"],
  ] as const)(
    "shows both refs named %s with distinct revisions",
    (name, kind, other) => {
      const local = `refs/heads/${name}`
      const commits = [
        commit("aaa", "first", [local]),
        commit("bbb", "second", [other]),
      ]
      const expected = [
        ["branch", name, local],
        [kind, name, other],
      ]

      expect(
        searchReferences(name, sources({ commits })).map((hit) => [
          hit.kind,
          hit.label,
          hit.reference,
        ]),
      ).toEqual(expected)
      expect(
        searchReferences(
          name,
          sources({
            commits,
            references: [
              reference(name, "branch", "aaa", local),
              reference(name, kind, "bbb", other),
            ],
          }),
        ).map((hit) => [hit.kind, hit.label, hit.reference]),
      ).toEqual(expected)
    },
  )

  test("offers the working tree and HEAD before anything typed narrows them away", () => {
    expect(searchReferences("", sources()).map((hit) => hit.reference)).toEqual(
      [":worktree", "HEAD"],
    )
    expect(
      searchReferences("", sources({ allowWorktree: false })).map(
        (hit) => hit.reference,
      ),
    ).toEqual(["HEAD"])
  })

  test("offers the working tree and HEAD of each worktree, pointing at that worktree", () => {
    const hits = searchReferences(
      "",
      sources({
        worktrees: [
          WORKTREE,
          {
            headDetail: "Detached head",
            name: "git-nav-fix",
            path: "/projects/git-nav-fix",
          },
        ],
      }),
    )

    expect(
      hits.map((hit) => [
        hit.reference,
        hit.label,
        hit.detail,
        hit.worktreePath,
      ]),
    ).toEqual([
      [
        ":worktree",
        "Working tree (git-nav)",
        "Uncommitted changes",
        "/projects/git-nav",
      ],
      [
        ":worktree",
        "Working tree (git-nav-fix)",
        "Uncommitted changes",
        "/projects/git-nav-fix",
      ],
      ["HEAD", "HEAD (git-nav)", "main", "/projects/git-nav"],
      ["HEAD", "HEAD (git-nav-fix)", "Detached head", "/projects/git-nav-fix"],
    ])
  })

  test("offers the current worktree's entries first so typing a name keeps it", () => {
    const other = { headDetail: "topic", name: "fix", path: "/projects/fix" }

    expect(
      searchReferences(
        "head",
        sources({ currentWorktree: other, worktrees: [WORKTREE, other] }),
      ).map((hit) => [hit.label, hit.worktreePath]),
    ).toEqual([
      ["HEAD (fix)", "/projects/fix"],
      ["HEAD (git-nav)", "/projects/git-nav"],
    ])
    expect(
      searchReferences(
        "working tree",
        sources({ currentWorktree: other, worktrees: [WORKTREE, other] }),
      ).map((hit) => hit.worktreePath),
    ).toEqual(["/projects/fix", "/projects/git-nav"])
  })

  test("offers a worktree's working tree and HEAD when its name is typed", () => {
    const other = { headDetail: "topic", name: "fix", path: "/projects/fix" }

    expect(
      searchReferences("FIX", sources({ worktrees: [WORKTREE, other] })).map(
        (hit) => [hit.label, hit.worktreePath],
      ),
    ).toEqual([
      ["Working tree (fix)", "/projects/fix"],
      ["HEAD (fix)", "/projects/fix"],
    ])
  })

  test("offers the current worktree while the others are still being read", () => {
    expect(
      searchReferences("", sources({ worktrees: [] })).map((hit) => [
        hit.label,
        hit.detail,
        hit.worktreePath,
      ]),
    ).toEqual([
      ["Working tree (git-nav)", "Uncommitted changes", "/projects/git-nav"],
      ["HEAD (git-nav)", "main", "/projects/git-nav"],
    ])
  })

  test("puts the current worktree first once the others are read and holds back its HEAD until read", () => {
    const other = { headDetail: "topic", name: "fix", path: "/projects/fix" }

    expect(
      searchReferences(
        "",
        sources({
          currentWorktree: { ...other, headDetail: null },
          worktrees: [WORKTREE, other],
        }),
      ).map((hit) => [hit.label, hit.worktreePath]),
    ).toEqual([
      ["Working tree (fix)", "/projects/fix"],
      ["Working tree (git-nav)", "/projects/git-nav"],
      ["HEAD (git-nav)", "/projects/git-nav"],
    ])
  })

  test("offers only worktree HEADs on the base side", () => {
    const hits = searchReferences(
      "",
      sources({
        allowWorktree: false,
        worktrees: [
          WORKTREE,
          { headDetail: "topic", name: "fix", path: "/fix" },
        ],
      }),
    )

    expect(hits.map((hit) => [hit.reference, hit.worktreePath])).toEqual([
      ["HEAD", "/projects/git-nav"],
      ["HEAD", "/fix"],
    ])
  })

  test("points a stash hit at the stash rather than the commit it was taken from", () => {
    const stash: StashEntry = {
      base: "aaa",
      branch: "main",
      date: "2026-01-01T00:00:00Z",
      message: "spike",
      name: "stash@{0}",
      sha: "stash-sha",
    }
    const hits = searchReferences(
      "spike",
      sources({ commits: [commit("aaa", "base commit")], stashes: [stash] }),
    )

    expect(hits.map((hit) => [hit.kind, hit.reference])).toEqual([
      ["stash", "stash-sha"],
    ])
  })

  test("leads with a resolved revision and says what it resolved to", () => {
    const hits = searchReferences(
      "HEAD~1",
      sources({ revision: { sha: "0123456789", subject: "the parent" } }),
    )

    expect(hits[0]).toEqual({
      branch: null,
      detail: "01234567 · the parent",
      kind: "revision",
      label: "HEAD~1",
      reference: "HEAD~1",
    })
  })
})
