export function panelId(kind: "graph" | "diff") {
  const suffix = crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return `repository-${kind}-${suffix}`
}
