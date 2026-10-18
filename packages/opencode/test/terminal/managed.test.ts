import { afterAll, beforeAll, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"
import * as Client from "../../src/terminal/client"
import * as Store from "../../src/terminal/store"

let temporary: Awaited<ReturnType<typeof tmpdir>>
const previous = process.env.CODA_HOME
let heartbeat: ReturnType<typeof setInterval>
const owner = () =>
  Store.atomic(path.join(Store.home(), "runtime", "desktop.json"), {
    id: "terminal-test",
    pid: process.pid,
    at: Date.now(),
    exiting: false,
  })
beforeAll(async () => {
  temporary = await tmpdir()
  process.env.CODA_HOME = temporary.path
  fs.mkdirSync(path.join(temporary.path, "runtime"), { recursive: true })
  owner()
  heartbeat = setInterval(owner, 1000)
})
afterAll(async () => {
  clearInterval(heartbeat)
  await Client.shutdown()
  if (previous === undefined) delete process.env.CODA_HOME
  else process.env.CODA_HOME = previous
  await temporary[Symbol.asyncDispose]()
})
const command = (command: string, key: string, timeout?: number) =>
  Client.start({
    command,
    callID: key,
    sessionID: "ses_test",
    rootSessionID: "ses_test",
    messageID: "msg_test",
    turnID: "msg_user",
    directory: temporary.path,
    cwd: temporary.path,
    shell: process.platform === "win32" ? "cmd.exe" : "/bin/sh",
    env: process.env,
    timeout,
  })
const output = (info: Store.Info) => Buffer.from(Store.log(info, 0).data, "base64").toString("utf8")

test("quick completion returns without exhausting its wait and retains unicode output", async () => {
  if (process.platform === "win32") return
  const info = await command("printf '你好 terminal\\n'", "quick")
  const before = Date.now()
  const done = await Client.wait(info.id, 5000)
  expect(Date.now() - before).toBeLessThan(3000)
  expect(done.status).toBe("completed")
  expect(output(done)).toContain("你好 terminal")
})
test("a check interval expiring does not kill the process and duplicate starts reuse the PID", async () => {
  if (process.platform === "win32") return
  const info = await command("printf first; sleep 0.4; printf second", "long")
  const checked = await Client.wait(info.id, 1)
  expect(checked.status).toBe("running")
  expect(Store.control(info.id).nextCheckAt).toBeUndefined()
  const duplicate = await command("printf should-not-execute", "long")
  expect(duplicate.pid).toBe(info.pid)
  const done = await Client.wait(info.id, 3000)
  expect(output(done)).toContain("firstsecond")
  expect(output(done)).not.toContain("should-not-execute")
})
test("aborting a wait leaves its command running, and cancellation is idempotent", async () => {
  if (process.platform === "win32") return
  const info = await command("sleep 30", "abort")
  const abort = new AbortController()
  const waiting = Client.wait(info.id, 10000, abort.signal)
  abort.abort(new Error("stop waiting"))
  await expect(waiting).rejects.toThrow("stop waiting")
  expect((await Client.refresh(info.id)).status).toBe("running")
  const cancelled = await Promise.all([Client.cancel(info.id), Client.cancel(info.id)])
  expect(cancelled.map((item) => item.status)).toEqual(["cancelled", "cancelled"])
  expect((await Client.cancel(info.id)).status).toBe("cancelled")
})
test("explicit timeout and non-zero exit remain failures", async () => {
  if (process.platform === "win32") return
  const timed = await command("sleep 30", "timeout", 50)
  const expired = await Client.wait(timed.id, 5000)
  expect(expired.status).toBe("failed")
  expect(expired.reason).toContain("explicit timeout")
  const bad = await command("printf error; exit 7", "exit")
  const done = await Client.wait(bad.id, 3000)
  expect(done.exitCode).toBe(7)
  expect(done.status).toBe("failed")
})
test("incremental output cursors neither drop nor repeat bytes", async () => {
  if (process.platform === "win32") return
  const info = await command("printf '中文abcdef'", "cursor")
  const done = await Client.wait(info.id, 3000)
  const chunks: Buffer[] = []
  let cursor = 0
  while (cursor < done.cursor) {
    const frame = Store.log(done, cursor, 2)
    chunks.push(Buffer.from(frame.data, "base64"))
    cursor = frame.cursor
  }
  expect(Buffer.concat(chunks).toString("utf8").trim()).toBe("中文abcdef")
})
test("stale persisted running entries are interrupted without replaying their command", async () => {
  const id = Store.idFor("ses_test", "stale")
  fs.mkdirSync(Store.taskDir(id))
  const info: Store.Info = {
    id,
    ownerID: "earlier-app",
    sessionID: "ses_test",
    rootSessionID: "ses_test",
    messageID: "msg_test",
    turnID: "msg_user",
    callID: "stale",
    directory: temporary.path,
    cwd: temporary.path,
    shell: "/bin/sh",
    command: "must never execute",
    status: "running",
    startedAt: Date.now(),
    lastOutputAt: Date.now(),
    cursor: 0,
    baseCursor: 0,
    segments: [],
  }
  Store.atomic(path.join(Store.taskDir(id), "info.json"), info)
  expect((await Client.refresh(id)).status).toBe("interrupted")
  expect((await command("must never execute", "stale")).status).toBe("interrupted")
})
test("only-stop-AI suppresses continuation without cancelling the command", async () => {
  if (process.platform === "win32") return
  const info = await command("sleep 30", "suppress")
  await Client.stopSession(temporary.path, "ses_test", false, "msg_user")
  expect((await Client.refresh(info.id)).status).toBe("running")
  expect(Store.control(info.id).suppressed).toBe(true)
  await Client.cancel(info.id)
})

test("cancelling a shell also kills descendants which ignore TERM", async () => {
  if (process.platform === "win32") return
  const info = await command("sh -c 'trap \"\" TERM; echo child-$$; while :; do sleep 1; done' & wait", "tree")
  const deadline = Date.now() + 3000
  let pid = 0
  while (!pid && Date.now() < deadline) {
    const frame = await Client.refresh(info.id)
    pid = Number(output(frame).match(/child-(\d+)/)?.[1])
    if (!pid) await Bun.sleep(20)
  }
  expect(pid).toBeGreaterThan(0)
  await Client.cancel(info.id)
  expect(() => process.kill(pid, 0)).toThrow()
}, 10000)

test("interactive prompts are surfaced without silently terminating the command", async () => {
  if (process.platform === "win32") return
  const info = await command("printf 'Password: '; sleep 30", "interactive")
  const deadline = Date.now() + 2000
  while (!Store.control(info.id).needsInput && Date.now() < deadline) await Bun.sleep(20)
  expect(Store.control(info.id).needsInput).toBe(true)
  expect((await Client.refresh(info.id)).status).toBe("running")
  await Client.cancel(info.id)
})

test("fast commands cannot exit before their output and exit listeners are installed", async () => {
  if (process.platform === "win32") return
  for (let n = 0; n < 30; n++) {
    const info = await command("printf fast-result", `fast-${n}`)
    const done = await Client.wait(info.id, 1000)
    expect(done.status).toBe("completed")
    expect(output(done)).toContain("fast-result")
  }
}, 15000)

test("disk logs rotate at 100 MiB and stale cursors explicitly report truncation", async () => {
  if (process.platform === "win32") return
  const info = await command("head -c 106954752 /dev/zero | tr '\\000' x", "rotation")
  const done = await Client.wait(info.id, 20000)
  expect(done.status).toBe("completed")
  expect(done.cursor).toBeGreaterThan(100 * 1024 * 1024)
  expect(done.cursor - done.baseCursor).toBeLessThanOrEqual(100 * 1024 * 1024)
  const frame = Store.log(done, 0, 24 * 1024)
  expect(frame.truncated).toBe(true)
  expect(frame.start).toBe(done.baseCursor)
  expect(Buffer.from(frame.data, "base64").length).toBe(24 * 1024)
  expect(done.segments.length).toBeLessThanOrEqual(100)
}, 25000)
