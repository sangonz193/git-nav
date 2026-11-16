import { toast } from "@workspace/shadcn/components/sonner"

// Git output can run long, so failures stay until dismissed instead of timing out mid-read.
export function showErrorToast(title: string, reason?: unknown) {
  toast.error(title, {
    closeButton: true,
    description: reason === undefined ? undefined : String(reason),
    duration: Infinity,
  })
}
