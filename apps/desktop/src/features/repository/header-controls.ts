// Dockview mounts the header actions once per dock group, so app-global controls
// render only in the active group to keep a single instance of them and their dialogs.
export function repositoryHeaderControls({
  desktop,
  isGroupActive,
  location,
}: {
  desktop: boolean
  isGroupActive: boolean
  location?: { type: string }
}) {
  return {
    appMenu: isGroupActive && (!location || location.type === "grid"),
    sharingIndicator: desktop && isGroupActive,
  }
}
