import { guides } from "@/lib/guides"

export function GuideLinks({ except }: { except?: string }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {guides
        .filter((guide) => guide.slug !== except)
        .map((guide) => (
          <a
            className="group rounded-xl border border-border bg-card p-6 transition-colors hover:border-muted-foreground"
            href={`/guides/${guide.slug}`}
            key={guide.slug}
          >
            <h3 className="font-medium group-hover:underline group-hover:underline-offset-4">
              {guide.title}
            </h3>
            <p className="mt-3 text-sm text-pretty text-muted-foreground">
              {guide.summary}
            </p>
          </a>
        ))}
    </div>
  )
}
