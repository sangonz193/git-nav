import Image from "next/image"

export function Shot({
  alt,
  caption,
  height,
  priority,
  src,
  width,
}: {
  alt: string
  caption?: string
  height: number
  priority?: boolean
  src: string
  width: number
}) {
  return (
    <figure className="space-y-3">
      <div className="overflow-hidden rounded-xl border border-border bg-card shadow-2xl shadow-black/40">
        <Image
          alt={alt}
          height={height}
          priority={priority}
          src={src}
          width={width}
        />
      </div>
      {caption && (
        <figcaption className="text-sm text-muted-foreground">
          {caption}
        </figcaption>
      )}
    </figure>
  )
}
