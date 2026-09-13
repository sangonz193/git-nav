# Git Nav

[Git Nav](https://git-nav.dev) is a free, open-source Git GUI for macOS, Windows and Linux.
Explore a collapsible commit graph, compare branches, manage worktrees, stage and commit changes,
and clean up squash-merged branches. MIT licensed.

Requires Node.js 20 or later and Git on your PATH.

```sh
npm install --global git-nav
git nav .
```

This package installs the launcher and the binary for your platform. Installers are attached to
[every release](https://github.com/sangonz193/git-nav/releases/latest).

Serve the app over HTTP to reach it from another device on your network:

```sh
git-nav serve --host 0.0.0.0
```

More at [git-nav.dev](https://git-nav.dev).

## Guides

- [Delete squash-merged branches](https://git-nav.dev/guides/delete-squash-merged-branches)
- [Use Git worktrees](https://git-nav.dev/guides/git-worktrees)
- [Compare branches and tags](https://git-nav.dev/guides/compare-git-branches)
- [Stage and commit changes](https://git-nav.dev/guides/stage-and-commit)

Find desktop installers and requirements on the [download page](https://git-nav.dev/download).
