# Deploying

Releases are triggered by pushing a version tag. The tag and these version fields must match:

- `packages/cli/package.json`
- `apps/desktop/src-tauri/Cargo.toml`
- `apps/desktop/src-tauri/tauri.conf.json`
- `packages/cli/package.json` optional dependencies

Before tagging a release, bootstrap any platform package names that do not yet
exist, then configure npm trusted publishing for every published package. The
bootstrap command checks the registry, skips existing packages, and defaults to
a dry run. Published placeholders use the `bootstrap` dist-tag, never `latest`.
Review its output, then run it once with npm credentials that can publish to the
`@git-nav` scope:

```sh
bun run bootstrap:platform-packages
bun run bootstrap:platform-packages -- --publish
```

After the package names exist, configure trusted publishing:

```sh
npm trust github @git-nav/darwin-arm64 --file publish.yml --repo sangonz193/git-nav --allow-publish
npm trust github @git-nav/darwin-x64 --file publish.yml --repo sangonz193/git-nav --allow-publish
npm trust github @git-nav/linux-x64 --file publish.yml --repo sangonz193/git-nav --allow-publish
npm trust github @git-nav/linux-arm64 --file publish.yml --repo sangonz193/git-nav --allow-publish
npm trust github @git-nav/win32-x64 --file publish.yml --repo sangonz193/git-nav --allow-publish
npm trust github @git-nav/win32-arm64 --file publish.yml --repo sangonz193/git-nav --allow-publish
npm trust github git-nav --file publish.yml --repo sangonz193/git-nav --allow-publish
```

The workflow builds, tests, packages, and publishes `@git-nav/darwin-arm64`, `@git-nav/darwin-x64`, `@git-nav/linux-x64`, `@git-nav/linux-arm64`, `@git-nav/win32-x64`, and `@git-nav/win32-arm64` before publishing `git-nav`. Linux platform packages contain a Tauri AppImage named `git-nav.AppImage`; Windows platform packages contain `git-nav.exe`. The `git-nav` launcher runs the matching native executable directly.

Create a release tag after the version change is merged:

```sh
git tag v0.0.2
git push origin v0.0.2
```

## The site

`apps/site` is the Next.js app behind [git-nav.dev](https://git-nav.dev), deployed on Vercel from
`main`. The Vercel project sets Root Directory to `apps/site`; the framework preset is Next.js and
the workspace install runs from the repository root. `git-nav.dev` and `www.git-nav.dev` point at
it.

Screenshots under `apps/site/public/screenshots` are captured from the app itself, at a 1440 pixel
wide viewport and a device pixel ratio of 2, against a repository with tags and open pull requests.
