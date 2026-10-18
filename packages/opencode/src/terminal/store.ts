import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { createHash, randomUUID } from "node:crypto"

export type Status = "starting" | "running" | "completed" | "failed" | "cancelled" | "interrupted"
export type Info = {
  id: string
  ownerID: string
  directory: string
  sessionID: string
  rootSessionID: string
  rootTurnID?: string
  messageID: string
  turnID: string
  callID: string
  command: string
  cwd: string
  shell: string
  startedAt: number
  lastOutputAt: number
  endedAt?: number
  status: Status
  pid?: number
  backendPID?: number
  exitCode?: number
  reason?: string
  cursor: number
  baseCursor: number
  segments: { name: string; start: number; size: number }[]
}
export type Control = {
  needsInput?: boolean
  nextCheckAt?: number
  consumed?: boolean
  suppressed?: boolean
  hidden?: boolean
  error?: string
}
export type Settings = { taskRecovery?: "auto" | "manual"; stopBehavior?: "all" | "ai" }
export const home = () => path.resolve(process.env.CODA_HOME || path.join(os.homedir(), ".coda"))
export const root = () => path.join(home(), "terminals")
export type Owner = { id: string; pid: number; at: number; exiting: boolean }
export function owner() {
  const value = json<Owner>(path.join(home(), "runtime", "desktop.json"))
  if (!value || value.exiting) throw new Error("Coda desktop is not running or is exiting")
  try {
    process.kill(value.pid, 0)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") throw new Error("Coda desktop is no longer running")
  }
  return value
}
export const active = (info: Info) => info.status === "starting" || info.status === "running"
export function taskDir(id: string) {
  if (!/^term_[a-f0-9]{32}$/.test(id)) throw new Error("Invalid terminal ID")
  return path.join(root(), id)
}
export function atomic(file: string, value: unknown) {
  const tmp = `${file}.${randomUUID()}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 })
  fs.renameSync(tmp, file)
}
export function json<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}
export const settings = () => json<Settings>(path.join(home(), "settings.json")) ?? {}
export const read = (id: string) => json<Info>(path.join(taskDir(id), "info.json"))
export const control = (id: string) => json<Control>(path.join(taskDir(id), "control.json")) ?? {}
export function update(id: string, patch: Partial<Control>) {
  atomic(path.join(taskDir(id), "control.json"), { ...control(id), ...patch })
}
export function list(directory?: string, sessionID?: string) {
  fs.mkdirSync(root(), { recursive: true, mode: 0o700 })
  return fs
    .readdirSync(root())
    .filter((id) => /^term_[a-f0-9]{32}$/.test(id))
    .flatMap((id) => {
      const info = read(id)
      return info &&
        (!directory || info.directory === path.resolve(directory)) &&
        (!sessionID || info.sessionID === sessionID || info.rootSessionID === sessionID)
        ? [{ ...info, ...control(id) }]
        : []
    })
    .sort((a, b) => a.startedAt - b.startedAt)
}
export function idFor(sessionID: string, callID: string) {
  return "term_" + createHash("sha256").update(`${sessionID}\0${callID}`).digest("hex").slice(0, 32)
}
export function log(info: Info, cursor?: number, limit = 64 * 1024) {
  const requested = cursor ?? Math.max(info.baseCursor, info.cursor - limit)
  let at = Math.max(info.baseCursor, Math.min(info.cursor, requested))
  const start = at
  const chunks: Buffer[] = []
  let left = Math.min(limit, 256 * 1024)
  for (const segment of info.segments) {
    if (!left || segment.start + segment.size <= at) continue
    const offset = Math.max(0, at - segment.start)
    const size = Math.min(segment.size - offset, left)
    if (size <= 0) continue
    let fd: number | undefined
    try {
      fd = fs.openSync(path.join(taskDir(info.id), segment.name), "r")
      const bytes = Buffer.alloc(size)
      const n = fs.readSync(fd, bytes, 0, size, offset)
      chunks.push(bytes.subarray(0, n))
      at = segment.start + offset + n
      left -= n
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    } finally {
      if (fd !== undefined) fs.closeSync(fd)
    }
  }
  return {
    data: Buffer.concat(chunks).toString("base64"),
    start,
    cursor: at,
    baseCursor: info.baseCursor,
    endCursor: info.cursor,
    truncated: requested < info.baseCursor,
  }
}
export function cleanup() {
  for (const info of list())
    if (!active(info) && info.endedAt && Date.now() - info.endedAt > 7 * 86400_000)
      fs.rmSync(taskDir(info.id), { recursive: true, force: true })
}

export type Run = {
  sessionID: string
  ownerID: string
  turnID: string
  backendID: string
  active: boolean
  suppressed?: boolean
}
function runPath(sessionID: string) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionID)) throw new Error("Invalid session ID")
  const folder = path.join(home(), "runs")
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 })
  return path.join(folder, `${sessionID}.json`)
}
export const run = (sessionID: string) => json<Run>(runPath(sessionID))
export function saveRun(value: Run) {
  atomic(runPath(value.sessionID), value)
}
