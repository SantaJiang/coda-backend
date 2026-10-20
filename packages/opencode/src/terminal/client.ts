import fs from "node:fs"
import path from "node:path"
import { spawn as ptySpawn } from "@opencode-ai/core/pty/pty.bun"
import { spawnSync } from "node:child_process"
import * as Store from "./store"

type Entry = {
  info: Store.Info
  process: ReturnType<typeof ptySpawn>
  listeners: { dispose(): void }[]
  done: Promise<void>
  settle(): void
  exitCode?: number
  timer?: ReturnType<typeof setTimeout>
  killTimer?: ReturnType<typeof setTimeout>
}
const entries = new Map<string, Entry>()
const MAX_LOG = 100 * 1024 * 1024
const SEGMENT = 1024 * 1024
export const backendID = `${process.pid}-${Date.now()}`
let watcher: ReturnType<typeof setInterval> | undefined
function persist(info: Store.Info) {
  Store.atomic(path.join(Store.taskDir(info.id), "info.json"), info)
}
function kill(entry: Entry, force = false) {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(entry.process.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" })
    return
  }
  try {
    process.kill(-entry.process.pid, force ? "SIGKILL" : "SIGTERM")
  } catch {
    try {
      entry.process.kill(force ? "SIGKILL" : "SIGTERM")
    } catch {}
  }
}
function finish(entry: Entry, code?: number) {
  if (!Store.active(entry.info)) return
  try {
    Store.owner()
  } catch {
    if (!entry.info.reason) {
      const desktop = Store.json<Store.Owner>(path.join(Store.home(), "runtime", "desktop.json"))
      entry.info.reason = desktop?.exiting ? "Cancelled: Coda exited" : "Interrupted: Coda desktop disconnected"
    }
    kill(entry, true)
  }
  if (entry.timer) clearTimeout(entry.timer)
  if (entry.killTimer) {
    entry.exitCode = code
    return
  }
  entry.info.status = entry.info.reason?.startsWith("Cancelled")
    ? "cancelled"
    : entry.info.reason?.startsWith("Interrupted")
      ? "interrupted"
      : entry.info.reason
        ? "failed"
        : code === 0
          ? "completed"
          : "failed"
  entry.info.exitCode = entry.info.reason ? undefined : code
  entry.info.endedAt = Date.now()
  persist(entry.info)
  entry.settle()
  for (const listener of entry.listeners) listener.dispose()
  entries.delete(entry.info.id)
  if (!entries.size && watcher) {
    clearInterval(watcher)
    watcher = undefined
  }
}
function append(info: Store.Info, text: string) {
  const bytes = Buffer.from(text)
  for (let offset = 0; offset < bytes.length; ) {
    let segment = info.segments.at(-1)
    if (!segment || segment.size >= SEGMENT) {
      segment = { name: `output-${info.cursor}.log`, start: info.cursor, size: 0 }
      info.segments.push(segment)
    }
    const chunk = bytes.subarray(offset, offset + Math.min(SEGMENT - segment.size, bytes.length - offset))
    fs.appendFileSync(path.join(Store.taskDir(info.id), segment.name), chunk, { mode: 0o600 })
    segment.size += chunk.length
    info.cursor += chunk.length
    offset += chunk.length
    while (info.cursor - info.baseCursor > MAX_LOG && info.segments.length > 1) {
      const old = info.segments.shift()!
      info.baseCursor = old.start + old.size
      fs.rmSync(path.join(Store.taskDir(info.id), old.name), { force: true })
    }
  }
  info.lastOutputAt = Date.now()
  const plain = text.slice(-2048).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
  if (
    /(?:password|username|authentication token)\s*:|press (?:enter|return|any key)|\[(?:y\/n|yes\/no)\]|\(y\/n\)/i.test(
      plain,
    )
  )
    Store.update(info.id, { needsInput: true })
  persist(info)
}
function monitor() {
  if (watcher) return
  watcher = setInterval(() => {
    for (const entry of entries.values()) {
      try {
        if (Store.owner().id === entry.info.ownerID) {
          try {
            process.kill(entry.process.pid, 0)
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ESRCH") {
              entry.info.reason ??= "Interrupted: terminal exited without delivering its result"
              finish(entry)
            }
          }
          continue
        }
      } catch {}
      entry.info.reason = "Interrupted: Coda desktop exited"
      kill(entry, true)
      finish(entry)
    }
  }, 1000)
  watcher.unref()
}
process.once("exit", () => {
  for (const entry of entries.values()) {
    kill(entry, true)
    entry.info.reason = "Interrupted: backend exited"
    finish(entry)
  }
})
export async function refresh(id: string) {
  const entry = entries.get(id)
  let info = entry?.info ?? Store.read(id)
  if (!info) throw new Error("Terminal not found")
  if (Store.active(info) && !entry) {
    info = {
      ...info,
      status: "interrupted",
      endedAt: Date.now(),
      reason: "Interrupted: backend restarted; inspect project state before retrying",
    }
    persist(info)
  }
  return { ...info, ...Store.control(id) }
}
export async function start(
  input: Omit<
    Store.Info,
    "id" | "ownerID" | "status" | "startedAt" | "lastOutputAt" | "cursor" | "baseCursor" | "segments"
  > & { env: NodeJS.ProcessEnv; timeout?: number; wait_ms?: number },
) {
  const owner = Store.owner()
  Store.cleanup()
  const id = Store.idFor(input.sessionID, input.callID)
  fs.mkdirSync(Store.root(), { recursive: true, mode: 0o700 })
  try {
    fs.mkdirSync(Store.taskDir(id), { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    return refresh(id)
  }
  const { env, timeout, wait_ms: _, ...fields } = input
  const now = Date.now()
  const info: Store.Info = {
    ...fields,
    ownerID: owner.id,
    id,
    backendPID: process.pid,
    startedAt: now,
    lastOutputAt: now,
    status: "starting",
    cursor: 0,
    baseCursor: 0,
    segments: [],
  }
  persist(info)
  Store.update(id, { consumed: false, suppressed: false })
  try {
    Store.owner()
    const name = path
      .basename(input.shell)
      .toLowerCase()
      .replace(/\.exe$/, "")
    const args =
      name === "cmd"
        ? ["/d", "/s", "/c", "set /p _coda_ready= & " + input.command]
        : /^(pwsh|powershell)$/.test(name)
          ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$null = [Console]::ReadLine(); " + input.command]
          : ["-c", 'read -r _coda_ready; exec "$0" -c "$1"', input.shell, input.command]
    const proc = ptySpawn(input.shell, args, {
      cwd: input.cwd,
      cols: 120,
      rows: 32,
      name: "xterm-256color",
      env: Object.fromEntries(
        Object.entries({ ...env, PYTHONUNBUFFERED: env.PYTHONUNBUFFERED ?? "1", TERM: "xterm-256color", PAGER: "cat", GIT_PAGER: "cat" })
          .filter((item): item is [string, string] => typeof item[1] === "string"),
      ),
    })
    let settle!: () => void
    const done = new Promise<void>((resolve) => {
      settle = resolve
    })
    const entry: Entry = { info, process: proc, listeners: [], done, settle }
    entries.set(id, entry)
    info.pid = proc.pid
    info.status = "running"
    persist(info)
    entry.listeners.push(
      proc.onData((text) => {
        try {
          append(info, text)
        } catch (error) {
          info.reason = `Unable to save terminal output: ${error}`
          kill(entry, true)
          finish(entry)
        }
      }),
      proc.onExit(({ exitCode }) => finish(entry, exitCode)),
    )
    // bun-pty begins reading synchronously inside its constructor. Hold the command
    // at a private input gate until both callbacks are installed, so fast exits are observable.
    proc.write(process.platform === "win32" ? "\r" : "\n")
    if (timeout)
      entry.timer = setTimeout(() => {
        info.reason = `Command exceeded explicit timeout of ${timeout} ms`
        entry.killTimer = setTimeout(() => {
          kill(entry, true)
          entry.killTimer = undefined
          finish(entry, entry.exitCode)
        }, 3000)
        kill(entry)
      }, timeout)
    monitor()
    return { ...info, ...Store.control(id) }
  } catch (error) {
    info.status = "failed"
    info.endedAt = Date.now()
    info.reason = String(error)
    persist(info)
    throw error
  }
}
export async function cancel(id: string) {
  const info = await refresh(id)
  Store.update(id, { suppressed: true, nextCheckAt: undefined })
  const entry = entries.get(id)
  if (!entry || !Store.active(info)) return info
  entry.info.reason = "Cancelled by user"
  if (entry.killTimer) {
    await entry.done
    return refresh(id)
  }
  entry.killTimer = setTimeout(() => {
    kill(entry, true)
    entry.killTimer = undefined
    finish(entry, entry.exitCode)
  }, 3000)
  kill(entry)
  await entry.done
  return refresh(id)
}
export async function wait(id: string, waitMs: number, signal?: AbortSignal) {
  const deadline = Date.now() + Math.max(0, Math.min(120_000, waitMs))
  Store.update(id, { nextCheckAt: deadline })
  try {
    const entry = entries.get(id)
    if (!entry || !Store.active(entry.info) || waitMs === 0) return refresh(id)
    await new Promise<void>((resolve, reject) => {
      const complete = () => {
        clearTimeout(timer)
        signal?.removeEventListener("abort", abort)
        resolve()
      }
      const abort = () => {
        clearTimeout(timer)
        signal?.removeEventListener("abort", abort)
        reject(signal?.reason ?? new Error("Aborted"))
      }
      const timer = setTimeout(complete, Math.max(0, deadline - Date.now()))
      entry.done.then(complete)
      if (signal?.aborted) abort()
      else signal?.addEventListener("abort", abort, { once: true })
    })
    return refresh(id)
  } finally {
    Store.update(id, { nextCheckAt: undefined })
  }
}
export async function stopSession(directory: string, sessionID: string, all: boolean, turnID?: string) {
  const tasks = Store.list(directory, sessionID).filter(
    (info) => !turnID || info.turnID === turnID || info.rootTurnID === turnID,
  )
  for (const info of tasks) Store.update(info.id, { suppressed: true })
  if (all) await Promise.all(tasks.filter(Store.active).map((info) => cancel(info.id)))
}
export async function shutdown() {
  await Promise.all([...entries.keys()].map(cancel))
}
