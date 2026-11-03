import os from "os"
import path from "path"

const home = os.homedir()
const data = process.env.XDG_DATA_HOME || (home ? path.join(home, ".local", "share") : undefined)
const cache = process.env.XDG_CACHE_HOME || (home ? path.join(home, ".cache") : undefined)
const config = process.env.XDG_CONFIG_HOME || (home ? path.join(home, ".config") : undefined)
const state = process.env.XDG_STATE_HOME || (home ? path.join(home, ".local", "state") : undefined)

function codaHome() {
  const explicit = process.env.CODA_HOME?.trim()
  if (explicit) return explicit
  if (process.env.CODA_CLIENT === "coda" || process.env.OPENCODE_CLIENT === "coda") {
    return home ? path.join(home, ".coda") : undefined
  }
  return undefined
}

/** The XDG base directories that root opencode's global paths. Coda keeps its own tree under ~/.coda. */
export function roots(app: string) {
  const coda = codaHome()
  if (coda) {
    return {
      data: coda,
      cache: path.join(coda, "cache"),
      config: coda,
      state: path.join(coda, "state"),
      tmp: path.join(os.tmpdir(), "coda"),
    }
  }
  return {
    data: path.join(data!, app),
    cache: path.join(cache!, app),
    config: path.join(config!, app),
    state: path.join(state!, app),
    tmp: path.join(os.tmpdir(), app),
  }
}
