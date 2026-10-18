import { owner } from "./store"
import { shutdown } from "./client"

// Owned sidecars must not outlive a crashed desktop, including during a model request.
export function watchDesktop() {
  if (!process.env.CODA_DESKTOP_OWNER) return
  const timer = setInterval(() => {
    try {
      if (owner().id === process.env.CODA_DESKTOP_OWNER) return
    } catch {}
    clearInterval(timer)
    void shutdown().finally(() => process.exit(0))
  }, 1000)
  timer.unref()
}
