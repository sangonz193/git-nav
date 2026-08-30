import * as React from "react"

import { cn } from "@workspace/shadcn/lib/utils"

function ButtonGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("flex w-fit items-stretch [&>*]:focus-visible:relative [&>*]:focus-visible:z-10 [&>button:not(:first-child)]:rounded-l-none [&>button:not(:last-child)]:rounded-r-none [&>button:not(:last-child)]:border-r-0", className)}
      data-slot="button-group"
      {...props}
    />
  )
}

export { ButtonGroup }
