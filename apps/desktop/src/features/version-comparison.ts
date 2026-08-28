function versionParts(version: string) {
  const [release] = version.trim().replace(/^v/, "").split("-")
  return release.split(".").map((part) => Number.parseInt(part, 10) || 0)
}

export function compareVersions(left: string, right: string) {
  const leftParts = versionParts(left)
  const rightParts = versionParts(right)
  const length = Math.max(leftParts.length, rightParts.length)

  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    if (difference !== 0) return difference > 0 ? 1 : -1
  }

  return 0
}
