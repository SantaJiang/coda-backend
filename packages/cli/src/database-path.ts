import path from "node:path"
import { OPENCODE_CHANNEL } from "./version"

export function databasePath(data: string) {
  const channel = process.env.CODA_CHANNEL || process.env.OPENCODE_CHANNEL || OPENCODE_CHANNEL
  const filename =
    process.env.CODA_DB ??
    process.env.OPENCODE_DB ??
    (["latest", "dev", "beta", "next", "prod"].includes(channel) ||
    process.env.CODA_DISABLE_CHANNEL_DB === "1" ||
    process.env.CODA_DISABLE_CHANNEL_DB === "true" ||
    process.env.OPENCODE_DISABLE_CHANNEL_DB === "1" ||
    process.env.OPENCODE_DISABLE_CHANNEL_DB === "true"
      ? "opencode.db"
      : `opencode-${channel.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`)
  return filename === ":memory:" ? filename : path.resolve(data, filename)
}
