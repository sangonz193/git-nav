import { readFile } from "node:fs/promises"
import { ImageResponse } from "next/og"
import { HOME_HEADLINE } from "@/lib/site"

export const alt =
  "Git Nav: a Git client that hides the commits nobody points at"
export const size = { width: 1200, height: 630 }
export const contentType = "image/png"

function asset(file: string) {
  return readFile(new URL(file, import.meta.url))
}

export default async function Image() {
  const [regular, semibold, mono, icon] = await Promise.all([
    asset("./fonts/Geist-Regular.ttf"),
    asset("./fonts/Geist-SemiBold.ttf"),
    asset("./fonts/GeistMono-Regular.ttf"),
    asset("./icon.svg"),
  ])
  const iconSrc = `data:image/svg+xml;base64,${icon.toString("base64")}`

  return new ImageResponse(
    <div
      style={{
        background: "#0a0a0a",
        color: "#fafafa",
        display: "flex",
        flexDirection: "column",
        fontFamily: "Geist",
        height: "100%",
        justifyContent: "space-between",
        padding: 64,
        width: "100%",
      }}
    >
      <div
        style={{
          alignItems: "center",
          display: "flex",
          fontSize: 28,
          fontWeight: 600,
          gap: 16,
        }}
      >
        <img alt="" height={44} src={iconSrc} width={44} />
        Git Nav
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
        <div
          style={{
            fontSize: 68,
            fontWeight: 600,
            letterSpacing: -2,
            lineHeight: 1.05,
          }}
        >
          {HOME_HEADLINE}
        </div>
        <div
          style={{
            color: "#a1a1a1",
            fontSize: 28,
            lineHeight: 1.4,
            maxWidth: 1000,
          }}
        >
          Branches, tags, worktrees, stashes and pull request state keep their
          rows. Everything between them folds into a run that opens in place.
        </div>
      </div>
      <div
        style={{
          alignItems: "center",
          alignSelf: "flex-start",
          background: "#171717",
          border: "1px solid rgba(255,255,255,0.1)",
          borderRadius: 14,
          display: "flex",
          fontFamily: "Geist Mono",
          fontSize: 24,
          gap: 16,
          padding: "16px 24px",
        }}
      >
        <span style={{ color: "#a1a1a1" }}>$</span>
        npm install --global git-nav
      </div>
    </div>,
    {
      ...size,
      fonts: [
        { data: regular, name: "Geist", style: "normal", weight: 400 },
        { data: semibold, name: "Geist", style: "normal", weight: 600 },
        { data: mono, name: "Geist Mono", style: "normal", weight: 400 },
      ],
    },
  )
}
