# Deploying

Releases are triggered by pushing a version tag. The tag and these version fields must match:

- `packages/cli/package.json`
- `apps/desktop/src-tauri/Cargo.toml`
- `apps/desktop/src-tauri/tauri.conf.json`
- `packages/cli/package.json` optional dependencies

Before the first CI release, configure npm trusted publishing for each published package:

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
