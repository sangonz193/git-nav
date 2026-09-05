import type { Metadata } from "next"
import type { ReactNode } from "react"

import "./globals.css"

const description =
  "A desktop app for reading Git: a commit graph carrying branches, tags, worktrees and pull request state, a diff between any two references, and a switch that folds away every commit nothing points at."

export const metadata: Metadata = {
  metadataBase: new URL("https://git-nav.dev"),
  title: "Git Nav: read Git history, worktrees and diffs",
  description,
  openGraph: {
    title: "Git Nav",
    description,
    url: "https://git-nav.dev",
    siteName: "Git Nav",
    images: ["/og.png"],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Git Nav",
    description,
    images: ["/og.png"],
  },
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="font-sans">{children}</body>
    </html>
  )
}
