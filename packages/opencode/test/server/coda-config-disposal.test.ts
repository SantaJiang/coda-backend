import { expect, test } from "bun:test"
import { Server } from "../../src/server/server"
import { InstanceRuntime } from "../../src/project/instance-runtime"
import { registerDisposer } from "../../src/effect/instance-registry"
import { tmpdir, disposeAllInstances } from "../fixture/fixture"

test("config acknowledgement waits for instance disposal before accepting the next prompt", async () => {
  await using temporary = await tmpdir()
  await InstanceRuntime.load({ directory: temporary.path })
  let release!: () => void
  let entered!: () => void
  const disposing = new Promise<void>((resolve) => { entered = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  const off = registerDisposer(async (directory) => {
    if (directory !== temporary.path) return
    entered()
    await gate
  })
  let acknowledged = false
  const request = Promise.resolve(Server.Default().app.request("/global/config", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: `coda-config-${Date.now()}` }),
  })).then((response) => { acknowledged = true; return response })
  try {
    await disposing
    // Allow a detached HTTP response to settle while disposal remains blocked.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(acknowledged).toBe(false)
    release()
    expect((await request).status).toBe(200)
    expect(acknowledged).toBe(true)
  } finally {
    release()
    off()
    await disposeAllInstances()
  }
})
