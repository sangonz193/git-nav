const STATUS_COLORS: Record<string, string> = {
  A: "text-emerald-400",
  C: "text-violet-400",
  D: "text-rose-400",
  M: "text-blue-400",
  R: "text-violet-400",
  T: "text-amber-400",
  U: "text-rose-400",
}

export function FileStatusLetter({ letter }: { letter: string }) {
  return (
    <span
      className={`diff-file-status ${STATUS_COLORS[letter] ?? "text-muted-foreground"}`}
    >
      {letter}
    </span>
  )
}

export function FileStat({
  additions,
  deletions,
}: {
  additions: number
  deletions: number
}) {
  return (
    <span className="diff-file-stat">
      <span className="text-emerald-400">+{additions.toLocaleString()}</span>
      <span className="text-rose-400">−{deletions.toLocaleString()}</span>
    </span>
  )
}
