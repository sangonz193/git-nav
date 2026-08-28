# Git Nav

## Install

```sh
npm install --global git-nav
git nav .
```

The `git-nav` executable is distributed through the `git-nav` npm package, with platform binaries published as `@git-nav/*` optional dependencies.

## Browser access

`git-nav serve` runs the same app over HTTP, so you can reach your repositories from a tablet or another machine:

```sh
git-nav serve --host 0.0.0.0
```

It prints a URL containing a generated token; open that once and the token is stored as a cookie. Pass `--token` to pin a known value, `--port` to change the port (default 4300), or `--no-token` to disable authentication.

Repositories, worktrees and recently opened projects are read from the machine running the server, and the recent list is shared with the desktop app. Branch deletion and rebasing are exposed over the network, so leave authentication on unless the port is already protected.

Two things differ from the desktop app. Worktrees never show as open, because the server has no windows to track. Copying a commit hash needs a secure context, so it works over HTTPS or `localhost` but not over plain HTTP to another device.

## Development

```sh
bun install
bun run dev
```

`bun run dev` and `bun run tauri dev` only serve the frontend; the HTTP API lives in `git-nav serve`. To work on the browser build from another device, start both:

```sh
bun run dev:web
```

That runs the API server and the dev server together, so hot reloading works from a phone or tablet. The dev server proxies `/api` to `http://127.0.0.1:4300`; set `GIT_NAV_SERVER` to point it somewhere else.

Build the app and package the current platform binary with:

```sh
bun run build:package
```

See [the deployment guide](docs/deploy.md) for CI releases.

## Adding components

To add components to your app, run the following command at the root of your `web` app:

```bash
bunx --bun shadcn@latest add button -c apps/desktop
```

This will place the ui components in the `packages/shadcn/src/components` directory.

## Using components

To use the components in your app, import them from the `ui` package.

```tsx
import { Button } from "@workspace/shadcn/components/button";
```
