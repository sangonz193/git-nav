# Git Nav

## Install

```sh
npm install --global git-nav
git nav .
```

The `git-nav` executable is distributed through the `git-nav` npm package, with platform binaries published as `@git-nav/*` optional dependencies.

## Development

```sh
bun install
bun run dev
```

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
