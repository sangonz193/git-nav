import { Channel, invoke as invokeTauri } from "@tauri-apps/api/core"

export const isDesktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window

type Args = Record<string, unknown>

const UNREACHABLE = "Could not reach the Git Nav server. Check that `git-nav serve` is running."

async function invokeHttp<T>(command: string, args: Args): Promise<T> {
  let response: Response
  try {
    response = await fetch(`/api/${command}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
    })
  } catch {
    // fetch only rejects when the request never completed, so the server is down or unreachable.
    throw new Error(UNREACHABLE)
  }

  if (!response.ok) {
    // A dev-server proxy answers with a bodyless 502 when nothing is listening behind it.
    const message = await response.text().catch(() => "")
    throw new Error(message || (response.status === 502 ? UNREACHABLE : `${command} failed (${response.status}).`))
  }

  return response.json() as Promise<T>
}

export function invoke<T>(command: string, args: Args = {}): Promise<T> {
  return isDesktop ? invokeTauri<T>(command, args) : invokeHttp<T>(command, args)
}

/**
 * Delivers batches from a long-running command: a Tauri `Channel` on desktop, Server-Sent Events in
 * the browser. Returns a disposer that stops the walk on the backend.
 */
export function stream<T>(
  command: string,
  args: Args,
  onBatch: (batch: T) => void,
  onError: (message: string) => void,
  onDone?: (data: unknown) => void
): () => void {
  if (isDesktop) {
    const channel = new Channel<T>()
    channel.onmessage = onBatch
    let disposed = false
    invokeTauri(command, { ...args, onBatch: channel })
      .then(() => {
        if (!disposed) onDone?.({})
      })
      .catch((message: unknown) => {
        if (!disposed) onError(String(message))
      })
    return () => {
      disposed = true
    }
  }

  const query = new URLSearchParams(
    Object.entries(args).map(([key, value]) => [key, String(value)])
  )
  const source = new EventSource(`/api/${command}?${query}`)
  source.addEventListener("batch", (event) => onBatch(JSON.parse(event.data) as T))
  source.addEventListener("failed", (event) => {
    source.close()
    onError(JSON.parse(event.data) as string)
  })
  source.addEventListener("done", (event) => {
    source.close()
    onDone?.(JSON.parse(event.data) as unknown)
  })
  // EventSource retries on its own, which would restart the whole walk after a clean finish.
  source.onerror = () => {
    if (source.readyState === EventSource.CLOSED) return
    source.close()
    onError(UNREACHABLE)
  }
  return () => source.close()
}
