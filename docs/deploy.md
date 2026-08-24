# Deploying

Releases are triggered by pushing a version tag. The tag and these version fields must match:

- `packages/cli/package.json`
- `apps/desktop/src-tauri/Cargo.toml`
- `apps/desktop/src-tauri/tauri.conf.json`
- `packages/cli/package.json` optional dependencies

Before the first CI release, configure npm trusted publishing for each published package:

```sh
npm trust github @git-nav/darwin-arm64 --file publish.yml --repo sangonz193/git-nav --allow-publish
npm trust github git-nav --file publish.yml --repo sangonz193/git-nav --allow-publish
```

The workflow builds and publishes `@git-nav/darwin-arm64` before `git-nav`. Add a platform package and trusted-publisher configuration before adding another platform to a release.

Create a release tag after the version change is merged:

```sh
git tag v0.0.2
git push origin v0.0.2
```
