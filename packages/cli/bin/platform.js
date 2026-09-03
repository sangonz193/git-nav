export const binaryPaths = new Map([
  ["darwin-arm64", "Git Nav.app/Contents/MacOS/git-nav"],
  ["darwin-x64", "Git Nav.app/Contents/MacOS/git-nav"],
  ["linux-arm64", "git-nav.AppImage"],
  ["linux-x64", "git-nav.AppImage"],
  ["win32-arm64", "git-nav.exe"],
  ["win32-x64", "git-nav.exe"],
]);

export function binaryPathFor(platform, arch) {
  return binaryPaths.get(`${platform}-${arch}`);
}
